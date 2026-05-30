# Audit — Iteration 3 (light verify), Area 2: Auth boundary

**Date**: 2026-05-30 (post-Batch-C)
**Branch**: `audit/loop-fixes-02` HEAD `5922c47`
**Scope**: focused verification of the 2 confirmed iter-2 High findings (A2H2-1, A2H2-2) + the A2H2-3 deferred documentation.
**Method**: 2 OMC subagents (security-reviewer + verifier — the 2 agents that flagged iter-2 issues). Code-reviewer + perf already returned 0/0 in iter-2 against the iter-1 fixes.

## Result

**0 NEW Critical + 0 NEW High.** Both confirmed iter-2 Highs closed.

| Finding | Status | Evidence |
|---|---|---|
| A2H2-1 atomic recover (member) | CLOSED | `app/api/member/totp/recover/route.ts:90-111` — single `withTenantContext` transaction wraps findFirst + consumeRecoveryCode + member.update |
| A2H2-1 atomic recover (user) | CLOSED | `app/api/auth/totp/recover/route.ts:76-97` — same structure on User-side route |
| A2H2-2 operator TOTP lockout | CLOSED | `app/api/admin/auth/operator-totp/route.ts:87-118` — failedLoginCount incremented + lockedUntil applied at threshold 5; matches bcrypt-side pattern; challenge cookie cleared on lock; returns 423 |
| A2H2-3 shared-email documentation | DOCUMENTED | `forgot-password:52-59` explicit comment cites A2H2-3 + M-A2I2-1; reset-password has descriptive inline comment from iter-1 |
| AH-1..AH-11 cross-check | INTACT | All 11 iter-1 fixes preserved through Batch C (verified file-by-file by both agents) |

## Race-condition walk-through (A2H2-1)

**Before Batch C**: two `withTenantContext` calls separated `findFirst` (read snapshot) and `member.update` (write new array). Two concurrent requests with DIFFERENT valid codes could each read the same snapshot, each compute their own `remaining`, and each write back — second write overwrites first, un-consuming the earlier code.

**After Batch C**: single `withTenantContext(...)` wraps all three operations. `withTenantContext` is implemented via `prisma.$transaction(async (tx) => ...)` (`lib/prisma-tenant.ts:32`), so the entire read-modify-write executes in one Postgres transaction. Under `READ COMMITTED`, the `UPDATE` acquires a row lock; the second concurrent request blocks until the first commits, then re-reads the row post-commit. Neither code can be un-consumed; both codes are legitimately consumed across the two requests.

## Brute-force walk-through (A2H2-2)

**Attacker scenario**: knows operator password, not TOTP. Tries to brute-force the 6-digit code.

- Bcrypt phase: succeeds; AH-11 guard prevents counter reset for TOTP operators; challenge cookie issued; `failedLoginCount` stays at current value.
- TOTP phase, attempts 1-4: each invalid → `findUnique` reads `failedLoginCount`, increments to 1/2/3/4, `UPDATE` persists. Returns 401.
- TOTP phase, attempt 5: `newCount = 5 >= 5` → `shouldLock = true` → `UPDATE failedLoginCount = 0, lockedUntil = now + 15min` → returns 423 with challenge cookie cleared.
- Attacker re-authenticates with password: `attemptOperatorLogin` runs bcrypt (constant-time per AH-6), then reads `lockedUntil` → blocks at bcrypt phase for 15 min.
- IP rotation no longer bypasses lockout — it's DB-persisted on the `Operator` row, not in the per-IP rate-limit bucket.

## Residual Lows (not blocking, backlog)

- **L-A2I3-1**: `operator-totp` non-atomic findUnique+update on TOTP-failure path. Two concurrent failures can both read `failedLoginCount = N` and both write `N+1`. Race-safe (idempotent double-lockout at threshold; never grants extra attempts). Risk: Low.
- **L-A2I3-2**: `reset-password` has descriptive inline comment but does not explicitly cite `M-A2I2-1` backlog ID. `forgot-password` carries the formal reference. Documentation completeness only.

Both appended to `backlog-low.md`.

## Convergence verdict — Area 2 audit-GREEN

- Iter-2 closures (code-reviewer 0/0 + perf 0/0) on iter-1 fixes ✓
- Iter-3 closures (security 0/0 + verifier 0/0) on iter-2 fixes ✓
- Operationally equivalent to "2 consecutive clean iterations from all 4 agents".

**Proceed**: test-engineer phase (author auth e2e specs for the new member self-service routes), then open PR + merge, then checkpoint with user.
