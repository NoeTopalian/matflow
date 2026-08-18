# User actions — things only Noe can do

**Compiled:** 2026-08-17 · **Sources:** `docs/EMAIL-SETUP-RUNBOOK.md`, `docs/TODO.md`, `docs/RUNBOOK.md`, `docs/runbooks/db-restore.md`, `.omc/specs/deep-dive-matflow-sellable-product.md`, `.omc/specs/audit-memory-storage-2026-08-16.md`, verified against the code on `main`.

Every item below is blocked on a credential, a DNS zone, a company registration or a dashboard login that no agent has. Nothing here is a code change. They are ordered by value, not by effort — **item 1 is worth more than items 2–7 combined**, because until it is done nobody outside your own inbox can be onboarded at all.

Total hands-on time for items 1–5: roughly **2.5 hours**, plus DNS propagation waiting. Items 6–7 are gated on your UK return.

| # | Item | Time | Blocking what |
|---|---|---|---|
| 1 | Email DNS + Resend domain verification | ~75 min + wait | Every gym owner activation, invite, magic link, dunning email |
| 2 | Production env vars in Vercel | ~30 min | Email webhooks, AI reports, retention cron, uploads, error reporting |
| 3 | Confirm `DATABASE_URL` is the Neon **pooled** host | ~5 min | Site stability from club #2–3 onward |
| 4 | GitHub Actions backup secrets (+ the blob-backup gap) | ~45 min | Your second backup layer; today there is one |
| 5 | Confirm the Stripe webhook is a **Connect** endpoint | ~10 min | The entire payment-event handler layer |
| 6 | MatFlow Ltd incorporation → ICO data-protection fee | ~2 h, on UK return | Invoicing anyone; ICO compliance |
| 7 | Decide `matflow.io` | ~20 min | Brand hygiene; nothing in code depends on it any more |

---

## 1. Email DNS for `matflow.studio` — SPF, DKIM, DMARC

**Highest-value item in the repo. Do this one first.**

### What is broken today

`matflow.studio` publishes an A record and nothing else — no SPF, no DKIM, no DMARC, no MX (externally verified against 8.8.8.8, `.omc/specs/deep-dive-matflow-sellable-product.md` Lane 3). The domain has never been verified in Resend, so `lib/email.ts:372` falls back to its sandbox sender:

```ts
const fromAddress = process.env.RESEND_FROM ?? "MatFlow <onboarding@resend.dev>";
```

Resend's sandbox sender only delivers to the Resend account owner's own inbox. Everything else is dropped or spam-filed.

### User-visible consequence

**A new gym owner can never be activated.** Approving an application at `/admin/applications` creates the tenant and mints a 30-minute magic link (`app/api/admin/applications/[id]/approve/route.ts:126-180`), and production deliberately withholds that link from the API response (`:193`) — the only delivery path is email. If email doesn't land, the owner has no way in and you have no way to hand them one.

Same failure kills: member invites, magic-link sign-in, forgot-password OTP, payment-failed dunning to member and owner, monthly report emails, application notifications, the white-glove CSV handoff.

### Exactly what to do

**Step 1 — Resend account and API key** (10 min)

1. https://resend.com → sign in.
2. **API Keys** → **Create API Key** → name `matflow-prod`, permission **Full access** (sending alone is not enough; the webhook config needs more).
3. Copy the `re_…` value — shown once. Park it in your password manager; it goes into Vercel at item 2.

**Step 2 — Add the domain in Resend** (5 min)

1. **Domains** → **Add Domain** → `matflow.studio`.
2. Region: **eu-west-2** (matches Neon and the Vercel `lhr1` region in `vercel.json`).
3. Resend now shows you the DNS records. **Leave this tab open.**

**Step 3 — Add the records in Vercel DNS** (15 min)

`matflow.studio` is managed in Vercel DNS: https://vercel.com → matflow project → **Domains** → `matflow.studio` → **Manage DNS**.

> **The DKIM value and the exact SPF/DKIM hostnames are generated per-domain by Resend. I cannot derive them and you must not guess them — copy each one verbatim from the Resend tab you left open.** The shapes below tell you what a correct paste looks like, not what to type.

