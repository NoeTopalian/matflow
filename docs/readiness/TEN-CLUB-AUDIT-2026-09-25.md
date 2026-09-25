# Ten-club readiness, integration and migration audit — 2026-09-25

Executed against the "ten-club readiness, integration and migration execution prompt" (Noe, 25 Sep 13:58 Italy). Every claim below names its artefact, its environment and its time. "Test" means the Neon test branch `ep-hidden-salad` driven from this laptop; "live site" means https://matflow.studio read-only. Nothing was pushed, merged, deployed, migrated in production, cut over, cancelled on TeamUp or Stripe, charged, or mailed to a real person.

## 1. State, candidate and divergence

| Item | Value |
|---|---|
| Local HEAD at start | `07ee92e` (main), 23 commits ahead of `origin/main`, tree clean bar `PROJECT_STATUS_REPORT.md` (deliberately uncommitted) and `.omc/` session state |
| Candidate under audit | `07ee92e` + this audit's commits (listed in §12); every lane and script below names the SHA it ran on |
| `origin/main` = deployed revision | `ac2fcb8` (23 Sep 14:19 +0100) — the live site's last deploy; confirmed live on 23 Sep by an owner-session read of the reports funnel |
| Live site probe (read-only, 25 Sep 12:34 UTC) | `/api/health` 200 `db: ok` in 3.1 s (cold); `/login` 200; unauthenticated `/api/locations` and `/api/members/x/hold` answer 401 — the auth gate runs before routing, so this says nothing about whether those routes exist there (they do not: both are in the unpushed commits) |
| Migrations on the test branch | applied through `20260925090000_tier_location` (host-guarded `migrate deploy`, 25 Sep 09:40 Italy) |
| Migrations NOT on production | four: `20260923220000_billing_cycle_weekly`, `20260924120000_member_hold_until`, `20260925000000_locations`, `20260925090000_tier_location` (§10) |
| Environments | `.env` = production Neon (never used by any script here); `.env.test` = test branch + `sk_test_` + `TESTING_MODE`; dev server :3847 (Turbopack, `.env.test`), production build :3948 (`next build` + `next start`, `.env.test`, mail key deliberately invalid) |

**What the live site is missing** (everything in `861cd1a` … `07ee92e` plus this audit): TeamUp import preset, replace-at-period-end migration, holds, tier counts, locations and venue eligibility, ownership transfer, reports cache, settings registry and impact dialogs, desk-coverage and child-move fixes, memberships honesty, and the dispute double-email fix from this audit. The live site also has no `CRON_SECRET`, no verified sender domain, and the reconcile cron is not scheduled anywhere.

## 2. Claim ledger — what was claimed this week, what the evidence actually shows

| Claim | Evidence artefact | Scope | Gap |
|---|---|---|---|
| "Every door works" | `tests/e2e/campaign/assess/*` 24 files (579/0 twice on `67c17b2`, 22 Sep); lanes re-run since on later SHAs individually (lb-1 29/0, lb-2 30/0, ld-1 25/0, ld-2 26/0, le-1 44/0, le-3 24/0, lc-3 10/0+3 skips, lf-3 34/0, lh-1 10/0, lh-2 7/0, lh-3 5/0) | test branch, dev server, seeded club + throwaways | No single SHA has had all 24 files run since `67c17b2`; the candidate has had 12 lanes on it, one file at a time (§12 says which) |
| Stripe lifecycle proven | `scripts/stripe-lifecycle-e2e.mjs` PASS 24 Sep 22:20 UTC (`docs/readiness/STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md`); `scripts/stripe-dispute-closed-e2e.mjs` PASS 25 Sep 15:10 UTC (this audit) | Stripe test mode, Custom connected accounts, test clocks, real signed events replayed into the local webhook | Bacs mandate flow NOT RUN; deauthorisation unit-only (not producible on a Custom test account) |
| Migration engine proven | `scripts/stripe-migration-e2e.mjs` PASS 24 Sep 00:59 (adopt+create) and 21:23 UTC (replace) | Stripe test mode | Real TeamUp export never committed anywhere; §8 rehearses a catalogue-shaped copy |
| Pilot capacity | `docs/readiness/CAPACITY-PILOT-2026-09-24.md` (2,683 req, 0 errors, one 500-person club) | production build on this laptop → remote Neon (≈0.5 s floor) | Not production-representative; §5 adds ten clubs at reduced concurrency, same caveat |
| RLS is the backstop | `scripts/test-rls-enforced.mjs` 9/9 on the test branch under the restricted role; 41/47 tables forced | test branch | The app's runtime role on the test branch BYPASSES RLS (`neondb_owner`); production role unknown — Noe's query (ADR-001 D8) |
| Email works | `lib/email.ts` + `EmailLog` + Resend webhook (§9) | code, unit | No verified production sender; no send observed to deliver; no outbox/retry |
| Crons run | four routes exist, three scheduled in `vercel.json` | code | `CRON_SECRET` unset in production: every cron has answered 503 for the life of the project; `stripe-reconcile` has no schedule at all |
| Isolation holds | lb-2, two-club loop, hostile-owner E2E (23 Sep), §6 of this audit (24/24 hostile probes across three of the ten clubs) | test branch | production runtime role (above) |

