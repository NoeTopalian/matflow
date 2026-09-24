# Incident runbooks (execution prompt §9)

Each runbook: detect → contain → escalate → recover → verify. Support hours today: **one person (Noe), UK working hours, best effort**. There is no 24/7 cover and none is claimed. Communication drafts are at the end; nothing is sent without Noe's say-so.

## 1. Payment discrepancy (member charged twice, not charged, or wrong amount)
- **Detect:** member or owner report; the `stripe-reconcile` cron report (once `CRON_SECRET` is set); Payments page against the Stripe dashboard.
- **Contain:** do not retry or refund blindly. Read the Stripe objects first (invoice, payment intent, charge) on the club's connected account; read the `Payment` row and the `StripeEvent` receipts for those ids.
- **Escalate:** a duplicate charge or wrong amount is P1; tell the club owner within the hour with facts, not a guess.
- **Recover:** refund through the app's refund route (audited, apportions pack credits) or the Stripe dashboard if the app cannot see the charge; then correct the `Payment` row through the audited path. Never edit history by hand.
- **Verify:** the Stripe balance transaction shows the refund; the member reads the right `paymentStatus`; the audit log carries actor and reason.

## 2. Suspected tenant exposure (one club sees another's data)
- **Detect:** a report, a Sentry event with a foreign `tenantId`, or a failed cross-tenant cell in the assess suite.
- **Contain:** if confirmed on production, close the route (guard deploy) or promote the last known-good deployment. Do not wait for root cause.
- **Escalate:** P0. Record what was visible, to whom, for how long. UK GDPR breach assessment (72 hours) may apply; Noe decides with qualified advice.
- **Recover:** fix with a red-on-revert test; run `scripts/test-rls-enforced.mjs` and the isolation lanes (lb-2, the two-club loop) before redeploying.
- **Verify:** the exact leaking request now answers 404; both clubs' data unchanged.

## 3. Job backlog (crons not running, instances not generated, retention not sweeping)
- **Detect:** Vercel cron logs show 401 or 503; the timetable shows no future instances; retention dry-run counts keep growing.
- **Contain:** confirm `CRON_SECRET` is set and matches; call the cron with `?dryRun=1` where supported to see counts without effects.
- **Escalate:** P2, or P1 when check-in is blocked by missing instances.
- **Recover:** run the cron by hand with the secret; every cron is idempotent and batched by tenant.
- **Verify:** the next scheduled run answers 200; the instance horizon is restored.

## 4. Failed deploy or bad release
- **Detect:** Vercel build fails, `/api/health` is not `db:ok`, or the post-deploy smoke fails.
- **Contain:** Vercel → promote the previous deployment (instant). Migrations are additive by convention, so the previous app works on the migrated schema; a non-additive migration is itself the finding.
- **Escalate:** P1 if any club cannot check in or take money.
- **Recover:** fix forward on a branch; full gates; redeploy.
- **Verify:** the smoke set (health, login page, a club's short URL, dashboard redirect, leaderboard token 200 and a bad token 404).

## 5. Data restoration
- **Detect:** a data-loss report, or a bad migration or script on production.
- **Contain:** stop writes to the affected area (suspend the tenant if necessary); take a Neon branch of production immediately as a forensic snapshot.
- **Escalate:** P0 or P1 by scope.
- **Recover:** Neon point-in-time restore into a NEW branch, never in place; verify rows, schema, that referenced blobs still exist, and permissions; then either promote the branch or copy the affected tenant's rows across with a script reviewed by a second person. Stripe is ahead of any restore: reconcile subscriptions and payments from Stripe before reopening.
- **Verify:** the owner confirms roster and money match; sweep counts; an audit row for the restoration.
- **Untested:** no restore drill has been run. Register row R1-7 is BLOCKED until Noe grants Neon restore access; a corrupt-backup or missing-blob scenario is likewise untested.

## Communication drafts (not sent)
- *Club owner, discrepancy:* "We found a payment for <member> that was recorded twice on <date>. The second charge has been refunded; it appears in Stripe as <ref>. Nothing else was affected. Reference: <id>."
- *Club owner, outage:* "MatFlow was unavailable from <time> to <time>. Check-ins during that window were not recorded; please add them from the register. No payments were taken twice."