| # | Type | Name | Value | Source |
|---|---|---|---|---|
| 1 | `TXT` | `@` (apex — Vercel may show this as blank) | shape: `v=spf1 include:amazonses.com ~all` | **Copy from Resend.** The `include:` host is Resend's to specify. |
| 2 | `CNAME` | shape: `resend._domainkey` | shape: `resend._domainkey.<something>.amazonses.com` | **Copy from Resend — both fields.** The selector and target are unique to your domain. |
| 3 | `TXT` | `_dmarc` | `v=DMARC1; p=none` | Safe to type as-is. See the DMARC note below before adding `rua=`. |

TTL: leave Vercel's default (3600) on all three.

**SPF merge rule:** there can only ever be **one** SPF TXT record on the apex. If Vercel already shows one, edit it and merge the `include:` tokens into the single record — e.g. `v=spf1 include:amazonses.com include:_spf.google.com ~all`. Adding a second SPF TXT record breaks both.

**Name-field rule:** Vercel auto-appends the domain. Enter `_dmarc`, **not** `_dmarc.matflow.studio`. Enter `resend._domainkey`, **not** the full path.

**DMARC `rua=` — read this before copying the old runbook.** `docs/EMAIL-SETUP-RUNBOOK.md:73` suggests `rua=mailto:dmarc-reports@matflow.studio`. That address does not exist — the domain has no MX and no mailbox — so the aggregate reports would bounce into nothing. And you cannot simply point `rua=` at your Gmail: RFC 7489 §7.1 requires the *receiving* domain to publish an authorisation record (`matflow.studio._report._dmarc.gmail.com`), which you cannot create on `gmail.com`, so most reporters will silently refuse to send. **Ship `v=DMARC1; p=none` with no `rua=` today.** Add reporting later, either by putting an MX + forwarding mailbox on `matflow.studio` or by using a DMARC service (dmarcian, Postmark DMARC) whose own domain publishes the authorisation record for you.

**MX:** not required to *send*. You need it only when you want to *receive* at `@matflow.studio` — a support address on the domain, the DMARC `rua` mailbox, or replies that miss the per-tenant Reply-To. Sensible to add (Google Workspace, Fastmail, or a free forwarder) but it is not what is blocking activation.

**Step 4 — Verify in Resend** (2–30 min, mostly waiting)

Back in the Resend Domains tab, click **Verify**. Vercel DNS is fast; ✓ often appears within two minutes.

**Step 5 — Set the From address in Vercel** (5 min)

Vercel → matflow → **Settings** → **Environment Variables** → scope **Production**:

- `RESEND_FROM` = `MatFlow <noreply@matflow.studio>` — exact format, angle brackets included. This is the only variable `lib/email.ts` reads for the sender.
- `RESEND_API_KEY` = the `re_…` key from Step 1.

> **Do not bother with `EMAIL_FROM`.** It appears in `.env.example:35` and in the deep-dive's Phase 0.1 list, but no code reads it. Setting it does nothing.

Then **Deployments → most recent → ⋯ → Redeploy**. Vercel does not pick up new env vars without one.

### How to verify it worked

```bash
dig +short txt matflow.studio          # expect the v=spf1 … line
dig +short txt _dmarc.matflow.studio   # expect v=DMARC1; p=none
dig +short cname resend._domainkey.matflow.studio   # expect a *.amazonses.com target
```

Then the real test:

1. Incognito → https://matflow.studio/login → magic link to a personal Gmail address.
2. It must land in **primary inbox** within 30 seconds. Open it → **Show original** → `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`, and `From:` on `matflow.studio`.
3. Repeat with one iCloud, one Outlook/Hotmail and one Yahoo address — the four filter estates behave differently and you need all four before onboarding a real gym.
4. Resend → **Logs** → every send shows `delivered`.
5. End-to-end proof: approve a throwaway `/apply` submission at `/admin/applications` and confirm the owner activation email arrives and the link signs you in.

Boot log check: `auth.ts:75-80` warns `[auth] RESEND_FROM is unset or still pointing at resend.dev` in the Vercel deploy log. After this item, that warning must be gone.

### Time

~75 minutes hands-on, plus up to 30 minutes DNS propagation and however long the four-inbox smoke test takes.

---

## 2. Production environment variables in Vercel

### What is broken today

Only one variable has ever been *proven* missing in production: the July re-verify probe got a `503 "Webhook secret not configured"` from the live Resend webhook, which proves `RESEND_WEBHOOK_SECRET` is unset (`docs/AUDIT-REVERIFY-2026-07.md:48`). The rest are **unverified** — nobody with the Vercel login has read the list. Treat this as an audit, not a blind set.

