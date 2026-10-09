# Lane F (availability and recovery) — evidence log, 9 Oct 2026

Branch `security/assurance-2026-10`, HEAD `ab5f928` (verified with `git rev-parse HEAD` at start). Lane D was editing
`lib/importers/attendance.ts`, `lib/attendance-import.ts`, `app/api/admin/import/attendance/route.ts` in the same tree;
lane F did not touch them. TEST branch only (`ep-hidden-salad`) through `<sp>/att/run-engine.sh` (neondb_owner) and
`<sp>/q78/run-restricted.sh` (matflow_app, RLS_ENFORCED=1). `<sp>` = the session scratchpad. No production access, no
server build, no mail. Raw logs: `<sp>/security/F/`.

## F-01 SF-26 harness defects (SEC-088)

### security.test.ts (it lives at `tests/integration/security.test.ts`, not tests/unit)
- Red at HEAD: `DATABASE_URL= npx vitest run tests/integration/security.test.ts` → exit 1, 2 failed / 10 passed: both
  F5 staff-creation cells (`expected 500 to be 201`). Root cause: since 48a9182 the staff route claims the login
  address inside its transaction (`lib/login-email.ts` → `tx.$executeRaw` advisory lock + two `tx.$queryRaw` holder
  lookups); the file's Prisma mock had neither, the claim threw a TypeError, and the route's catch-all answered 500
  without logging (a silent 500 is itself an SEC-081 observation: the staff POST catch logs nothing).
- Fix (test only): `$executeRaw` / `$queryRaw` added to the mock; cell 2 now also asserts 201; new control cell: when
  the holder lookup returns a row the route answers 409 with an opaque body, writes nothing, and took the lock once.
- Green: exit 0, 13/13. Mutant: the route's `if (claim.kind !== "none") throw …` replaced by `void claim` → exit 1,
  the control cell fails (1 failed / 12 passed); file restored byte-identical (`git diff --quiet`).

### email-lowercase-invariant.test.ts (`tests/integration/`)
- Red under matflow_app: original file → exit 1, 4/4 failed, `Seeded tenant "totalbjj" is missing` — a bare
  connection under forced RLS sees no Tenant row and may insert no Member row; its cleanup silently deleted nothing.
- Fix: every statement runs in a transaction carrying the application's transaction-local context
  (`set_config('app.current_tenant_id', …, true)`); the seeded club is resolved under a transaction-local bypass, as
  the application resolves a club by slug; created ids are recorded; teardown deletes by id and is count-checked; the
  UPDATE cell asserts exactly one row changed (an RLS-filtered UPDATE of 0 rows can no longer read as a pass).
- Green: matflow_app exit 0 4/4; neondb_owner exit 0 4/4.
- Mutant (trigger removed): `evidence/F/email-trigger-mutant.mjs` disables `Member_email_lowercase` inside one
  rolled-back transaction: with the trigger the stored address is lowercase, without it the mixed-case address
  survives (`email-trigger-mutant.out`), so the test's assertion discriminates. Residue 0; trigger state after
  rollback `O` (enabled).

## F-02 Suite audit (SEC-088)
- Full suite with no database (`DATABASE_URL= TEST_DATABASE_URL= npx vitest run --reporter=json`): 492 files, 6,317
  tests: 5,892 passed, 1 failed (`tests/unit/sec-e-secret-scan.test.ts`, lane E in progress), 424 skipped/todo.
  **56 DB-backed files (421 tests) skip entirely**; 0 zero-test files; 0 partially skipped files.
- `.github/workflows/`: no `continue-on-error` on any gating step. The only one is the report-only history secret scan
  in `security-supply-chain.yml` (scheduled, documented). `|| true` only on `grep -c` counters in `db-backup.yml`.
- In CI the DB-backed files run against a service Postgres as the `postgres` SUPERUSER; only `rls-foundation` runs
  under a NOBYPASSRLS role. So every lane's "both roles" result is local evidence only; CI proves one role.
- `rls-foundation` self-skips its 6 enforcement cells under a BYPASSRLS role unless `RLS_ENFORCED=1` (CI sets it for
  the restricted step) — correct, documented. Its teardown swallows errors (`catch {}`), leaving fixtures on failure.
- No `expect.soft`, no retries, no `ctx.skip` outside rls-foundation; two `if (!HAS_DB) return` only in `afterAll`.
- CI on `main` red for the last 4 pushes, nightly e2e red 6/6, backup red every week (E-05): three always-red jobs
  are noise nobody acts on — false assurance by fatigue.
