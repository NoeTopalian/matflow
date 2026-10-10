# Staged release sequence — from the reviewed candidate to a restricted runtime with audit protection and tested recovery

Prepared 10 Oct 2026 22:40 Italy by the coordinator at Noe's instruction. **Nothing in this document is authorised by its existence: no migration application, merge, push or deployment has been approved.** Each stage names its gate (what must be true before it), its executor, its verification and its recovery. Stages marked NOE are production actions only Noe performs; stages marked AGENT are local work agents may do under existing authorisation. Sources: `ITERATION-2-REPORT.md`, `evidence/B2/04-rollout.md`, `CONTAINMENT-CHECKLIST.md`, `INCIDENT-AND-RESTORE-RUNBOOK.md`, `docs/readiness/admin-hub-2026-10-09/RELEASE-PACKAGE.md`, `DENIALS.md`. The SF-62 application integration detail is lane B4's `SF-62-APPLICATION-INTEGRATION.md` (in progress at writing).

## Stage 0 — Establish facts (NOE; read-only; no change)
0.1 Offline fingerprint check of `.env` (PRE-APPROVAL-ANSWERS A3.4). Gate for everything below: its result is interpreted before any production action is requested.
0.2 Provider-side revocation evidence for the 7 May leak: Neon role password reset date after 7 May 14:17 UTC; Resend key list without the leaked key; Vercel variable change dates. A local non-match does not replace this.
0.3 Production role read: `node scripts/readiness/db-role-inspect.mjs .env ep-bold-wave-abt39t7x` (one TLS-verified READ ONLY transaction; prints flags, memberships, schema privileges incl. CREATE, policy expressions, SECURITY DEFINER functions; no credential). Decides whether the runtime is the owner (presumed) and what Stages 3–5 protect.
0.4 Read `LOGIN_THROTTLE_ENABLED`'s production value (SF-68); confirm `ENABLE_GOOGLE_OAUTH` and the Google client variables are absent (Google stays disabled; not a prerequisite for anything).
0.5 Neon PITR window and branch-restore capability (SF-19); whether production holds attendance-import decisions (D3 provenance side effect) and the Iron Path seeded accounts (SF-109).
Verification: the pasted redacted outputs. Recovery: none needed.

## Stage 1 — Containment that precedes any deploy (NOE)
1.1 If 0.1 is a MATCH or 0.2 shows no rotation: rotate the Neon password and revoke/reissue the Resend key at the providers; update Vercel Production; redeploy the CURRENT build (`e8afb6a`) — never Instant Rollback (old builds keep old secrets). CONTAINMENT-CHECKLIST §4 steps 1–3.
1.2 GitHub: secret-scanning validity checks on; apply `evidence/E2/github-ruleset-main-proposed.json` to `main` (SF-72) — required because pushing `main` deploys and migrates production.
1.3 Admin-hub prerequisites (RELEASE-PACKAGE §2): operator authenticator enrolled and challenged; `OPERATOR_ALLOWED_IDS` set to the operator id; `MATFLOW_ADMIN_SECRET` rotated; `EMAIL_DELIVERY=off` confirmed.
1.4 Iron Path demo accounts (SF-109): bump their session versions (runbook §1.3) and reset the four passwords through the reset path, or disable the three non-owner rows. The TEST-only tool from lane M1 v2 does not run against production.
Verification: provider timestamps; `OPERATOR_ALLOWED_IDS` present; four accounts changed. Recovery: provider-side only; nothing here touches code.

## Stage 2 — Application release A (NOE decides; AGENT prepared)
Candidate: executable `03ef584` on `security/assurance-2026-10` (documentation commits follow; three test files added since, re-run green — PRE-APPROVAL-ANSWERS A2.3). Gates: Stage 0 interpreted, Stage 1.1–1.3 done, Stage 4.1 backup chain in place (a restore point exists before the six migrations run).
2.1 Merge to `main`; the push deploys and applies the six inherited admin-hub migrations (additive; `prisma/migrations/2026100[6-9]*`). No migration from this campaign is in the tree.
2.2 Compatibility: every change is compatible with production data as it stands; behaviour changes an operator must know are listed in ITERATION-2-REPORT §6 option A (503 outage mode, one `rate_limited` code, new-device refusal under attack, Google refused, disown needs a click, CSP report-only, upload limits, malformed hold refused, pre-D3 import decisions fall back to pending).
2.3 Post-release checks: `/api/health` shows the exact SHA; `release-verify.mjs --target production` exit 0; migrations status clean; an owner sign-in; eleven wrong passwords show `rate_limited`; CSP Report-Only header present on a page; one upload succeeds; `/api/csp-report` answers 204; `/api/cron/*` answer 503 (CRON_SECRET unset); operator console reachable only by the allowlisted operator.
2.4 Recovery: compatible code only; redeploy the previous build with the same environment; never Instant Rollback. The six migrations are additive and stay.
Option B/B+ is NOT a candidate (PRE-APPROVAL-ANSWERS A3.2).