## 3. Connection register — every door on the critical paths, with its proof

Routes: `docs/readiness/PERMISSION-MATRIX.md` (182 API routes, generated 24 Sep; 27 unguarded = public/token/signature doors, each named). Screen ⇄ gate ⇄ API agreement: `lb-2-staff-and-nav.spec.ts` (30/0 on `efb3d48`) walks every dashboard nav item as every staff role and asserts the page gate and the API gate agree. Static connection audit of every fetch() call site: `docs/audit/CONNECTION-AUDIT-2026-08-22.md` (8 BROKEN then; status now below).

| Aug-22 BROKEN | Status on the candidate |
|---|---|
| #1 emergency-contact wall blocks waiver signing | fixed (waiver lanes lc-2 green; fields editable on the profile) |
| #2 import preview/commit 403 on private blobs | fixed (`get()` credentialled reader; lc-3 J24 runs with a Blob token) |
| #3 member with 2FA locked out of password login | fixed (member TOTP verify route; lf-1 cells) |
| #4 kiosk waiver gate self-destructs after 10 s | fixed (ld-2) |
| #5 recovery codes redeemable nowhere | fixed (recover routes wired; la-2) |
| #6 push delivery never worked | still not live; the app does not claim it (CLAUDE.md) |
| #7 Add Staff blank-password lie | fixed (lb-2 J-staff cells) |
| #8 every chargeback emails each owner twice | **was still live** — found again by §7, fixed in this audit (`app/api/stripe/webhook/route.ts`, unit pins one send per owner) |

Ten-club door matrix (§5) is the journey-level proof for the onboarding, settings, memberships, venues, classes, members, cash, kiosk, check-in and reports doors on ten fresh clubs.

## 4. Screen-transition and resilience matrix

Lane `lh-4-clublife-transitions.spec.ts` (L13 in `CLUBLIFE-CATALOGUE.md`), driven on the dev server against the seeded club:

| Cell | Transition | Result (25 Sep 15:50 UTC, run 4 of the lane) |
|---|---|---|
| C13.01 | A double-clicked cash payment (same requestId, two concurrent submits) | one Payment row, the due date moved once — PASS |
| C13.02 | A double-clicked hold (two concurrent submits) | **found a race and fixed it**: both clicks read "not on hold", both wrote, two audit rows. The hold write is now a compare-and-set on `paymentStatus`; the losing click is told the membership is already on hold, one audit row (F-TC-9) — PASS after the fix |
| C13.03 | Two staff editing one member: the second save with a stale `updatedAt` | 409 with the row untouched, the first save survives — PASS (one harness correction: the precondition must come from the API, not from SQL, because the driver parses the UTC column as local time) |
| C13.04 | Refresh in the middle of Add Member | the dialog is gone, nothing written — PASS |
| C13.05 | Browser back (and forward) after a create | exactly one row — PASS |
| C13.06 | Session expired between the last render and Save on Settings | no "saved", nothing written — PASS |
| C13.07 | Club switch | recorded, not built: one session = one club |

Lane totals: run 1 during the concurrent imports 2/1 + 5 not run (Neon transient, F-TC-4); run 2 with the branch quiet 2/1 (the real race, C13.02); run 3 after the fix 3/1 (harness, C13.03); run 4 **8/0**.

