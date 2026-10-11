# Stripe and cron credential containment — prepared action (11 Oct 2026, UK)

Prepared separately from the payment-defect repair. Nothing here has been executed. No secret values appear in this file.

## Correction of the prefix-match claim

The four-variable fingerprint run at 17:15 UK reported `STRIPE_SECRET_KEY: MATCH leaked stripe-key-prefix`. Earlier messages in the session described the deployed Stripe key as "still usable by anyone who has it". That overstated the exposure. The facts, from `docs/security/CONTAINMENT-CHECKLIST.md` §2 row C4 and `scripts/readiness/ops-credential-fingerprint.mjs:30`:

- What leaked on 7 May 2026 (commit `fa3c460`, public history) is the **first 25 characters** of the restricted live key, not the key.
- A prefix is **not a usable credential**: it does not authenticate on its own. The checklist records C4 as "Usable? No … Not exposed. Roll as hygiene with the release".
- The MATCH therefore establishes **identity**, not exposure: the key deployed today (Vercel Production and Preview, last updated 7 May 2026 12:41 UTC) and the key in the local `.env` are the same key whose prefix is public. It does not establish that anyone holds the full key.
- `CRON_SECRET` is different: the **full 64-hex value** leaked (row C3). It is set in **no** Vercel environment (verified 11 Oct 15:30 UK, names and ages only), so the serving build answers 503 on every cron route and the value authenticates nothing reachable. The only copy is the local `.env`.

## Provider identity and usage evidence to gather before acting (Noe, Stripe dashboard, live mode; read-only)

1. Developers → API keys: the restricted key's **name**, **created** date, **last used** date and its permissions. Confirm its first characters match the start of the local `STRIPE_SECRET_KEY` (compare the first 8 characters on screen; do not copy the key anywhere).
2. Developers → Logs, filtered to that key, last 30 days: request counts and source IPs. Vercel's `lhr1` region egress is expected; anything else is a finding.
3. Connect → Settings: whether any connected account exists in live mode (expected: none).
4. Record the three answers (dates and counts only) in `ITERATION-2-REPORT.md` §9.

## The action (hygiene roll; needs Noe; no code change; no deploy of new code)

Preconditions: nothing in production depends on the key today (member payments through the app are deferred; no live connected accounts; `EMAIL_DELIVERY=off`). So the old key can expire **immediately** rather than after an overlap.

1. Stripe → Developers → API keys → the restricted key → **Roll key** → expiry **Now**. Copy the new key once.
2. Terminal, repo folder (the value is pasted at the prompt and never echoed):
   ```
   npx vercel env rm STRIPE_SECRET_KEY production
   npx vercel env rm STRIPE_SECRET_KEY preview
   npx vercel env add STRIPE_SECRET_KEY production --sensitive
   ```
3. Redeploy the serving production deployment (same commit) so the running build reads the new value:
   ```
   npx vercel redeploy <current production deployment URL>
   ```
   (The coordinator's own redeploys are denied under D-12; Noe runs this.)
4. Local `.env`: replace the `STRIPE_SECRET_KEY` value; **delete** the `CRON_SECRET=` line (do not replace it; production has none and must not get one until the retention gate decision).
5. Verify (coordinator, read-only): `vercel env ls production` shows `STRIPE_SECRET_KEY` minutes old and no Preview copy; `vercel ls --prod` shows a deployment newer than the variable; `/api/health` 200; local fingerprint run reports no match on all four variables (exit 0).
6. Record in `ITERATION-2-REPORT.md` §9 and `FINDINGS.md` SF-14: Stripe rolled (date, old key expired), CRON removed locally; SF-14 then closes for all four values subject to the provider evidence in the previous section.

## Scope limits

- Preview will have no Stripe key after step 2. Preview deploys that need Stripe must use a **test-mode** key set separately (containment checklist step 8); not part of this action.
- Rolling the key does not change `STRIPE_CLIENT_ID`, the webhook secret or any connected account; none of those leaked.
- The restricted key's **scopes** (OAuth token exchange, accounts read, connected-account writes) are unknown; the rolled key inherits the same permissions. Verifying them is a separate owner check via the health endpoint on production, after the hub release.