The hard-required set (`lib/env-guards.ts`) already must be present, because `instrumentation.ts` throws at boot without them and the site is up: `DATABASE_URL`, `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`, `MATFLOW_ADMIN_SECRET`. The list below is the *warn-but-continue* tier — each one fails silently.

### User-visible consequence, per variable

| Variable | Value shape / where it comes from | What breaks while unset |
|---|---|---|
| `RESEND_API_KEY` | `re_…` — Resend → API Keys (item 1, Step 1) | Boot-fatal per `env-guards.ts:27`. Site is up, so it is set — but confirm it is the `matflow-prod` key and not a stale one. |
| `RESEND_FROM` | `MatFlow <noreply@matflow.studio>` | Covered in item 1. Every email sends from the sandbox sender. |
| `RESEND_WEBHOOK_SECRET` | `whsec_…` — Resend → **Webhooks** → **New Endpoint** → URL `https://matflow.studio/api/webhooks/resend` → tick `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed` → save → open the endpoint → **Signing Secret** → Reveal | **Proven unset.** `EmailLog` rows never advance past `sent`; bounce short-circuiting never engages, so you keep emailing dead addresses. |
| `CRON_SECRET` | Generate fresh: `openssl rand -hex 32` | Both crons 503. `/api/cron/monthly-reports` (1st of month, 02:00 UTC) and — more importantly — `/api/cron/retention` (daily 03:30 UTC, `vercel.json:8-11`) which is the only code that makes your published retention policy true. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` — console.anthropic.com → API Keys | `/api/cron/monthly-reports` returns 503 before doing anything (`route.ts:29-33`). The AI causal monthly report never generates. |
| `BLOB_READ_WRITE_TOKEN` | `vercel_blob_rw_…` — Vercel → Storage → your Blob store → Tokens (Vercel usually injects this automatically once a store is linked to the project — check whether it is already there before creating one) | Profile-photo upload 503s (`app/api/upload/route.ts:210`); waiver signatures fall back to inline storage; CSV import upload 503s (`app/api/admin/import/upload/route.ts:57`); initiative attachments 503. |
| `SENTRY_DSN` | Sentry → project → Settings → Client Keys (DSN) | Nothing ships to Sentry; 5xx forwarding in `lib/api-error.ts:27` is gated on this var. Vercel logs only. Also set `NEXT_PUBLIC_SENTRY_DSN` for browser errors. |
| `MATFLOW_APPLICATIONS_TO` | Comma-separated inboxes, e.g. `noe@matflow.studio` | Falls back to `noetopalian@gmail.com` (`app/api/apply/route.ts:80`, `app/api/onboarding/csv-handoff/route.ts:101`). That works, so it is cosmetic — the "defaults to `hello@matflow.io`" claim in `docs/MATFLOW-PIPELINES.md:72` and `functions/apply-form.md:15` is **stale**; the code was already fixed. |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID. Authorised redirect URI: `https://matflow.studio/api/drive/callback` | Google Drive integration 503s (`app/api/drive/connect/route.ts:12-14`). **Skip this unless you actually intend to sell Drive backup** — it is optional and adds a Google verification chore. If you do set it, also set `ENABLE_GOOGLE_OAUTH="true"` and `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH="true"`, which is what `auth.ts:36` and the login button gate on. |

> **Do not reuse the `CRON_SECRET` value printed in `docs/TODO.md:17`.** It has been sitting in a git-tracked file. Generate a new one.

> **Use the dashboard, not the CLI.** `vercel env add` on Windows has silently stored empty strings before and corrupted `DATABASE_URL` once (`docs/TODO.md:13`).

While you are in there, confirm two things are **absent** from production: `E2E_BYPASS_TOKEN` and `DEMO_MODE`. The first is a latent password-bypass primitive (`auth.ts:218-224`); the second throws at boot but should not be there at all.

### How to verify it worked

