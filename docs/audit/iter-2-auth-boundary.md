# Audit — Iteration 2, Area 2: Auth boundary

**Date**: 2026-05-30 (post-Batch-A+B)
**Branch**: `audit/loop-fixes-02` HEAD `600f4d0`
**Scope**: same as iter-1 + the 2 new routes (`app/api/member/totp/recover/route.ts`, `app/api/members/[id]/unlock/route.ts`) + the extended forgot/reset routes.
**Method**: 4 OMC subagents in parallel. All returned full reports.
**Status**: **NOT converged.** 0 Critical, 2 confirmed NEW High + 1 contested.

## Iter-1 fix closures (all 11 verified by all 4 agents)

All 11 iter-1 High findings (AH-1..AH-11) are **closed**. Code-reviewer, security, verifier, and perf all corroborate. Specific verifications:
- AH-1: CSRF on member TOTP setup POST — `setup/route.ts:77-78`
- AH-2: Atomic member TOTP setup transaction — `setup/route.ts:113-128`
- AH-3: Member password reset extension — `forgot-password:52-65` + `reset-password:69-98`
- AH-4: Member TOTP recover route — `app/api/member/totp/recover/route.ts` (new)
- AH-5: Member unlock route — `app/api/members/[id]/unlock/route.ts` (new)
- AH-6: Operator bcrypt-before-lock — `operator-auth.ts:201-207`
- AH-7: Operator lockout counter reset — `operator-auth.ts:218-222`
- AH-8: Zod schemas on forgot/reset password — both routes
- AH-9: Tenant-existence anti-enumeration — both routes
- AH-10: Parallel bcrypt history check — `reset-password:122-130`
- AH-11: Operator counter reset deferred for TOTP operators — `operator-auth.ts:234-239`

## NEW High findings (iter-2)

### A2H2-1 — `member/totp/recover` non-atomic read-modify-write on `totpRecoveryCodes`
- **Flagged by**: security-reviewer (H-NEW-1), verifier (NEW-H-2), perf (PL2-2 hand-off)
- **Location**: `app/api/member/totp/recover/route.ts:83-117`
- **Issue**: The `member.findFirst` (line 83-88) and `member.update` (line 107-117) run in TWO separate `withTenantContext` calls. `consumeRecoveryCode` is a pure in-memory function. Two concurrent requests with two DIFFERENT valid recovery codes can each read the same `totpRecoveryCodes` array, each remove their respective code in-memory, and each write back. The second write overwrites the first — effectively un-consuming the first code. With 8 codes an attacker holding multiple valid codes could un-consume earlier codes.
- **Same pattern in User-side route**: `app/api/auth/totp/recover/route.ts:71-105` has the identical structure (flagged as M-NEW-2 in security report). Apply the same fix to both for parity.
- **Fix**: Merge findFirst + consumeRecoveryCode + member.update into a single `withTenantContext` transaction so the read-modify-write is atomic.

### A2H2-2 — Operator TOTP failures do not increment `failedLoginCount`; account-level lockout unreachable for TOTP-enabled operators
- **Flagged by**: security-reviewer (H-NEW-2), verifier (NEW-H-3)
- **Location**: `app/api/admin/auth/operator-totp/route.ts:87-88` (invalid code path returns 401 with no DB write)
- **Issue**: AH-11 correctly deferred the `failedLoginCount` reset to `completeOperatorLogin`. But `failedLoginCount` is only incremented on **bcrypt** failure in `attemptOperatorLogin` — TOTP-phase failures touch only the per-IP / per-operator `RateLimitHit` bucket (5/10min). For a TOTP-enabled operator the only persistent lockout (`Operator.lockedUntil`) is now unreachable via the TOTP brute-force path: attacker who knows the password can cycle `bcrypt success → 5 TOTP attempts → 10-min wait → repeat`. With IP rotation the per-IP bucket is also bypassed.
- **Fix**: In `operator-totp/route.ts`, on invalid TOTP code, increment `Operator.failedLoginCount` and apply lockout if threshold reached (mirroring `attemptOperatorLogin:210-224`). Same threshold (5), same TTL (15 min).