- New gate `scripts/readiness/test-skip-gate.mjs` (fails on any failed/load-error/zero-test file; with `--require-db`
  on any skip not individually allowed). On the no-DB run: exit 1 plain (the sec-e failure) and exit 1 with
  `--require-db` naming all 56 skipped files. Proposed CI wiring in REPORT.md (ci.yml is not lane F's file).

## F-03 Availability (SEC-073–080)
- SEC-073 bcryptjs 3.0.3, cost 12: **~504 ms CPU per compare** (3 calls), and a 1 MiB password costs the same (527 ms;
  bcrypt reads 72 bytes). Login password schema `z.string().min(8)` has no max (harmless for cost). Every
  unauthenticated bcrypt path is rate-limited before the hash (login: per-IP 30/30 min + per-account 5/15 min; operator
  login 5/15 min per IP; reset, accept-invite, transfer). Authenticated paths (set-password, staff create/edit) are
  not, but need a session. Unknown addresses pay a DUMMY_HASH compare by design (enumeration). IP keys: Vercel
  overwrites X-Forwarded-For (vercel.com/docs/headers/request-headers, page dated 2025-12-13, read 9 Oct 2026), so
  `auth.ts:302`'s first-entry read is not spoofable on Vercel today, but it diverges from `getClientIp`
  (x-vercel-forwarded-for first) and would become spoofable behind any added proxy (Low; lane A's file).
- SEC-074 `tests/unit/sec-f-parser-deadlines.test.ts` (32 cells, U/Fuzz): doubling series to 1 MiB (CSV) / 256 KiB
  (scalars), seeded mulberry32 adversarial tokens, 1.5 s per-step budget: parseCSV ×3 seeds, unterminated quote,
  comma explosion, parseImport(generic, teamup), parseTeamUp, parseAttendanceCsv (adversarial + 1 MiB realistic),
  sniffCsvKind, emailField (zod .email runs before .max), normaliseEmail, club code, recovery code, error reference,
  normaliseIp, parseOffsetInstant, readableOn, isVercelBlobUrl, parsePagination — all reach the cap; whole file 9 s.
  Harness control: a planted O(n²) scan stalls and the assertion fires. Static scan for nested quantifiers in
  app/ lib/ components/: one hit, `lib/blob-url.ts` `([a-z0-9-]+\.)*`, dot-anchored, linear (tested). Limit: an
  exponential regex could block one step before the budget check (stated in the file).
- SEC-075 code review: `lib/pagination.ts` hard cap 100; kiosk member list max 500; payments export capped
  (`EXPORT_ROW_CAP`); reports bounded by weeks 4–24; all tenant-scoped (a club can only load itself). 42 of 70
  route files with `findMany` carry no literal `take:` — sampled ones are bounded by parent (class, instance); a full
  per-route census was not done (gap). Readiness scripts: read-only transactions; 8 of 12 DB scripts set no
  statement_timeout; `owner-account-state.mjs` and `tenant-state.mjs` have no host guard (read-only).
- SEC-076 **fixed**: node-postgres `connectionTimeoutMillis` defaulted to 0 = a query waits FOR EVER for a pool slot
  (interactive transactions were bounded by maxWait 10 s; plain queries were not). `lib/prisma.ts` now exports
  `prismaPoolConfig()` with `connectionTimeoutMillis: 10_000` (max 5 production / 20 otherwise, keepAlive unchanged).
  `tests/integration/sec-f-pool-exhaustion-db.test.ts` (4 cells, I/L, pool max 1, ≤ 3 connections, < 90 s): the
  waiter is refused in ~10 s with the production config (pg Pool and Prisma+PrismaPg, the held transaction still
  commits), positive control after release, hazard control (no deadline → still pending after 12 s). Both roles exit
  0 4/4. Mutant (deadline removed) → 3 cells fail. Observed: TEST `neondb_owner` has statement_timeout 10 s,
  `matflow_app` has **none** (0) and idle_in_transaction 5 min; production values UNKNOWN (depend on SF-02). Advisory
  locks: only `pg_advisory_xact_lock` (transaction-scoped, released at commit/rollback) — none held across requests.
- SEC-077 code review: no internal retry loops (mail returns ok:false and logs; Stripe webhook dedupes on
  `StripeEvent.eventId` unique and acks; Resend webhook acks); crons run once per schedule, chunked with deadlines.
  The Stripe reconciliation that repairs webhooks lost in an outage runs inside the retention cron, which answers 503
  in production (SF-17), so it never runs.
- SEC-078 C-level only: per-principal quotas exist as rate limits on unauthenticated doors; authenticated heavy work
  (imports up to maxDuration 300 s, exports, reports) has no per-club quota. No load test (production load tests not
  authorised; a local build needs the lead).
- SEC-079 lockout DoS (U/C): 10 failures → 1 h lock; failures are throttled to 5 per 15 min per account, so anyone who
  knows an address can re-lock it every ~75 min with ~10 requests from any IPs. Recovery: owner staff-unlock (owner
  only), member unlock (owner/manager), password reset/magic link (need mail — dark in production), operator reset
  (needs the operator allowlist — unset). Lane A's points stand: the counter stops counting when its write fails
  (logged + Sentry, failMode open), and the "account locked" message is an existence oracle (Noe's decision, SEC-002).
- SEC-080 `tests/unit/sec-f-provider-outage.test.ts` (6 cells, U): with the store down, failClosed rate-limit callers
  throw (route refuses); default callers fall back to a per-instance window that still enforces the max and logs the
  denial; durable audit throws (caller refuses), best-effort audit never throws and logs the loss. Mutants
  (failClosed ignored; fallback made permissive) → 2 cells fail. DB-down for session revocation: lane A
  (`sec-a-revocation-fail-closed*`, in the both-role run below). Mail outage: `sendEmail` returns ok:false and writes
  an EmailLog row (needs the DB). Blob/Stripe outage behaviour: lane D.

## F-04 Audit (SEC-081–083)
- SEC-083 `audit-tamper-probe.mjs` → `audit-tamper-probe-2026-10-09.json`, both roles, one rolled-back transaction,
  residue 0: the runtime role can UPDATE an audit row's action (1 row), back-date `createdAt` 400 days (1 row — the
  retention cron would then delete it as ordinary), and with a self-set transaction-local `app.bypass_rls` read every
  club's rows and DELETE one. `matflow_app` holds DELETE/INSERT/SELECT/UPDATE; `neondb_owner` also TRUNCATE; no
  non-internal trigger on AuditLog. From another club's context matflow_app updates 0 rows (RLS works for tenant
  separation; it is not a tamper control). The existing unit "audit-actor-columns-immutability" is a source-grep that
  no route updates AuditLog — true, and not a database control.
- SEC-081: durable/strict modes throw on failure (unit above); `audit-durability-db` in the both-role run.
  Best-effort mode is used by most of the ~120 call sites and loses rows silently except a console.warn.
- SEC-082: `scrub()` removes 12 forbidden keys at the TOP level only, case-sensitive; a nested
  `metadata.before.passwordHash` or `metadata.Token` is written. No caller passes one today (sweep of console/audit
  call sites); dev-only logs of reset codes and magic links are gated by NODE_ENV !== production. Raw
  `x-forwarded-for` first entries are stored as `ipAddress` by undo, undo-to and magic-link request (attacker-shaped
  on non-Vercel hosts; overwritten on Vercel).

## F-05 Backup, restore, rollback (SEC-084–087)
- SEC-085/086: no Neon CLI or API key available (`neonctl` absent; `npx neonctl` would need installing and Noe's key),
  no local pg_dump/psql/docker. **No restore was executed: BLOCKED.** Built instead:
  `scripts/readiness/restore-verify.mjs` (read-only fingerprint: per-table counts, RLS/force flags, policies,
  triggers, migrations, every FK with validated flag and orphan count, rewinding security state; compare with named
  drift). TEST runs (`restore-verify-runs-2026-10-09.txt`): owner snapshot 9 s, 100 migrations, 53 tables, 71 FKs,
  0 orphans, 0 unvalidated; compare owner vs matflow_app fingerprint → FAIL on 3 counts changed by concurrent lanes,
  PASS with them named; negative control (policy, trigger, migration removed, 3 orphans, count) → FAIL listing all;
  production host refused without `--production-read-only`. Tables without RLS: GymApplication, Operator,
  PlatformConfig, RateLimitHit, StripeEvent, _prisma_migrations (platform tables; noted, not judged here).
- SEC-087 and SEC-084: runbook §3–§4 and REPORT.md.

## F-06 Both-role database run of the security set (SEC-088 evidence for TEST-EVIDENCE.md)
- First attempt: one vitest process over all 56 DB-backed files per role, JSON reporter, 40-minute ceiling → the owner
  pass hit the ceiling (exit 124) with no report; the runner was stopped. The vitest child it had spawned could not be
  terminated from this lane (the permission layer refused stopping the process; recorded, not retried) and may have
  run on against the TEST branch until it finished.
- Second attempt: 33 security DB files, one at a time, 300 s ceiling each, owner then matflow_app
  (`db-runs-first-pass-2026-10-09.txt`). 63 of 66 runs exit 0; 3 exit 1 with every test reported "skipped" — the cause
  was `connect ETIMEDOUT`/`ENETUNREACH` to the Neon host in `beforeAll`, not an assertion. All 3 passed on retry
  (`db-runs-final-2026-10-09.txt`). Final: 33/33 files exit 0 under both roles; `rls-foundation` under the owner role
  is 3 passed + 6 skipped by design (BYPASSRLS).
- Not run: `cron-smoke` (global retention sweep on a shared branch), `sec-b-fixture-sweep-db` (lane B's deletion
  sweep), and the non-security DB files.
- Whole suite, no database, second pass (HEAD `71cfe54` + working tree, finished 14:10 UTC): 495 files, 5,915 passed,
  33 failed (`import-attendance-route` 32, `sec-c-static-guards` 1 — lane D's in-progress importer; no lane F file),
  432 skipped/todo (57 DB-backed files). Lane F's own files: 51/51 (U) and 4/4 ×2 roles (I).
- Typecheck `npx tsc --noEmit` exit 0; `npx eslint` on every lane F file exit 0 (one pre-existing warning in
  lib/prisma.ts: unused `receiver` in the Proxy getter).