- Vercel → Deployments → the redeploy's build/runtime log: no `[env-guards] … is unset` warnings remain for anything you set.
- Resend webhook: `POST https://matflow.studio/api/webhooks/resend` with no signature → expect `400`, **not** `503`. A 503 means the secret is still missing.
- Retention cron: Vercel → Settings → Cron Jobs → `/api/cron/retention` → run it manually → expect 200, not 503.
- Uploads: change a member's profile photo in the dashboard — it should save, not error.
- Sentry: hit any route that 500s (or use Sentry's test-error button) and confirm the event appears.

### Time

~30 minutes, plus one redeploy. Longer if you set up Google OAuth.

---

## 3. Confirm production `DATABASE_URL` uses the Neon **pooled** host

### What is broken today

Unknown, and that is the problem. The repo's local `.env` points at the **non-pooler** host. Nobody has read the production value.

`lib/prisma.ts` was fixed in the 2026-08-16 audit follow-up and now warns correctly — it checks the *hostname* for `-pooler` (`lib/prisma.ts:43-56`) rather than the old `pgbouncer=true` query param, which is inert under `@prisma/adapter-pg`. The pg pool `max` is now pinned at 5 per instance (`:64`).

### User-visible consequence

With `max: 5` per instance against Neon's ~112 direct connections, roughly 22 concurrent warm instances exhaust the ceiling on a direct host. Symptom: random 500s during traffic spikes, all "connection terminated unexpectedly", and routes timing out at 60 s. A kiosk rush at a busy club plus dashboard traffic reaches that from club #2–3 onward. Note the old advice in `docs/RUNBOOK.md:122,166,270` to append `?pgbouncer=true&connection_limit=1` is **stale** — those params do nothing under this driver. Only the hostname matters.

### Exactly what to do

1. Vercel → matflow → **Settings** → **Environment Variables** → reveal `DATABASE_URL` (Production scope).
2. Read the hostname. A pooled Neon host looks like `ep-<name>-123456-pooler.eu-west-2.aws.neon.tech` — the literal string `-pooler` sits immediately before the region.
3. If `-pooler` is **absent**: Neon console → your project → **Connect** → toggle **Pooled connection** → copy that string → paste it over `DATABASE_URL` in Vercel → Save → **Redeploy**.
4. Leave `sslmode=require` on. You may drop `?pgbouncer=true&connection_limit=1` if present — harmless either way, but it is noise.
5. Separately, keep a **direct** (non-pooler) URL to hand — item 4 needs it as `DATABASE_URL_DIRECT`, because `pg_dump` cannot run through PgBouncer.

### How to verify it worked

- Vercel runtime logs after redeploy: the `[prisma] DATABASE_URL host "…" is not a Neon pooled endpoint` warning must be **absent**. Its presence is a definitive fail.
- `/api/health` returns 200 with a healthy DB status.
- Neon console → **Monitoring** → connection count stays flat rather than climbing with traffic.

### Time

5 minutes if it is already pooled; 15 minutes including a redeploy if it is not.

---

## 4. GitHub Actions secrets for the weekly S3 backup — and the blob-backup gap

### What is broken today

`.github/workflows/db-backup.yml` runs Sundays 03:00 UTC. Its `Validate secrets` step exits 1 whenever any required secret is missing, so **every scheduled run has failed and no S3 dump has ever been taken** — confirmed by `gh run list` for 12, 19, 26 July and 2, 9 August (`.omc/specs/audit-memory-storage-2026-08-16.md` P1-1). That failure is the intended fail-loud signal. **Do not silence it by disabling the schedule.**

Worse, and not fixable with secrets: **Vercel Blob has no backup at all.** Signed waiver signature PNGs, member photos (children's included) and import CSVs live there with no second copy anywhere. If a blob is deleted or the store is lost, the waiver evidence for an injury claim is gone permanently.

### User-visible consequence

Your only working database backup is Neon point-in-time recovery, and its window is plan-dependent — 7 days on Free. Any corruption or bad migration discovered more than a week later is unrecoverable. `docs/runbooks/db-restore.md` Option B (restore from S3) currently cannot be executed, because there is nothing in S3.

### Exactly what to do

**Part A — the five repo secrets** (~30 min, most of it AWS)

1. AWS console → **S3** → **Create bucket**: name `matflow-db-backups`, region `eu-west-2` (keeps it in the same jurisdiction as Neon and the privacy policy's stated processing location). Block all public access: **on**. Versioning: on. Add a **Lifecycle rule** expiring objects after 30 days, to match what `docs/runbooks/db-restore.md` already claims.
2. AWS console → **IAM** → **Users** → create user `matflow-backup`, programmatic access only, with an inline policy granting `s3:PutObject` and `s3:ListBucket` on `arn:aws:s3:::matflow-db-backups/*` and the bucket itself. Nothing more.
3. Copy the access key ID and secret access key.
4. Neon console → **Connect** → copy the **direct** (non-pooled) connection string — the hostname *without* `-pooler`.
5. GitHub → https://github.com/NoeTopalian/matflow → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**, five times. The names are checked literally by the workflow (`db-backup.yml:44`) — an exact match is required:

| Secret name | Value |
|---|---|
| `DATABASE_URL_DIRECT` | Neon **non-pooled** URL (pg_dump cannot use PgBouncer) |
| `AWS_ACCESS_KEY_ID` | from step 3 |
| `AWS_SECRET_ACCESS_KEY` | from step 3 |
| `BACKUP_S3_BUCKET` | `matflow-db-backups` |
| `BACKUP_S3_REGION` | `eu-west-2` |

> `docs/RUNBOOK.md:92` says "4 secrets" by counting the AWS pair as one. The workflow validates **five distinct names**. All five must exist.

**Part B — the blob gap** (~10 min, decision not configuration)

There is no dashboard switch for this; Vercel Blob has no backup product. Two honest options, pick one and write down which:

- **Accept the risk explicitly** for now, and record in `docs/runbooks/db-restore.md` that blob loss is unrecoverable. Defensible while you have one demo club and no live injury claims. Indefensible once a gym has signed waivers in there.
- **Fund a mirror**: a second scheduled GitHub Action that lists the blob store and copies objects to the same S3 bucket under a `blobs/` prefix. That is code someone has to write — flag it to me and it goes on the backlog; it is not a user action.

While you are in the Neon console, **check which plan you are on and what the PITR window actually is** (Free 7 days / Launch 30 / Scale 365). Until Part A is green that window is your entire recovery capability, and `docs/runbooks/db-restore.md` tells you to size incident response to it.

### How to verify it worked

```bash
gh workflow run db-backup.yml                      # trigger manually, don't wait for Sunday
gh run list --workflow=db-backup.yml --limit 3     # expect the newest run: success
aws s3 ls s3://matflow-db-backups/ --recursive     # expect <stamp>/matflow-db.dump, non-zero size
```

The run's summary page should read `✅ All backup secrets present`. The dump for a 12 MB database will be small — that is correct, not a failure.

Then schedule a **restore drill once per quarter** (`docs/RUNBOOK.md:112`): pull the dump, `pg_restore` it into a fresh Neon branch, point a Vercel preview at it, confirm the data is there. Log the result in `docs/RESTORE-DRILL.md`. A backup you have never restored is a hypothesis.

### Time

~45 minutes including the AWS bucket and IAM user. 10 of those are the GitHub secrets themselves.

---

## 5. Confirm the Stripe webhook endpoint is a **Connect** endpoint

### What is broken today

Unverified, and the failure mode is silent. Every member charge in MatFlow is a **direct charge on the gym's connected account** — `{ stripeAccount }` is passed at every call site. That means every relevant event originates on a *connected* account, and arrives carrying `event.account`.

The handler at `app/api/stripe/webhook/route.ts` resolves the tenant from that field. If the endpoint were registered in Stripe as a plain **account** endpoint ("events on your account") rather than a **Connect** endpoint ("events on connected accounts"), the platform-scoped events it receives would carry no `event.account`, the tenant lookup would fail, and the entire handler layer would be dead code — while Stripe's dashboard cheerfully shows the endpoint as configured.

### User-visible consequence

Failed payments never mark a member `overdue` and never email the member or the owner. Successful payments never reconcile in the ledger. Refunds issued from the Stripe dashboard never reflect in MatFlow. **Chargebacks never appear at all** — the gym misses the evidence deadline and loses the dispute by default. Every one of these looks like "MatFlow's payments are broken" to the gym owner, with no error anywhere.

### Exactly what to do

1. https://dashboard.stripe.com → confirm you are in **live** mode (not test) → **Developers** → **Webhooks**.
2. Find the endpoint pointing at `https://matflow.studio/api/stripe/webhook`. If there is also a stale one on `https://matflow-nine.vercel.app/…` from the old `docs/TODO.md` instructions, delete it — production is `matflow.studio` per `NEXTAUTH_URL` and `docs/RUNBOOK.md:12`.
3. Check the endpoint's **type**. Stripe labels this at creation as *"Events on your account"* vs *"Events on connected accounts"*. It must be **connected accounts**. If it is not, you cannot convert it — **create a new endpoint** with the Connect option selected, at the same URL, then delete the old one.
4. Tick the event types. The handler accepts exactly these sixteen (`app/api/stripe/webhook/route.ts:32-49`) and ignores everything else with a harmless 200:

   ```
   customer.subscription.deleted    customer.subscription.updated
   invoice.payment_failed           invoice.payment_succeeded
   invoice.voided                   checkout.session.completed
   payment_intent.processing        payment_intent.succeeded
   mandate.updated                  charge.refunded
   customer.deleted                 payment_method.detached
   charge.dispute.created           charge.dispute.updated
   charge.dispute.closed            account.updated
   ```

   Ticking extra types costs nothing. Missing one costs you that feature entirely.
5. Reveal the endpoint's **Signing secret** (`whsec_…`) and confirm it matches `STRIPE_WEBHOOK_SECRET` in Vercel. If you created a new endpoint at step 3, it has a **new** secret — paste it into Vercel and redeploy, or every event will 400 on signature verification.
6. Same screen → **Notifications** → enable email alerts on repeated delivery failures, so this never goes quiet again.

### How to verify it worked

- **Unauthenticated probe:** `POST https://matflow.studio/api/stripe/webhook` with no signature header → expect `400 {"error":"Missing signature"}`. A 404 or 307 means the route is not publicly reachable and needs the proxy allowlist checked (`proxy.ts` `PUBLIC_PREFIXES`).
- **The discriminating check:** sign in as an owner of a Stripe-connected tenant and GET `/api/stripe/connect/health` (pure read, owner-only). Confirm `ready: true`, `env.STRIPE_SECRET_KEY.mode === "live"`, `env.STRIPE_WEBHOOK_SECRET.present === true`, `platformAccount.ok === true`. Then look at `thisTenant.stripeAccountStatus.refreshedAt` — that timestamp is written by the `account.updated` handler, so **a recent value is positive proof that Connect events are arriving and being processed**. A stale or null one is your answer.
- Stripe dashboard → the endpoint → **Webhook attempts** tab: recent deliveries returning 200. 400s mean a signing-secret mismatch; 401/307 mean a routing problem.

### Time

10 minutes to inspect. Add 10 more if you have to recreate the endpoint and rotate the secret through Vercel.

---

## 6. Incorporate MatFlow Ltd, then register with the ICO

### What is broken today

The company does not exist. The decision locked on 2026-08-14 was: **sell as a UK sole trader for now, incorporate MatFlow Ltd on your UK return (~27 Aug)**, and strip the "Ltd" claim from live pages in the meantime.

The code side is **already done** — `grep` over `app/`, `lib/` and `components/` finds no "MatFlow Ltd" and no `matflow.io` contact addresses. The legal pages currently name plain "MatFlow" as the party (`app/legal/privacy/page.tsx:10,18-19`). So nothing is misrepresented today; what remains is the registration itself.

### User-visible consequence

You cannot invoice a gym as a company that does not exist. The 2026-08-14 plan is explicit: **do not send the first Stripe Payment Link until the entity exists.** And MatFlow is a data *processor* for member data and a data *controller* for owner/staff accounts — controllers who process personal data by automated means must pay the ICO data-protection fee. Operating without it is a standalone offence, independent of anything else in the privacy policy.

### Exactly what to do

**Step 1 — Incorporate** (~1 hour, from the UK)

1. https://www.gov.uk/limited-company-formation → register online with Companies House. £50 online at the time the deep-dive was written (2026-08-14) — **[NEEDS VERIFICATION: confirm the current fee on the GOV.UK page before paying; Companies House has repriced recently and this figure is a month old].**
2. You will need: company name (check availability), a registered office address, at least one director, share allocation, and SIC code — `62012` (business and domestic software development) or `62020` (IT consultancy) fits MatFlow.
3. Registration is usually approved within 24 hours online.

**Step 2 — ICO data-protection fee** (~15 min, after the company number exists)

1. https://ico.org.uk/for-organisations/data-protection-fee/ → **Pay the fee**.
2. Tier 1 (micro: under 10 staff, under £632k turnover) is **£52/year by direct debit, £40 with the £5 direct-debit discount** — **[NEEDS VERIFICATION: the ~£52 figure comes from the 2026-08-14 deep-dive; confirm on the ICO page before paying]**.
3. Register with the new company number, not as a sole trader, so the entity on the certificate matches the entity on your invoices and your privacy policy.

**Step 3 — Flip the code back** (not your job, but tell me)

Once the company number exists, the legal pages should name "MatFlow Ltd", carry the company number and registered office, and the draft banner at `app/legal/layout.tsx:20` comes off. That is a code change — hand me the company number and registered address and it is a fifteen-minute edit.

**Step 4 — the adjacent commercial chores** (same trip)

- Business bank account (needs the company number).
- Professional indemnity + cyber insurance quote — roughly £15–30/month per the deep-dive.
- An Article 28 DPA template to sign alongside gym #1. Terms and privacy already embed the processor commitments; a standalone DPA is what a gym's own adviser will ask for. **Have it reviewed — none of this is legal advice.**
- VAT: nothing to do until £90k turnover.

### How to verify it worked

- Companies House public register shows MatFlow Ltd with a company number and your registered office.
- The ICO register at https://ico.org.uk/ESDWebPages/Search returns MatFlow Ltd with a current registration and expiry date.
- Your first Stripe Payment Link invoice carries the company number.

### Time

~1 hour for incorporation, ~15 minutes for the ICO, both gated on being back in the UK.

---

## 7. Decide what happens to `matflow.io`

### What is broken today

Nothing in the running product. `matflow.io` is recorded as lapsed or uncertain, parked on GoDaddy, with no MX — you do not safely own it. The repo has already been cleaned: no `.tsx` under `app/` references it, and the one surviving mention is a code comment explaining why the default was changed away from it (`app/api/apply/route.ts:78`).

So this is no longer a blocker. It is an open exposure with a short shelf life.

### User-visible consequence

If someone else registers `matflow.io` and stands up a lookalike, anyone who remembers the old address — including recipients of any early email or document that carried a `@matflow.io` contact — lands on their page. Historically the legal and privacy pages published contact addresses on that domain, which is exactly the hijack risk the deep-dive flagged. Low probability, unbounded downside, cheap to close.

### Exactly what to do

1. Log into GoDaddy. Establish which of three states you are in: (a) you own it and it is on auto-renew, (b) you own it and it is expiring, or (c) it has already dropped and is merely *parked* by GoDaddy's landing page, which looks identical to ownership from the outside.
2. Check independently: `whois matflow.io` — read the registrant and the expiry date. GoDaddy's own dashboard will not tell you if it has left your account.
3. **If you own it:** turn auto-renew **on**, add it as a redirect to `https://matflow.studio` (GoDaddy → Domain → Forwarding → permanent 301). Do not host anything on it and do not put an MX on it.
4. **If you do not own it:** decide once and record the decision. Re-registering a `.io` is roughly £30–40/year for pure brand defence. Given `matflow.studio` is the canonical domain everywhere in code, config and the privacy policy, letting it go is a legitimate choice — just make it deliberately rather than by drift.
5. Either way, confirm `matflow.studio` itself is on auto-renew with a card that has not expired, and that its SSL renews via Vercel (it does automatically). Losing the *live* domain is the version of this problem that actually takes the product down.

### How to verify it worked

- `whois matflow.io` shows you as registrant with an expiry more than a year out, or you have written down that you are not renewing it.
- Browsing to `http://matflow.io` either 301s to `matflow.studio` or is confirmed as not yours.
- `whois matflow.studio` shows an expiry more than a year out with auto-renew on.

### Time

20 minutes, including the decision.

---

## What is *not* on this list, and why

Kept out deliberately so this file stays actionable:

- **Anything an agent can do.** Bulk-invite for imported members, dispute alerting, subscription-aware refunds, the erasure-completeness work, the missing indexes — all code, all on the backlog, none blocked on you.
- **`EMAIL_FROM`.** Documented in `.env.example` but read by no code. Setting it achieves nothing.
- **`?pgbouncer=true&connection_limit=1`.** Inert under `@prisma/adapter-pg`. Several older docs still tell you to add it; ignore them and check the hostname instead (item 3).
- **`MATFLOW_APPLICATIONS_TO` defaulting to `hello@matflow.io`.** Repeated in `docs/MATFLOW-PIPELINES.md` and `functions/apply-form.md`; the code already defaults to `noetopalian@gmail.com`. Those docs are stale.
- **`TESTING_MODE` defeating 2FA in production.** `docs/RUNBOOK.md:164` says it does. `lib/testing-mode.ts:14` hard-guards on `VERCEL_ENV === "production"`, so it does not. Still worth keeping the var out of production env, but it is not the open door the runbook describes.