Human sessions (usability kit, `docs/readiness/USABILITY-KIT.md`) remain BLOCKED on participants. There is no club switcher: one session is one club (ADR-001 D4 NOT STARTED); a member of staff at two clubs signs out and in with the other club code.

## 5. Ten synthetic clubs through the real doors, then load

**Rehearsal** — `scratchpad/tenclubs/rehearsal.mjs`, dev server :3847 on the candidate, 25 Sep 15:13–15:19 UTC (329 s for ten clubs). Per club, in order, through the product's own doors: `POST /api/apply` → operator approves (`/api/admin/auth/login` cookie, then `/applications/[id]/approve`) → the activation link from the approval response signs the owner in (307 → session, `/api/settings` 200) → owner credentials login with the club code → `PATCH /api/settings` (distinct colour, distinct timezone from London to Auckland, onboarding complete) and read back → a second venue on three clubs → three tiers (monthly, four-weekly, four-weekly kids) plus a venue-bound tier on the three → four classes with schedules (one on today's weekday) → five members (two adults, a taster, a parent, a child on the parent) → a cash payment at the desk → kiosk token → today's instance found through the kiosk → staff check-in → kiosk check-in attempted → reports.

| Door | Clubs 0–9 |
|---|---|
| apply | 502 ×10 — the row is committed and the route then refuses to report success because no lead could be notified (mail dark); the assess suite documents the same behaviour. The application id was in the body |
| operator approve | 201 ×10 |
| activation link → session | 307 ×10, settings readable on the new session |
| owner credentials login | 302 ×10 to the dashboard |
| settings PATCH + read back | 200 ×10; timezone and colour read back exactly |
| second venue (clubs 0–2) | 201 ×3 |
| tiers (3 or 4 per club) | 201 ×33 |
| classes (4 per club) | 201 ×40 |
| members (5 per club, incl. a child on a parent) | 201 ×50 |
| cash payment | 201 ×10 |
| kiosk token, today's instance | 200 ×10, instance found ×10 |
| staff check-in | 201 ×10 |
| kiosk check-in | 409 ×10 — refused by the check-in window ("not open for this class yet" / "already finished"), not by the waiver; both are honest refusals |
| reports | 200 ×10, `generatedAt` present, no foreign club name in any body |

Deviations, each labelled in the result file: the apply and admin rate-limit buckets the harness itself spends were cleared by SQL between clubs (as the assess suite does); the owner's password was set by SQL because **the product has no in-app door to set a password after activation** (finding F-TC-1 below); bulk supporting data was seeded by SQL because the upload door needs a Blob token this laptop does not have.

**Operator suspension** (club 9): suspend 200 → the owner's existing session answers 401 → re-login refused with `tenant_paused` → public club lookup 404 → kiosk 403 → row `suspended`, data intact (five members still there).

**Bulk data** (`scratchpad/load/seed-ten.mjs`, labelled SQL): club 0 = 500 people, clubs 1–8 = 120 each, 26 weeks of past instances for the door-created classes, attendance at 35 % per eligible session, six payments per active adult; totals 1,460 people, 936 instances, 14,808 attendance rows, 5,262 payments across nine clubs (the suspended club got nothing).

**Load** — `scratchpad/load/run-load-n.mjs` on the production build :3948, candidate SHA, 25 Sep:

Two passes, nine clubs (the suspended club excluded), club 0 with 3× the sessions of the others, one action per session every 20 s, kiosk bursts spread evenly over the nine kiosk tokens, reports read as part of the mix. Both on ONE Node process with the production pool of **5 pg connections** (`lib/prisma.ts`: `max = 5` when `NODE_ENV=production`, the per-instance figure Vercel runs with) and a ≈0.5 s laptop→Neon round trip.

| Pass | Offered | Requests | 5xx / network | 429 | Interactive p50 / p95 | Reports p95 | Kiosk lookup p50 / p95 | Kiosk write p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| 1 (15:24–15:34 UTC) | 55 sessions (≈2.75 rps) + 3 × 60 s kiosk bursts at 10 rps aggregate (achieved 10.05) | 4,231 | **1,709 (40 %)** | 0 | 7.7–15.9 s / 20.5–20.8 s | 11.0 s | 30.7 s / 47.3 s | 31.8 s / 46.8 s |
| 2 (15:42–15:47 UTC) | 22 sessions (≈1.1 rps) + 1 × 60 s kiosk burst at 4 rps aggregate (achieved 4.05) | 906 | **0** | 0 | 0.8–2.0 s / 1.8–14.3 s | 7.5 s | 18.6 s / 24.7 s | 30.6 s / 49.5 s |

