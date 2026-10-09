# Lane A2 (iteration 2) — evidence log

Branch security/assurance-2026-10. HEAD at start 01dadef; it moved during the lane (6e75e03 lane E2 integration → daba6d7/5df9863 lane B2 incl. lib/prisma-tenant.ts → 2caa385 F2/R2 → 3bb4fb5 E3). No commit touched a lane A2 file; all lane A2 changes are uncommitted in the working tree. Runtime for EVERY run below: Node v24.21.0 (lead's binary `<scratchpad>/security/node24/node-v24.21.0-win-x64` first on PATH; `node -v` and HEAD are line 2 of each raw log). Raw logs: `<scratchpad>/security/A2/<label>.log` (label in the tables). Runner: `<scratchpad>/security/A2/run.sh <unit|unit-inline|owner|restricted> <label> <files>`; owner = att/run-engine.sh, restricted = q78/run-restricted.sh (matflow_app, RLS_ENFORCED=1); both refuse anything but the ep-hidden-salad TEST endpoint. Red runs: main tree before the edit, or a disposable worktree of 6e75e03 (pre-fix lane A code; node_modules junctioned; removed at the end) via run-wt.sh with the same guards.

Real next-auth in vitest needs `server.deps.inline: ["next-auth", "@auth/core"]` (next-auth/lib/env.js imports `next/server` without an extension; Node's ESM resolver refuses it for an externalised package; reviewer R used the same setting for R-1). `unit-inline` and the DB runs marked `-c a2` use the repository config plus that line (`<scratchpad>/security/A2/vitest.a2.config.ts`). Proposed: patches/vitest-inline-next-auth.patch. Full unit suite under that config: 434 files pass; the 14 failing files are exactly the companion set below plus sec-e3-ops-guards (lane E3's file, unrelated: `expected 9 to be 2`).

## SF-44 — unknown revocation verdict: retryable unavailable, cookie kept

| Run | Code | Files | Result | Exit |
|---|---|---|---|---|
| red-sf44-proxy | main tree before edit | unit-inline sec-a2-proxy-outage-cookie | 7 failed / 6 passed (13): `expected 401 to be 503`, `expected 'cleared' to be 'set'`, Edge pass `expected 200 to be 503` | 1 |
| red-sf44-proxy-db-{owner,restricted} | main tree before edit | sec-a2-outage-proxy-db -c a2 | 5 failed / 1 passed (6) each: `expected 401 to be 503`, `expected 307 to be 503` | 1 / 1 |
| red-sf44-handlers-db-{owner,restricted} | worktree 6e75e03 | sec-a2-outage-handlers-db | 4 failed / 2 passed (6) each: `a dependency failure does not clear the cookie: expected 'cleared' to be 'kept'` | 1 / 1 |
| green1-* | main tree after fix | the three files | 13/13; 6/6 each role; 6/6 each role | 0 |

Faults are the server's own (57014 via SET LOCAL statement_timeout + pg_sleep; 57P01 via pg_terminate_backend), one-shot, injected into the revocation lookup's transaction only; an ordinary read of the canary row succeeds in the same step (partial outage).

## SF-35 + SF-59 — lockout v2

| Run | Code | Files | Result | Exit |
|---|---|---|---|---|
| red-lockout-db-{owner,restricted} | worktree 6e75e03 | sec-a2-lockout-oracle-db | 4 failed / 1 passed (5) each. Oracle verbatim: account `refused x10, code:account_locked x2` vs no account `refused x12`; victim on a known device `code:account_locked`; distributed guessing never capped | 1 / 1 |
| red-lockout-flags | worktree 6e75e03 | unit sec-a2-lockout-flags | 16 failed / 9 passed (25): row lock → `code:account_locked`; "false" disabled the throttle on Vercel production/preview and on the production DB; bypass token ADMITTED with `x-forwarded-for: 127.0.0.1`, `x-real-ip: ::1`, and with no proxy headers (TESTING_MODE + token set); right password admitted with counters unreadable; IP-parity cases (module absent) | 1 |
| green1-* | main tree | both files | 5/5 each role; 25/25 | 0 |

## SF-36 — Google: no linking by email (interim refuse)

| Run | Code | Files | Result | Exit |
|---|---|---|---|---|
| red-google | worktree 6e75e03 | unit sec-a2-google-link | 3 failed / 3 passed (6): password-less member → `true` (signed in); staff → `true`; login event recorded | 1 |
| green1-google | main tree | same | 6/6 | 0 |

## SF-37 — verify routes check revocation; disown-login GET is inert

| Run | Code | Files | Result | Exit |
|---|---|---|---|---|
| red2-sf37-db-{owner,restricted} | worktree 6e75e03 | sec-a2-verify-disown-db | 7 failed (7) each: revoked pending token → 200, re-issued, code spent; DB fault → 200 (no check); disown GET → 307 + account locked; forged GET → 307. Positive control fails in red only because the pre-fix fault case spent that step's code (400). A first red/green pair had a harness bug (one-shot fault fired on the test's own helper read) — fixed and re-run | 1 / 1 |
| green2-sf37-db-{owner,restricted} | main tree | same | 7/7 each | 0 / 0 |
| sweep-unit-default | main tree | full tests/unit | sec-c-csrf-sweep caught the new disown POST without a same-origin check (`expected 303 to be 403`) → assertSameOrigin added; Referrer-Policy changed from no-referrer to same-origin (no-referrer makes the browser send `Origin: null` on the form POST) | — |

