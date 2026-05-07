# Email Setup Runbook — magic-link / transactional delivery

> Step-by-step setup for getting matflow's transactional email (magic-link sign-in,
> owner activation, payment-failed alerts, member invites, etc.) reliably into
> primary inboxes. Specific to **Vercel DNS** + **Resend** + production domain
> `matflow.studio`. ~75 minutes total time.

**Last updated:** 2026-05-07

---

## Why this matters

Until this runbook is complete, every "send sign-in link" / "owner activation" / "invite member" email is going from the unverified address `MatFlow <onboarding@resend.dev>` (Resend's sandbox sender) — Gmail/Outlook/iCloud auto-flag those as spam or silently drop them. Real owners and members can't sign in, even though the code works.

The fix is entirely DNS + dashboard config. No code changes are required for Tier 1; Tier 2 has one small route to deploy (already shipped).

---

## Tier 1 — make it work (45 min, no code)

### Step 1 — Create / sign in to Resend

1. Open https://resend.com → sign in (or create an account)
2. Confirm you're on the right account (free tier = 3,000 emails/month, fine to start)

### Step 2 — Generate an API key

1. Resend dashboard → **API Keys** (left sidebar)
2. Click **Create API Key**
3. Name: `matflow-prod`
4. Permission: **Full access** (sending + bouncing webhooks need this)
5. **Copy the key** (`re_...`) — it's only shown once. Paste into a password manager temporarily.

### Step 3 — Verify `matflow.studio` in Resend

1. Resend dashboard → **Domains** → **Add Domain**
2. Enter: `matflow.studio`
3. Region: **eu-west-2** (or wherever Neon is — keeps the email path short)
4. Resend will show **3 DNS records**:
   - `SPF` — TXT record on apex (`@` or `matflow.studio`)
   - `DKIM` — CNAME record (e.g., `resend._domainkey` → `resend._domainkey.amazonses.com`)
   - `DMARC` — TXT record on `_dmarc.matflow.studio` (Resend marks this optional but DO add it)
5. **Leave this dashboard tab open** — you'll come back to click "Verify"

### Step 4 — Add the DNS records in Vercel

Vercel DNS is where matflow.studio is managed.

1. https://vercel.com → matflow project → **Domains** (left sidebar)
2. Click on `matflow.studio` → **Manage DNS**
3. For **each** of the 3 records from Resend, click **Add** and fill in:

#### Record 1 — SPF (TXT)
- Type: `TXT`
- Name: `@` (or leave blank — Vercel uses apex)
- Value: paste exactly what Resend shows, e.g., `v=spf1 include:amazonses.com ~all`
- TTL: leave default (3600)

> **Watch out:** if you already have an SPF record (e.g., from another email service), you must MERGE — there can only be one SPF record per domain. Combine the `include:` parts. Example: `v=spf1 include:amazonses.com include:_spf.google.com ~all`. Don't add a second TXT record.

#### Record 2 — DKIM (CNAME)
- Type: `CNAME`
- Name: copy what Resend shows, e.g., `resend._domainkey`
- Value: copy what Resend shows, e.g., `resend._domainkey.amazonses.com`
- TTL: default

#### Record 3 — DMARC (TXT)
- Type: `TXT`
- Name: `_dmarc`
- Value (start permissive — switch to stricter later in Tier 2):
  ```
  v=DMARC1; p=none; rua=mailto:dmarc-reports@matflow.studio
  ```
- TTL: default

### Step 5 — Verify in Resend

1. Back in the Resend Domains dashboard, click **Verify** next to `matflow.studio`
2. Wait — usually 5–30 minutes. Vercel DNS is fast; you may see ✓ within 2 minutes.
3. If it stays "Pending" for >30 minutes:
   - Run `dig +short txt matflow.studio` from a terminal to confirm SPF is published
   - Run `dig +short cname resend._domainkey.matflow.studio` to confirm DKIM
   - If neither is visible, you added the records to the wrong scope — re-check Vercel

### Step 6 — Set Vercel env vars

1. Vercel → matflow project → **Settings** → **Environment Variables**
2. Find or create `RESEND_API_KEY`:
   - Value: the `re_...` key from Step 2
   - Scope: **Production** (and **Preview** if you want preview deploys to send too)
3. Find or create `RESEND_FROM`:
   - Value: `MatFlow <noreply@matflow.studio>` — exact format with brackets
   - Scope: same as above
4. Click **Save**

### Step 7 — Redeploy so env vars are live

Vercel doesn't pick up env-var changes without a redeploy.

Option A (cleanest): Vercel dashboard → matflow → Deployments → most recent → ⋯ menu → **Redeploy**
Option B: push an empty commit:
```
git commit --allow-empty -m "chore: pick up RESEND_FROM env var"
git push
```

### Step 8 — Smoke test

1. Open an incognito window → https://matflow.studio/login
2. Click "Use magic link" → enter a personal Gmail address you own
3. Check **primary inbox** within 30 seconds (NOT spam)
4. If the email is there: ✓ Tier 1 done. Verify the link works (clicking it should sign you in).
5. If it's in spam: SPF/DKIM might still be propagating — wait 30 min and retry, OR mark the message "Not spam" in Gmail to train the filter
6. If it never arrives: open Resend dashboard → **Logs** → most recent send → check the status column. Common errors:
   - `validation_error` — bad domain config; revisit Step 4
   - `bounced` — recipient address invalid (typo)
   - `complained` — recipient marked as spam in past

**Repeat the smoke test with**: 1 iCloud address, 1 Outlook/Hotmail address, 1 Yahoo address. Different ISPs have different filters; you want to see it land in primary on all four.

---

## Tier 2 — production-grade isolation (30 min, 1 code deploy already shipped)

### Step 9 — Add a dedicated transactional subdomain

This isolates auth-email reputation. If you ever send marketing emails (newsletter, promotions) from `matflow.studio` and one of them gets a complaint, it shouldn't tank your password-reset deliverability.

1. Resend → Domains → **Add Domain** → `mail.matflow.studio`
2. Get the new DNS records (separate set from the apex)
3. Add them in Vercel DNS under the `mail` subdomain:
   - SPF TXT on `mail` (or full name `mail.matflow.studio`)
   - DKIM CNAME on `resend._domainkey.mail`
4. Wait for ✓ in Resend
5. Update Vercel env var: `RESEND_FROM=MatFlow <noreply@mail.matflow.studio>`
6. Redeploy

> Once this is live you can leave the apex `matflow.studio` verified for backup but stop sending from it.

### Step 10 — Configure DMARC properly

Phase 1 (now): you set `p=none` in Step 4. Run for 1–2 weeks to collect reports.

Phase 2 (after observation): tighten to `p=quarantine`:
```
v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@matflow.studio
```
Phase 3 (once you're confident no other senders use the domain): `p=reject`.

You'll need a real `dmarc-reports@matflow.studio` mailbox or use a service like https://dmarcian.com (free for low volume).

### Step 11 — Set up Resend webhooks for bounce + complaint

The Resend webhook handler is already deployed at `/api/webhooks/resend` (commit will follow this runbook).

1. Resend → **Webhooks** → **New Endpoint**
2. URL: `https://matflow.studio/api/webhooks/resend`
3. Events to subscribe to (check all):
   - `email.delivered`
   - `email.bounced`
   - `email.complained`
   - `email.opened` (optional, for visibility)
4. Copy the **Signing Secret** (starts with `whsec_...`)
5. Add to Vercel env vars: `RESEND_WEBHOOK_SECRET=whsec_...`
6. Redeploy

Once live, every send/bounce/complaint will write to the `EmailLog` table. Bounced addresses will be short-circuited on future sends (no point emailing a hard-bouncing inbox).

---

## Tier 3 — UX polish (already deployed in code)

The following are all in the latest commit; you don't need to do anything for them:

- **"Resend in 60 seconds" button** on `/login` after submitting a magic-link request
- **Per-tenant Reply-To** so members replying to a magic-link land in the gym owner's inbox
- **`List-Unsubscribe` header** for better Gmail classification of transactional mail
- **Hidden preheader text** for cleaner inbox preview ("Tap the button to sign in. Link expires in 30 minutes.")

---

## Verification checklist (post-Tier-1)

Run all of these against production after Step 8:

- [ ] Magic-link email lands in Gmail primary inbox within 30 seconds
- [ ] Same for iCloud, Outlook, Yahoo
- [ ] Owner activation email lands in primary inbox (test by approving a fake `/apply` form submission via `/admin/applications`)
- [ ] Open the email, click "Show details" / "View original" — DKIM = pass, SPF = pass, DMARC = pass
- [ ] Resend dashboard → Logs shows every send with status = `delivered`
- [ ] After Tier 2 webhook is live: bounce a fake send to `nonexistent@example.invalid` → `EmailLog.status` becomes `bounced` within 60 seconds

---

## Troubleshooting

### "Email lands in spam every time"
- DKIM probably failing. Run `dig +short cname resend._domainkey.matflow.studio` — should resolve to `*.amazonses.com`. If empty, DKIM record is wrong.
- Or SPF has `~all` (soft fail) — that's OK initially but tighten to `-all` (hard fail) after a week of clean sends.

### "Resend dashboard shows `delivered` but nothing in inbox"
- Check spam thoroughly (Gmail "All Mail" view, iCloud Junk folder).
- Some corporate inboxes silently drop messages from new senders for the first week — wait a few days and retry.

### "DNS records added but Resend won't verify"
- Vercel sometimes caches stale DNS for a few minutes. Run `dig` from a terminal (or use https://dnschecker.org) — if records aren't visible globally, wait.
- DMARC TXT must be on `_dmarc.matflow.studio`, NOT on `matflow.studio` itself.
- DKIM CNAME name field is just `resend._domainkey` (Vercel auto-appends the domain), not the full path.

### "noetopalian@gmail.com specifically never receives"
- Check Gmail "All Mail" search for "matflow" — Gmail's spam filter is aggressive on first-time senders to your own gmail
- If found in spam, move to Inbox + click "Not spam" twice over different days to train the filter
- If using "Send only to delivered@resend.dev" mode (Resend dev mode), real addresses won't receive — confirm Resend domain is in production mode

### "Hit Resend free tier limit (3,000/mo)"
- Upgrade to $20/mo for 50k/month
- Or add Postmark as backup for owner activation/critical emails (separate issue, not in this runbook)

---

## What's NOT in this runbook

- Marketing email setup (newsletter, drip campaigns) — separate decision, separate subdomain (`news.matflow.studio`)
- Switching off Resend to a different provider — only worth doing if Resend reputation degrades
- Migrating to Stytch / Clerk / Auth0 (passwordless-as-a-service) — different architectural decision; matflow's stack is fine