**Mechanism, read from the server log, not inferred:** every 500 in pass 1 is Prisma `P2028` "Transaction API error: Unable to start a transaction in the given time" (3,520 occurrences). Every request runs inside an interactive transaction (`withTenantContext` sets the tenant GUC), the pool holds five connections, each transaction costs one round trip per query at ≈0.5 s, and `maxWait` is 10 s — so one process saturates at roughly ten transactions a second and queues past the budget above that. Pass 2 stays under the budget (no errors) but a 4 rps burst on five connections still queues the kiosk to 20–30 s. The per-club table shows the noisy club did not degrade the others more than itself: every club's p95 sat in the same 33–47 s band during the burst.

**What this does and does not say.** It is the honest ceiling of one instance with the production pool from a client half a second away, and a fair finding on the design (one interactive transaction per request × five connections). It is **not** production capacity: Vercel runs many instances (each with its own five), the region round trip is 5–20 ms rather than 500 ms, and the real bound is Neon's pooled-connection limit × instances, which nothing on this laptop can exercise. The 60/min per-tablet kiosk limit never fired (0 × 429) because the burst was spread over nine tokens.

**Verdict for §11:** PASS at the reduced workload (pass 2, zero errors), FAIL at 55 sessions + 10 rps on one process (pass 1), BLOCKED at target scale. Finding F-TC-8 recorded in §12.

Production-representative capacity at ten clubs is **BLOCKED**: this laptop to a remote Neon branch has a ≈0.5 s round-trip floor and one Node process; the numbers above measure queueing, error and throttle behaviour under a ten-club mix, not Vercel latency. A Vercel-region run against a Neon branch of the same size is the missing artefact.

## 6. Isolation on the candidate

- Hostile substitution across three of the ten clubs (`rehearsal.mjs`, 24 probes, 25 Sep): GET/PATCH a foreign member, PATCH a foreign class, DELETE a foreign venue, check a foreign member into a foreign instance, hold a foreign member, PATCH a foreign tier — **24/24 held** (404 on every door, rows unchanged, no foreign attendance row).
- Operator suspension closes every door honestly (§5).
- `scripts/test-rls-enforced.mjs` 9/9 on the test branch under the restricted role (24 Sep, unchanged schema since the last migration applied 25 Sep 09:40).
- lb-2 30/0 on `efb3d48`; cross-tenant cells of le-1 (44/0 on `9c40447`), lb-1 (29/0 on `e5903ea`), lc-3 (10/0 on `9993565`).
- **BLOCKED:** the production runtime role's `rolbypassrls` — Noe's one-line query (ADR-001 D8). On the test branch the app role bypasses RLS, so RLS is a backstop only where the role is restricted.

## 7. Stripe: dispute closed, Bacs boundary

- `scripts/stripe-dispute-closed-e2e.mjs` — **PASS run 1, 25 Sep 15:10 UTC**, Custom test account `acct_1UJYNDJAraZ5nOBe` (created by API, charges enabled in under two minutes, deleted after): two subscriptions on `pm_card_createDispute`, first invoices → two succeeded payments through the real webhook; Stripe raised both disputes → payments `disputed`, members `overdue`, Dispute rows `needs_response` linked to the payment; evidence submitted with the documented test strings; `charge.dispute.closed` **won** → payment `succeeded` again, member `paid`, Dispute `won`, one `stripe.dispute.won` audit row; **lost** → payment written off as `refunded`, member `overdue` (still a member), Dispute `lost`, one audit row; both closures redelivered → `alreadyProcessed`, no second audit row.
- **F-TC-2 (PRODUCT, medium) found and fixed:** on `charge.dispute.created` the webhook queued two templates (`dispute_created` and `dispute_opened_owner`) to every owner — every chargeback landed twice. The Aug-22 connection audit had recorded this as BROKEN #8; it was still live. Now one `dispute_opened_owner` per owner; `tests/unit/stripe-webhook-handlers.test.ts` pins exactly one send per owner per opened dispute (65/65).
- **Bacs:** the boundary is proven, the mandate flow is **NOT RUN**. `acceptsBacs=false` (the default, and the value the onboarding wizard writes for pay-at-desk clubs) refuses `bacs_debit` at `lib/stripe/subscriptions.ts:69` and in both member start routes; the migration engine skips a saved Direct Debit with `bacs_not_enabled`; the settings registry names the switch as medium-risk with "existing contracts unchanged". A live Bacs mandate (pending → processing → succeeded, and the Bacs-specific failure reasons) needs a test-mode account with the `bacs_debit_payments` capability and the mandate flow driven in a browser; not attempted today.

