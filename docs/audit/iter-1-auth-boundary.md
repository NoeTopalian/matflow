# Audit — Iteration 1, Area 2: Auth boundary

**Date**: 2026-05-30 (late session, post-Area-1)
**Scope**: `auth.ts`, `lib/{authz,csrf,rate-limit,operator-auth,admin-auth,login-event,recovery-codes,token-hash,auth-cookie,auth-secret,impersonation,login-fingerprint,brand-refresh}.ts`, `proxy.ts`, `app/api/auth/**`, `app/api/admin/auth/**`, `app/api/magic-link/**`, `app/api/member/totp/**`, `app/api/admin/customers/[id]/{force-password-reset,member-totp-reset}/**`
**Method**: 4 OMC subagents in parallel (code-reviewer, security-reviewer, verifier, scientist-perf). All returned full reports.
**Status**: **NOT converged.** 0 Critical, **10 unique High findings** after dedup.

## Convergence summary

| Agent | Critical | High | Medium | Low | Verdict |
|---|---|---|---|---|---|
| Code Reviewer | 0 | 3 | 6 | 5 | NOT GREEN |
| Security Reviewer | 0 | 4 | 5 | 3 | NOT GREEN |
| Verifier | 0 | 3 | 5 | 4 | NOT GREEN |
| Perf | 0 | 1 | 5 | 5 | NOT GREEN |

**Deduplicated NEW Critical**: 0.
**Deduplicated NEW High**: 10 (listed below).

The H2-3 stale-JWT finding from Area 1 iter-2 is **closed-as-architectural**: documented 10-minute window via `SESSION_VERSION_RECHECK_INTERVAL_MS`. Mitigation = every role-change path must bump `sessionVersion`. `app/api/staff/[id]/route.ts:49` already does. Confirmed in audit; verifies in Area 6 (operator/admin) where role-change UIs live.

---

## NEW Critical findings (iter-1)

None.

---

## NEW High findings (iter-1)

### AH-1 — Member TOTP setup POST missing `assertSameOrigin` CSRF guard
- **Location**: `app/api/member/totp/setup/route.ts:71` (POST handler entry)
- **Flagged by**: code-reviewer (H-A2-1), security-reviewer (M-1 upgraded), verifier (corroborating)
- **Issue**: The User-side `/api/auth/totp/setup` POST calls `assertSameOrigin(req)` first; the Member-side mirror does not. TOTP enrolment is account-takeover-adjacent: an attacker who triggers enrolment with their own secret can lock the legitimate member out if the member then verifies the attacker's code.
- **Fix**: Add `const v = assertSameOrigin(req); if (v) return v;` at the top of the POST handler.

### AH-2 — Member TOTP setup POST has TOCTOU race (read+verify+enable not atomic)
- **Location**: `app/api/member/totp/setup/route.ts:97-121`
- **Flagged by**: code-reviewer (H-A2-2), perf (L-A2-3)
- **Issue**: The User-side wraps read+verify+enable in one `withTenantContext` transaction. The Member-side does `findFirst` then `update` in two separate calls. A concurrent GET can overwrite `totpSecret` between the two, leaving `totpEnabled=true` with a mismatched secret.
- **Fix**: Mirror the User-side atomic pattern.

### AH-3 — Member password-reset flow is completely missing
- **Location**: `app/api/auth/forgot-password/route.ts:37` (only `tx.user.findFirst`), `app/api/auth/reset-password/route.ts:47` (same)
- **Flagged by**: verifier (H-A2-1)
- **Issue**: Members with passwords are valid login subjects (`auth.ts:317`), but both routes only look up `User`. A member who forgets their password gets a silent `{ ok: true }` and cannot self-service reset. No staff route exists either.
- **Fix**: Add `member` branch to both routes (lookup either User OR Member by `(tenantId, email)`; treat token recipient symmetrically).

### AH-4 — Member TOTP recovery + recovery-codes routes missing
- **Location**: `/api/auth/totp/recover` and `/api/auth/totp/recovery-codes` only handle `User` (`route.ts:71` + `route.ts:34`). No member equivalents under `/api/member/totp/`.
- **Flagged by**: code-reviewer (H-A2-3), verifier (H-A2-2)
- **Issue**: A member who enrolled in TOTP (via `/api/member/totp/setup`) and loses their device has no self-service recovery. The recover route silently returns `{ ok: true }` without acting.
- **Fix**: Either extend the staff routes to handle Member rows OR add mirror routes under `/api/member/totp/{recover,recovery-codes}`. The mirror approach is cleaner (clear separation of subject type, matches the existing pattern for setup/verify).