## Stage 3 — Configuration that follows the deploy (NOE)
3.1 CSP: check enforce mode and `report-to` delivery on an https preview, then `MATFLOW_CSP_ENFORCE=1` (SF-30).
3.2 Blob token: rotate only now, after the SF-28 fix is live (SF-69); mark Sensitive, Production only.
3.3 Preview secrets, TESTING_MODE, old deployments: CONTAINMENT-CHECKLIST §4 steps 7–9 (retirement list in `evidence/E2/`; deletion is not revocation).
3.4 DMARC/SPF staged records in the written order (none → quarantine 25 % → 100 % → reject) — only relevant once mail is on.
3.5 Crons: `RETENTION_CRON_ENABLED` stays unset (default OFF once lane M1 v2 lands and ships in a later release); `CRON_SECRET` stays unset until Stage 4 is complete; class-instances and monthly-reports can only run once `CRON_SECRET` is set, and with the gate in place retention stays off while they run.
Verification: headers observed; cron logs. Recovery: unset the variable.

## Stage 4 — Recovery actually tested (NOE; AGENT tooling exists)
4.1 Backups: add the dump secrets to `db-backup.yml` AND a roles/grants/default-privileges capture (SF-77; `backup-export.mjs` records them, the pg_dump job does not); read the PITR window.
4.2 One TEST child-branch restore checked with `restore-verify compare` (runbook §2.4), then the neutralise step (§6.5a) on that branch — the first run of the neutralise CLI against a copy it accepts.
4.3 Only then: `CRON_SECRET` set (retention still OFF by the gate) and a logged `?dryRun=1` of retention; enable retention only after reading the dry-run counts.
Verification: compare PASS; dry-run counts. Recovery: PITR.

## Stage 5 — Restricted runtime identity and the SF-62 boundary (NOE for every migration; AGENT for the application work)
Gate: Stage 0.3 result known. Order from `evidence/B2/04-rollout.md`:
5.1 Phase 1 migration `proposed-sf62-phase1.sql` — additive (system role, `matflow_sec` schema, `ctx_tenant`, resolvers); compatible with the deployed app; run as the owner from the separate migration path; rollback = phase-1 block of `proposed-sf62-rollback.sql`.
5.2 Secrets out of band: 64-byte key into `matflow_sec.context_key` (owner session) and `RLS_CONTEXT_SIGNING_KEY` into the runtime environment; create the `matflow_ops` login (operator/cron work).
5.3 Application release B (AGENT prepares; NOE deploys): replace the 116 `withRlsBypass` sites per class (ops client, narrow lookups, signed context, justified system use, deletions), add the second Prisma client/URL for `matflow_ops`, move the ~30 test teardowns and 4 e2e helpers to an owner connection — the complete inventory is lane B4's `SF-62-APPLICATION-INTEGRATION.md`. Gates: full unit, both-role sweep, the acceptance test `sec-b2-public-boundary-proposal` run against a TEST branch with phases 1+2 applied (NOT RUN today), independent review.
5.4 Phase 2 migration `proposed-sf62-phase2.sql` — the switch; refuses without the key; BREAKS any build still calling `withRlsBypass` as `matflow_app`; rollback = phase-2 block (restores today's policy semantics exactly). Never roll the app back below release B while phase 2 is applied without the phase-2 rollback first.
5.5 Production `DATABASE_URL` → `matflow_app` on the pooler host; the owner credential out of every runtime environment; migrations from a separate pipeline/credential (a Vercel variable readable by the app is not a separation).
5.6 Phase 3: revoke runtime writes to `Operator`, `PlatformConfig` and `_prisma_migrations` (SF-73), once the operator console runs as `matflow_ops`.
Verification: `db-role-inspect` after each step; the 16 attack checks of `rls-boundary-harness.mjs` against the production role (read-only harness variant to be prepared). Recovery: the rollback file per phase; PITR for data.

## Stage 6 — Audit protection (NOE)
Gate: Stage 5.5 (the app no longer connects as the owner), a restore point, and the test teardowns moved (5.3).
6.1 SF-57 v2 `evidence/F2/patches/0002` (migration) + `0001` (purge wiring, retention rule switch); the ten-cell test must then run on a shared TEST branch before production (it has only ever run in the PGlite copy — SEC-083).
6.2 Verification: as `matflow_app` UPDATE/DELETE/TRUNCATE/back-date refused; purge minimums honoured; owner behaviour documented. Recovery: drop the triggers and the purge function (runbook addition owed).

## Stage 7 — Later proposals (NOE decisions; not prerequisites)
Google linking store (SF-36 proposal; Google stays disabled); member TOTP single-use migration (SF-90); DSAR cascade digests (SF-115); the pooled-leak owner-role measurement and CREATE check (SF-87, D-5/D-6 — Noe runs the read-only metadata queries himself or authorises a separately scoped lane).

## Standing constraints
No production action by an agent; every denial in `DENIALS.md` stays in force across tools and agents; every production statement is dated; acceptance is not declared while runtime isolation (Stage 5), revocation evidence (Stage 0.2/1.1), audit protection (Stage 6) or tested recovery (Stage 4) remain unresolved.
