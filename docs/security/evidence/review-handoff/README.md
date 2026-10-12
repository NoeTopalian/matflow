# Review hand-off: executable diff `704ab57..1ca92c0` (prepared 11 Oct 2026 15:20 Italy)

This directory exists so that a PERMITTED independent reviewer (a human, or a session that is not under the auto-mode classifier that issued D-9) can review lane L1's changes without rediscovery. No review has been performed by the coordinator; nothing here is a verdict. SF-135 and SF-136 stay FIXED AWAITING REVIEW until the reviewer files findings.

## Scope
- `704ab57..1ca92c0.lib-and-tests.diff` — the complete executable diff restricted to `lib/` and `tests/` (the 35 documentation files in the same range are evidence, not code). Library files changed: `lib/prisma-tenant.ts`, `lib/rate-limit.ts`, `lib/auth-lockout.ts`. Test files: 12 (6 new `sec-l1-*` integration/unit files, 6 adjusted).
- `BRIEF-R10.md` — the original review brief (paths to the session scratchpad replaced by `<scratchpad>`; the files it names there — RULES.md, BRIEF-L1.md — are reproduced in `docs/security/DENIALS.md` and `docs/security/evidence/L1/REPORT.md`).
- Implementer evidence: `docs/security/evidence/L1/REPORT.md` (cycles 1 and 2), `docs/security/evidence/L1/cycle2.txt` (the 24 bounded repeats of sec-c3, 15 FAILED, classified in `ITERATION-2-REPORT.md` §11), `docs/security/evidence/L1/patches/0001-prisma-pool-release-guard.diff` (proposed, NOT applied).
- Gates on `1ca92c0`: `docs/security/evidence/lead/gates-node24-1ca92c0.log` (lint 0, tsc 0, audit 0, build, unit 6554/6555 with the one known skip).

## Affected callers (counts at `1ca92c0`, excluding the three changed files)
- `withTenantContext`: 209 files
- `withRlsBypass`: 59 files
- `checkRateLimit`: 71 files
- The lockout reservation is reached only through `lib/auth-lockout.ts` exports consumed by `auth.ts` (credentials authorize) — confirm by reading, the grep above counts call sites by name only.

## What the review must establish (Noe's instruction of 11 Oct, sections 6)
1. Transaction-start failures: with Prisma's `maxWait` now out of reach, can a transaction that failed to start leave a connection open or a client checked out? Where is the start deadline, and what happens when it expires?
2. Statement and transaction deadlines: the transaction-local `lock_timeout` / `statement_timeout` bounds (5 s / 10 s / 15 s / 60 s) — honoured on every path; what the statement does after the bound; whether a `SET LOCAL` can itself hang.
3. Rollback completion: every error path rolls back exactly once, including the budget-exceeded error and errors thrown by the callback; no unawaited rollback remains anywhere.
4. Connection reuse after failures: no session-level state (GUCs, timeouts, lock) survives on a pooled connection reused by the next caller (D-6 forbids a pooled-connection MEASUREMENT that leaves session settings; verification must use transaction-local settings or the reviewer's own direct connections).
5. Counter atomicity: lockout reservation and rate-limit conditional insert remain single statements under the per-bucket advisory lock; no window between check and write.
6. Tenant-context cleanup: `app.current_tenant_id` / `app.bypass_rls` reset per transaction unchanged byte-for-byte relative to lane B2's reviewed behaviour.
7. Fail-closed behaviour: every failure of the store, the lock, or the budget is a refusal on the security buckets, never an admission; the typed errors (`LockoutReservationError`, `TenantTransactionBudgetError`) are mapped to refusals by every caller.
8. Timeout ownership: does the new design introduce an UNBOUNDED WAIT (a callback idle past its budget holds the pool connection until it returns; backstop only the server's `idle_in_transaction_session_timeout`, 5 min on TEST and UNVERIFIED in production) or merely move the original race from Prisma's timer to the server-side bound?
9. Persisted writes and reported outcomes under faults: for each injected fault (connection drop mid-transaction, lock timeout, statement timeout, budget exceeded, pool exhaustion) the row state after the fault matches the outcome the caller reported (no lost write, no phantom allow).

## Constraints on the reviewer
- TEST branch `ep-hidden-salad` only, own connections, bounded runs, own cleanup; never the pooled measurement denied under D-6; no production.
- Retain sec-c3's 15 failed runs as failures; a successful quiet-time probe does not resolve loaded-window capacity.
- `704ab57` is not a safe fallback: it predates the fixes.
- Verdict format as in earlier reviews: APPROVED / APPROVED WITH RESIDUALS / REJECTED, each finding with a reproducer and the exact file:line.