### AH-5 — No staff/admin route to unlock a locked Member account
- **Location**: `auth.ts:218-232` locks Members the same way as Users. `force-password-reset/route.ts:39` only finds owner-role Users. No `member-force-unlock` route exists.
- **Flagged by**: verifier (H-A2-3)
- **Issue**: A locked member must wait the full 1-hour TTL with no recovery path.
- **Fix**: Add `POST /api/members/[id]/unlock` (gated `requireStaff`) clearing `failedLoginCount: 0, lockedUntil: null`. Add audit-log entry.

### AH-6 — Operator lockout path has account-state timing leak
- **Location**: `lib/operator-auth.ts:197-199`
- **Flagged by**: security-reviewer (H-1)
- **Issue**: When operator account is locked, returns immediately (~1 ms) without running bcrypt — distinguishable from not-found (~250 ms bcrypt of dummy) and not-locked (~250 ms bcrypt of real hash). Attacker can enumerate locked vs non-locked operators by timing.
- **Fix**: Run bcrypt before the lockout check (mirror `auth.ts:199-211` pattern), then evaluate `isLocked` after constant-time comparison.

### AH-7 — Operator lockout retains `failedLoginCount` post-lock, enabling permadenial
- **Location**: `lib/operator-auth.ts:203-211`
- **Flagged by**: security-reviewer (H-2)
- **Issue**: When threshold hit, `failedLoginCount` increments to threshold but is never reset to 0 on lock. After 15-min TTL expires, the count is still ≥5; one more failed attempt re-locks immediately. Attacker can permadenial the operator with one attempt per 15 min.
- **Fix**: On lock, set `failedLoginCount: 0` (mirror `auth.ts:227` User pattern).

### AH-8 — `forgot-password` and `reset-password` lack Zod schema validation
- **Location**: `app/api/auth/forgot-password/route.ts:12`, `app/api/auth/reset-password/route.ts:19`
- **Flagged by**: security-reviewer (H-3)
- **Issue**: Both destructure `await req.json()` without validation. No bounds on email/tenantSlug/token; reset-password validates password but not the others. Inconsistent with every other pre-auth route (magic-link, totp/recover, admin login all use Zod).
- **Fix**: Add zod schemas matching the magic-link pattern: `email: z.string().email().max(120)`, `tenantSlug: z.string().min(1).max(60)`, etc.

### AH-9 — `forgot-password` leaks tenant existence via 404 on unknown tenant
- **Location**: `app/api/auth/forgot-password/route.ts:32`
- **Flagged by**: security-reviewer (H-4), code-reviewer (M-A2-1)
- **Issue**: Returns `{ error: "Gym not found." }` with status 404 when tenant slug is invalid — enables enumeration of all valid tenant slugs. `magic-link/request` correctly returns `{ ok: true }` opaquely.
- **Fix**: Return `{ ok: true }` regardless of tenant existence. Apply same fix to `reset-password:31`.

### AH-10 — Password-reset history check runs 8 serial bcrypt.compare on hot path
- **Location**: `app/api/auth/reset-password/route.ts:77-85`
- **Flagged by**: perf (H-A2-1)
- **Issue**: `for (const entry of history) { await bcrypt.compare(...) }`. Worst case = 8 × ~100 ms = ~800-900 ms CPU before the new hash. On Vercel Hobby's shared vCPU under burst load this is a DoS vector.
- **Fix**: `Promise.all(history.map(e => bcrypt.compare(password, e.passwordHash)))`. Bcrypt is async — parallelisation is safe and Node's libuv thread pool handles the parallel CPU work.

### AH-11 (upgraded from M-A2-3) — Operator login resets `failedLoginCount` BEFORE TOTP verify
- **Location**: `lib/operator-auth.ts:218-224` (the success-after-bcrypt path)
- **Flagged by**: code-reviewer (M-A2-3)
- **Severity**: **upgrade Medium → High** because this lets an attacker who knows the password brute-force the 6-digit TOTP code indefinitely (each attempt resets the lockout counter). The lockout exists specifically to prevent this attack class.
- **Fix**: Move the `failedLoginCount: 0, lockedUntil: null` reset into `completeOperatorLogin` (after TOTP verifies). The `attemptOperatorLogin` should only update `lastLoginAt` (or nothing at all) on bcrypt success — counter management belongs in the post-2FA completion path.

---

## NEW Medium findings (append to backlog-medium.md)