## 8. Migration rehearsal and cutover readiness

**Source-shaped export.** Total BJJ's real file is not on disk (it was pasted into a chat on 24 Sep) and real member data must not enter a fixture. `tests/integration/teamup-rehearsal.test.ts` generates a deterministic export from the catalogue in the runbook: the 13 plans with their 24 Sep active counts (296), plus four active adults with no email, two adults on one address, eight people on hold (five adults, three siblings on a family address), 120 cancelled-only people, three finished prepaid courses, six deleted customers, kids on parents' emails (60 % on an adult's row, 40 % on a family address with no adult row → payer synthesised from the emergency contact), siblings, upgrade history rows.

**Results** (`tests/integration/teamup-rehearsal.test.ts`, test branch, guarded vitest wrapper; runs 3 and 4 on the fixed candidate, 25 Sep 15:39–15:44 UTC):

| Cell | Result |
|---|---|
| Preview reconciles to the catalogue: 296 + 6 active (the four no-email adults and the two partners on one address are people the catalogue counts elsewhere), 8 on hold, every one of 13 plans' counts exact, 6 deleted rows dropped, 4 no-email, 1 shared-address pair, 28 payers synthesised, 138 + 3 kids, 0 kids without a parent, 123 history-only, 0 row errors, no due date ever derived into `nextDueAt` | PASS |
| Commit lands every person (461), every kid on a parent, per-plan counts in the database match the catalogue, no duplicate email; 461 people in ≈17 s | PASS |
| The same file committed again creates nobody (0 imported, 0 errors, count unchanged) | PASS |
| A crash in the middle of a batch (a transaction that throws after its insert, rolled back) is reported as errors on that batch, not hidden; the re-run completes to 461 with no duplicate and no orphan | PASS |
| Three clubs importing the same file at once, each in its own owner scope: three × 461, 0 errors, nothing crosses, wall time ≈25 s for the three | PASS |

**Finding F-TC-6 (PRODUCT, high for Sean) found by this rehearsal and fixed:** the commit split drafts on `accountType === "kids"` alone, so every 13–17 junior the preset had linked to a parent went through the adult pass and landed with **no guardian** — 65 of the 141 under-18s in the shaped file. For Total BJJ that is the parent-pays path, the parent-signed waiver and the family view lost for roughly a third of the kids. A junior that names a parent now goes through the kid pass (`app/api/admin/import/[id]/commit/route.ts`); the rehearsal is the red-on-revert. Two generator faults on the way (siblings or a parent sharing a first name on one address fold into one person — correct parser behaviour) are recorded as F-TC-5.

**Deviation from a real rehearsal:** the file is catalogue-shaped, not Sean's. On the day, the runbook's reconciliation block against TeamUp's own counts is the gate before commit; this test proves the machinery, not his data.

**Cutover checklist** (runbook `docs/runbooks/TEAMUP-MIGRATION.md`, reworded today per path):

1. Push the candidate and confirm the four migrations applied (§10) — the import preset, holds and replace path are not on the live site.
2. Noe: `CRON_SECRET` in Vercel (reconcile + retention + instances), DMARC TXT (invites), `RESEND_WEBHOOK_SECRET` (bounce states); the production role query.
3. Sean connects his Stripe (Settings → Revenue); MatFlow's live platform keys and Connect client id must already be in Vercel — this is the Stripe setup that Sean paying MatFlow by Direct Debit does **not** remove.
4. Create the tiers named exactly as the catalogue (runbook table); re-check prices and counts on the day.
5. Export from TeamUp; import as source TeamUp; **reconcile the per-plan counts** to TeamUp's own before committing; do not send invites.
6. Preview the migration with "Keep existing subscriptions" unticked; fix every "not ready" row; preview again; confirm.
7. End TeamUp memberships **per member by path**: replaced → the same day, after the replacement id shows; created → before the printed due date; adopted → never; skipped → not yet. **Last safe rollback point is before this step.**
8. Send invites only once a real invite has been seen to deliver (`dkim=pass dmarc=pass`).
9. First-renewal observation: for each member, the first `invoice.payment_succeeded` on their period end (Payments), reconcile cron the morning after.

**Verdict — cutover readiness: NOT READY.** Blocked on: the push (the live site cannot import TeamUp or replace subscriptions), CRON_SECRET, DMARC, the Stripe platform going live, and the production role answer. Everything on the engineering side of those five is in place and rehearsed.

## 9. Email: classification and inventory

**Classification: PARTIAL.** The prompt's premise that "there is no email system" is wrong; the premise that it is unproven in production is right.

| Layer | What exists | What is missing |
|---|---|---|
| Adapter | `lib/email.ts` `sendEmail()` — Resend client (lazy, cached), 22 templates (invite, magic link, owner activation, reset, welcome, receipt, refund, payment failed member/owner, dispute opened, Stripe disconnected, rank changes, action assigned, kiosk waiver, application received/internal, CSV handoff, import complete, new-device login, test), Reply-To and header pass-through, secret redaction in stored errors | a queue/outbox: sends are synchronous after the DB commit and are not retried; a crash between commit and send loses the mail with only a `failed`/absent EmailLog row |
| Ledger | `EmailLog` per tenant with `queued → sent → delivered / bounced / complained / failed`, `resendId`, `sentAt`, error text | a dead-letter view for owners/operators; a resend button |
| Suppression | 30-day bounce/complaint short-circuit per recipient; synthesised (`@no-login.matflow.local`) addresses never sent to; member opt-outs read by the senders | — |
| Provider webhook | `app/api/webhooks/resend` maps `email.sent/delivered/bounced/complained` onto the log (svix-signed) | `RESEND_WEBHOOK_SECRET` unset in production → delivery states never arrive |
| Sender identity | `RESEND_FROM`, falls back to `onboarding@resend.dev` (sandbox: delivers only to the account owner) | DMARC TXT for matflow.studio not published → production invites go out from the sandbox sender or not at all |
| Test environment | `.env.test` carries a key; the dev/prod-build launchers used here set an **invalid** key so every send fails into EmailLog (the July quota incident: real sends to fake addresses) | — |
| Mail-dark behaviour | with no client, one honest `failed` row and `ok:false`; apply/forgot-password/approve routes degrade explicitly (apply 502 `saved:true`; approve prints the activation link to the server log outside production) | — |

**Journeys with no email path in production today:** owner activation after approval (the link is only in the response outside production), member invites (import → invite chain), magic links, password reset codes (the only door to a chosen password for an activated owner — F-TC-1), payment-failed chases, dispute and disconnect alerts to owners, receipts. All of them work on the code path and all of them fail to reach a human until DMARC and `RESEND_FROM` are set. **Live delivery: BLOCKED** (Noe: DNS + Vercel env). The minimal outbox/retry foundation was not built today (time went to the doors and the rehearsal); it is sized S–M and listed in §12.

## 10. Jobs, pending migrations, deploy and restore

**Pending migrations (four), reviewed for locks, cost and compatibility:**

| Migration | Statements | Lock / cost | Old app on new schema |
|---|---|---|---|
| `20260923220000_billing_cycle_weekly` | drop + re-add the `billingCycle` CHECK as `NOT VALID`, then `VALIDATE` | ACCESS EXCLUSIVE for the constraint swap (instant on a tiny table); VALIDATE takes SHARE UPDATE EXCLUSIVE and scans `MembershipTier` (dozens of rows) | fine — superset of the old values |
| `20260924120000_member_hold_until` | `ADD COLUMN "holdUntil" TIMESTAMP(3)` nullable | catalogue-only, instant | fine — nullable, unread by the old code |
| `20260925000000_locations` | `CREATE TABLE Location` + indexes + FK to Tenant, RLS enable/force/policy, `Class.locationId` nullable + FK + index, backfill one `Main` row per tenant | new table: no lock on existing rows; `ADD COLUMN` nullable instant; `ADD CONSTRAINT FK` takes SHARE ROW EXCLUSIVE on `Class` and validates (hundreds of rows); backfill = one INSERT…SELECT over `Tenant` (tens of rows) | fine — `locationId` NULL means "every venue"; the old code never reads it |
| `20260925090000_tier_location` | `MembershipTier.locationId` nullable + FK + index | as above, tiny | fine |

All four are additive and forward-compatible; the previous build keeps running on the migrated schema, so **rollback of a bad deploy is a redeploy of `ac2fcb8` without touching the database**. Applied to the test branch in this order on 24–25 Sep with no error; RLS suite 9/9 afterwards.

**Ordered deploy plan (when Noe says push):** `git push origin main` → Vercel build runs `scripts/maybe-migrate.mjs` (production only: `VERCEL_ENV === "production"` and the prod endpoint) → `prisma migrate deploy` applies the four → `next build` → smoke: `/api/health` `db:ok`, `/login`, a club's `/[slug]` → login, owner login on the demo club, Settings → Overview shows the Locations card with `Main`, Memberships shows the tiers with counts, `/api/cron/retention?dryRun=1` with the secret once it exists. Rollback limit: redeploy the previous build; never `migrate reset`.

**Jobs:** `vercel.json` schedules monthly-reports (02:00 on the 1st), retention (03:30 daily), class-instances (02:40 daily); each route 503s without `CRON_SECRET` (`lib/env-guards.ts` records this). `stripe-reconcile` exists as a route and is **not scheduled** (GAP S: add it). Retention has `?dryRun=1` (counts, deletes nothing) for the first production run. Restore drill: **BLOCKED** (no Neon API key or console access from here; runbook `docs/runbooks/db-restore.md`).

## 11. Verdicts

| Question | Verdict | Why |
|---|---|---|
| Live site, ten clubs today | **NO-GO for ten; LIMITED PILOT for one club** | The deployed revision predates every fix of the week (no TeamUp import, no holds, no replace path, no venues, dispute emails doubled); crons have never run; mail cannot reach anyone; the production role is unknown. One concierge-run club on cash/pay-at-desk with the operator watching is the most it can honestly carry. |
| Local candidate at ten clubs | **PASS at the reduced workload; BLOCKED at target scale** | Ten clubs through every door with zero product failures (§5), 24/24 isolation probes held, suspension honest, pass 2 clean (906 requests, 0 errors, 0 throttles) and pass 1 failed on the single-process pool (40 % P2028 at 55 sessions + 10 rps). Production-representative latency needs a Vercel-region run. |
| Sean rehearsal (catalogue-shaped export) | **PASS** on the catalogue-shaped copy (5/5 cells), with one high-impact product fix landed from it (F-TC-6) | §8 |
| Cutover readiness | **NOT READY** | Five blockers, none engineering: push, CRON_SECRET, DMARC, Stripe platform live, production role (§8). |
| Concurrent migrations | **PASS** — three clubs committing at once, 0 errors, nothing crosses (§8); no queueing beyond the batch transactions themselves | §8 |
| Email foundation / live delivery | **PARTIAL / BLOCKED** | §9 |

## 12. Findings, commits, blockers, completion

**Findings this audit**

| ID | Class | Finding | Status |
|---|---|---|---|
| F-TC-1 | PRODUCT (medium) | An owner who arrives by the activation link has no in-app way to set a password: the staff PATCH route excludes owner rows, there is no account/password route, and the activation email's "Settings → Account to set one" points at nothing. Until mail delivers, the only doors back in are the magic link and the emailed reset code — neither reaches anyone today. | recorded; fix sized S (an owner self-service password route with re-authentication) |
| F-TC-2 | PRODUCT (medium) | Every opened chargeback emailed each owner twice (two templates on one webhook branch; Aug-22 BROKEN #8 was never fixed). | **fixed**, unit-pinned |
| F-TC-3 | GAP (S) | `stripe-reconcile` cron has no schedule in `vercel.json`. | recorded |
| F-TC-4 | HARNESS | Two Neon transients (AggregateError) during lh-1 C5.07 and lh-4 C13.02 while three imports and the seed ran on the same branch; both cells green on re-run. | re-run |
| F-TC-5 | HARNESS | The first catalogue-shaped export folded four kids into their siblings (same first name on one family address is one person to the parser, by design); the generator now keeps sibling first names distinct. | fixed in the test |
| F-TC-6 | PRODUCT (high for Sean) | Juniors (13–17) from a TeamUp import were never linked to the parent the file names (kid pass keyed on `accountType === "kids"` alone). | **fixed**, rehearsal is the red-on-revert |
| F-TC-7 | UX (reported by Noe) | On the branded login, revealing a saved password could render it invisible: browser autofill styling paints its own text colour over the themed input. | **fixed** defensively (`login-field` autofill rule with the theme's ink and surface); not reproduced here |
| F-TC-8 | CAPACITY (design) | One interactive transaction per request on a five-connection pool saturates one instance at ≈10 tx/s when the database is 0.5 s away (P2028). Fine in-region at many instances; the number to measure is Neon's pooled ceiling × instances. | recorded; options are a larger per-instance pool where Neon's limit allows, or reading the tenant GUC outside a transaction for read-only routes (M) |
| F-TC-9 | PRODUCT (low) | Two simultaneous hold submits both succeeded (read-then-write), writing two audit rows and pausing Stripe twice. | **fixed**: compare-and-set on `paymentStatus`; unit-pinned, lh-4 C13.02 is the wire proof |

**Commits (local, unpushed):** `d33943d` fix(stripe) one owner email per opened chargeback + dispute-closed script · `c230ae1` fix(login) revealed password readable under autofill · `470e316` fix(import) juniors linked to a named parent + catalogue-shaped rehearsal test + runbook step 7 · `9c2d6ed` fix(members) compare-and-set hold + lh-4 transitions lane + register/catalogue rows · the docs commit carrying this report. **Gates on the final tree:** `tsc --noEmit` 0 errors; `npm run lint` clean, all eight UI ratchets at baseline; unit 2,215 passed / 0 failed (247 files; 27 DB-bound files skipped without TEST_DATABASE_URL, the rehearsal file run separately); `tests/integration/teamup-rehearsal.test.ts` 5/5 clean run (74 s); lanes on the candidate today: lh-1 10/0, lh-4 8/0 (plus the earlier 12 lanes listed in §2 on the commits they ran on); RLS 9/9 unchanged since the last migration. Not re-run today: the full 24-file serial on one SHA (≈2 h) — the candidate has been proven lane by lane, not as one frozen run. 28 local commits are unpushed (`861cd1a` … the docs commit).

**Left standing on the test branch** for Noe to decide: the ten `tcmuh1jicz-*` clubs with their bulk data (1,460 people, 14,808 attendance rows) and the earlier `loadpilotmug0ox4x` club; the Stripe test accounts were deleted.

**Blocked (Noe):** production `rolbypassrls` query; `CRON_SECRET`; DMARC TXT + `RESEND_FROM` + `RESEND_WEBHOOK_SECRET`; Stripe live platform (keys, Connect client id, live webhook endpoint); Neon restore access; usability participants; a Vercel-region load budget; a test-mode account with Bacs capability for the mandate flow.

**Not started (engineering, sized):** owner self-service password (S); email outbox with bounded retries and dead-letter (S–M); reconcile cron schedule (S); Bacs mandate leg (M); verified Person identity + switcher (L, ADR-001 D4); staff venue scope (decision D6a); ten-club soak longer than ten minutes.

**All currently unblocked work completed: NO.** Everything the prompt asked for that could be done from this laptop without a decision from Noe was done and is evidenced above, with these exceptions, each a deliberate scope call rather than a blocker: the minimal email outbox with retries and dead-letter (S–M) was not built — the doors, the rehearsal and the four product fixes took the day; the owner self-service password route (F-TC-1, S) and the reconcile cron schedule (F-TC-3, S) are recorded, not built; the Bacs mandate leg needs a test-mode account with the Bacs capability and a browser-driven mandate (M) and was not attempted; the full 24-file serial on one frozen SHA was not re-run. Everything else outstanding is BLOCKED on Noe (§12 list) or on external access (Vercel-region load, Neon restore, participants).

****