## SF-27 residual — member recovery race

| Run | Code | Files | Result | Exit |
|---|---|---|---|---|
| red-recover-db-{owner,restricted} | main tree before the route edit | sec-a2-member-recovery-race-db | 3 failed / 1 passed (4) each: two codes → both succeed, version +2; same code twice → two recoveries; no authenticator → version bumped | 1 / 1 |
| green1-recover-db-* | main tree after | same | 4/4 each | 0 / 0 |

## Mutants (fixed code, one protection removed, file restored byte-for-byte; `<scratchpad>/security/A2/mutants.py`, logs mutant-M1..M14)
All 14 KILLED: M1 marker never removed (1/13 fail) · M2 session() ignores marker (7/13) · M3 proxy has no unavailable branch (6/13) · M4 unknown → null again (6/13) · M5 no bound on the marker (1/13) · M6 harness allowed on Vercel (1/25) · M7 "false" honoured everywhere (3/25) · M8 lockout ignored (1/25) · M9 known-device exemption for all (DB owner 1/5) · M10 row lock with its own refusal (1/25) · M11 verify gate disabled (DB owner 4/8) · M12 Google link check bypassed (3/6) · M13 disown POST without CSRF (DB owner 2/8) · M14 disown claim unconditional (DB owner 1/8).

## Regression sweeps (final candidate code)
- sweep-unit-default (full tests/unit, repository config): 15 failed files / 432 passed — all 15 explained: 13 pin the old behaviour (companion patch), sec-a2-proxy-outage-cookie needs the inline config, sec-c-csrf-sweep (fixed in code since).
- companion-unit: the 13 companion-edited unit files + sec-c-csrf-sweep, run as temporary sec-a2-companion-* copies (deleted after): 14 files, 761 tests passed, exit 0.
- sweep-db-{owner,restricted}: 10 DB files (companion copy of sec-a-revocation-fail-closed-db, sec-a-recovery-code-race-db, totp-login-paths, login-email-change-db, account-editing-db, sec-a-token-subject-binding-db, sec-a-revoke-access-db, operator-member-totp-reset, staff-cannot-clear-user-totp, login-identity-claims-db): 80/84 each role; the 4 failures are fixtures minting a pending-TOTP JWT with no sessionVersion (companion #10). companion-db-{owner,restricted}: those two files with the fixture fix, 25/25 each.
- final-unit (inline): sec-a2 unit files 44/44; final-unit-default: 31/31; final-db-{owner,restricted} (-c a2): 5 files, 29/29 each role. All exit 0, HEAD 3bb4fb5, Node v24.21.0.
- tsc --noEmit (whole project): exit 0. eslint on lane files: 0 errors, 4 warnings (pre-existing unused `prisma` import in auth.ts; three underscore parameters of the link-store seam).

## Fixtures
Every DB file creates its own `secA2-<stamp>` club and deletes it with a count-checked teardown (0 left, asserted). Not swept: RateLimitHit rows written by the routes under test (HMAC-named `authfail:*` lockout buckets, `totp:<id>`, `disown:ip:<synthetic IP>`); the table has no tenant column, the rows are synthetic, expire with their one-hour window and are pruned by lib/rate-limit.ts.

## Refusal record
Writing docs/security/evidence/A2/REPORT.md was refused by the harness, verbatim: "Subagents should return findings as text, not write report files. Include this content in your final response instead." Not retried or routed elsewhere; the report is the lane's final message (the coordinator saves it).