- **M2A2-1**: Account-lockout logic inlined in `auth.ts:101-273` (230+ lines, SRP). Extract to `lib/account-lockout.ts`.
- **M2A2-2**: Six routes import `verifySync` from otplib independently. Extract to `lib/totp.ts`.
- **M2A2-3**: `authz.ts` helpers use `redirect()` (page-only); API routes do inline auth. Document or split.
- **M2A2-4**: `forgot-password:76` `console.log` of OTP in dev mode (mask the value).
- **M2A2-5**: No TOTP code replay protection — no `lastUsedTotpStep` tracking on User/Member/Operator.
- **M2A2-6**: `admin-auth.ts:28` `constantTimeEq` leaks secret length via early return on length mismatch. Use HMAC-then-compare.
- **M2A2-7**: `reset-password` route missing rate limit (6-digit OTP, 2-min window — brute-forceable).
- **M2A2-8**: Reset-password OTP TTL is 2 minutes — too short for real email delivery. Increase to 10 min.
- **M2A2-9**: Magic-link bypasses TOTP for enrolled Users (`magic-link/verify:86`). Documented design choice; add `totpBypassed: true` to audit metadata.
- **M2A2-10**: `assertSameOrigin` not applied to `forgot-password` / `reset-password` (low risk; SameSite=Lax + rate-limit cover it).
- **M2A2-11**: `RateLimitHit` has no dedicated cleanup cron (5% probabilistic prune insufficient under attack). Add hourly DELETE cron.
- **M2A2-12**: `MagicLinkToken` / `PasswordResetToken` rows never hard-deleted (grow permanently). Add to same cleanup cron.
- **M2A2-13**: `checkDbRateLimit` does 4 trips (2×COUNT + 2×INSERT) on login. Collapse to 2 trips via multi-bucket COUNT.

## NEW Low findings (append to backlog-low.md)

- **L2A2-1**: `auth.ts:227` resets `failedLoginCount` to 0 on lock — fresh 10-attempt budget after lock expiry. Standard pattern but worth documenting.
- **L2A2-2**: `verifySync` return-type usage inconsistent across 6 routes (resolved by M2A2-2 extract).
- **L2A2-3**: `totp/verify` + `member/totp/verify` missing CSRF (lower risk than setup; add for consistency).
- **L2A2-4**: No unit tests for account-lockout logic.
- **L2A2-5**: No unit tests for CSRF rejection.
- **L2A2-6**: `forgot-password` IP-based rate limiting absent (per-email only).
- **L2A2-7**: Operator TOTP setup GET re-exposes pending secret if called twice (User-side regenerates).
- **L2A2-8**: `login.spec.ts:24` uses `password123` fallback (production password was rotated; will fail in CI without TEST_PASSWORD).
- **L2A2-9**: `loginEvent` upsert uses 2 trips (findFirst + update) on known-device path. Fire-and-forget; not user-visible.
- **L2A2-10**: TOTP setup GET does 2 separate `withTenantContext` calls (read + write). Collapse to one.
- **L2A2-11**: `Operator` model has no `@@index([lockedUntil])` (User + Member do). Inconsistent; <10 rows so cost is zero.
- **L2A2-12**: `buildAllowedOrigins` allocates new Set on every CSRF check. Memoise static portion.
- **L2A2-13**: Operator TOTP invalid-code 401 doesn't clear challenge cookie. Defensive nit.

---

## Fix plan (iter-1 → iter-2)

**Batch A — quick wins (high value, low risk, mostly localised changes)**:
- AH-1: CSRF on member TOTP setup (1-line)
- AH-2: Member TOTP setup atomic transaction (mirror staff pattern)
- AH-6: Operator timing leak (bcrypt-first, then check lock)
- AH-7: Operator lockout reset counter on lock
- AH-8: Zod on forgot/reset password (2 schemas)
- AH-9: Tenant existence anti-enumeration (return `{ ok: true }`)
- AH-10: Parallel bcrypt history check (`Promise.all`)
- AH-11: Operator login defer `failedLoginCount` reset to post-TOTP

**Batch B — member parity routes (new code, larger blast radius)**:
- AH-3: Member password reset (extend forgot/reset to handle Member subject)
- AH-4: Member TOTP recover + recovery-codes (mirror routes under `app/api/member/totp/`)
- AH-5: Member account unlock (`POST /api/members/[id]/unlock` staff-gated)

After Batch A + B land + static gates pass → iter-2 (re-spawn 4 agents) to verify convergence.