### A2H2-3 (contested) — `PasswordResetToken` has no `subjectKind` discriminator → shared-email reset always sets User password
- **Flagged by**: verifier (NEW-H-1) as High; security-reviewer (M-NEW-3) as Medium
- **Location**: `app/api/auth/forgot-password/route.ts:52-65` + `app/api/auth/reset-password/route.ts:69-98`
- **Issue**: When a User and a Member share the same email in the same tenant, the User wins precedence at reset-password lookup time. A Member who requests a reset receives an email and (when they submit the code) resets the User's password — not their own. The Member's password remains unchanged silently.
- **Severity discussion**: security-reviewer notes both subjects share the same email inbox so no privilege escalation occurs (no cross-account takeover). Verifier flags it because the behaviour is silently incorrect — the Member's intent (reset MY password) does not match the system outcome (User's password reset). Codebase-wide pattern: `auth.ts:187` also has User-wins at login. Treat as documented design consistent with login flow.
- **Decision**: **defer to backlog as Medium** with a proper fix proposal (add `subjectKind` column to `PasswordResetToken`). Add a code comment in forgot/reset routes documenting the User-wins precedence and the implication.

## Backlog additions

### NEW Medium (append to backlog-medium.md)
- **M-A2I2-1**: `PasswordResetToken` has no `subjectKind` column — shared-email member→user precedence is silent. Add `subjectKind` column + migration; on issue time, encode subject; on consume time, route directly.
- **M-A2I2-2**: User-side `app/api/auth/totp/recover/route.ts` has the same non-atomic read-modify-write as the new member-side route. The A2H2-1 fix should be applied to both routes.
- **PM2-1**: `reset-password` sequential resetToken → user → member fallback is parallelisable. Save ~10ms per Member-reset request. Match the `forgot-password` parallel pattern.
- **PM2-2**: `PasswordHistory.@@index([userId])` does not cover the `orderBy: { createdAt: "desc" } take: 8` query. Add composite `@@index([userId, createdAt])` so Postgres does an index-only-scan-then-LIMIT instead of in-memory sort.
- **M-A2I2-3 (pre-existing test-harness gaps)**: `reset-password-session-invalidation.test.ts`, `totp-recovery-codes.test.ts`, `security.test.ts` — 14 failures in vitest are pre-existing test-harness issues (mocks don't cover `withTenantContext` / `assertSameOrigin`). Not regressions from this PR. Fix mocks or convert to integration tests.

### NEW Low (append to backlog-low.md)
- **L-A2I2-1**: `member/totp/recover` failure-path `await logAudit(...)` is the only logAudit awaited in the codebase. Make fire-and-forget via `void logAudit(...).catch(() => {})` for consistency and to eliminate the weak timing oracle that distinguishes "email exists, code wrong" from "email doesn't exist".
- **L-A2I2-2**: AH-4 audit action naming asymmetry — `auth.member.totp.recovery.failed` vs User-side `auth.totp.recovery.failed`. Standardise.

## Fix plan (iter-2 → iter-3)

**Batch C** (this batch):
- **A2H2-1**: Atomic recover route — apply to BOTH `app/api/member/totp/recover/route.ts` AND `app/api/auth/totp/recover/route.ts`. Single withTenantContext per route wrapping findFirst + consume + update.
- **A2H2-2**: Increment `failedLoginCount` + check lockout on operator TOTP failure. Modify `app/api/admin/auth/operator-totp/route.ts`.
- **A2H2-3**: Add documenting code comment in forgot/reset routes about User-wins precedence; defer the schema fix to Medium backlog.

After Batch C lands + static gates pass → iter-3 to verify convergence (expect 0/0 to formally close Area 2 audit).
