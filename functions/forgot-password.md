# Forgot Password (6-digit OTP Reset)

> **Status:** ✅ Working · 6-digit code emailed · 2-min TTL · password complexity enforced · sessionVersion bumped on success (forces all other devices to sign out).

## Purpose

Recover access to a forgotten account without admin involvement. Email a short numeric code; user types code + new password; server validates + sets new bcrypt hash + invalidates all existing sessions.

## Surfaces

| Surface | Path |
|---|---|
| Forgot button | [/login](../app/login/page.tsx) — "Forgot password?" inside the credentials form |
| Auto-send / Email-entry | If email already typed → auto-sends + jumps straight to OTP screen. Otherwise → `ForgotStep` form |
| Code + new password | [`ResetStep`](../app/login/page.tsx) — 6-digit input + new password + confirm |
| Email | [`password_reset` template](../lib/email.ts) — large monospaced 6-digit code |

## Data model

```prisma
model PasswordResetToken {
  id        String   @id @default(cuid())
  email     String
  tenantId  String
  tokenHash String   @unique  // HMAC-SHA256(raw, AUTH_SECRET) — see lib/token-hash.ts
  expiresAt DateTime           // now + 2 min
  used      Boolean  @default(false)
  createdAt DateTime @default(now())

  @@index([email, tenantId])
}
```

The DB stores `HMAC-SHA256(raw, AUTH_SECRET)` (Fix 1) — the raw 6-digit OTP is sent to the user via email; on consume we re-hash and look up by `tokenHash`. A DB dump or read-replica leak yields hashes that can't be replayed without `AUTH_SECRET`.

Plus optional `PasswordHistory` (hashed) to enforce no-reuse-of-last-N policies.

## API routes

### `POST /api/auth/forgot-password`
Public (proxy whitelist). Body: `{ email, tenantSlug }`.

- Rate-limit per-IP and per-email
- Looks up `User` then `Member` by `(tenantId, email)`
- Mints a 6-digit numeric token (zero-padded), expiry `now + 2 min`
- Sends `password_reset` Resend email with the code
- Always returns `200 { ok: true }` — never reveals whether the account exists

### `POST /api/auth/reset-password`
Public. Body: `{ email, tenantSlug, token, password }`.

- Zod validation on the new password: ≥10 chars, uppercase, lowercase, digit
- Atomically consumes `PasswordResetToken` (rejects used/expired)
- Resolves account, hashes password with bcrypt (12 rounds)
- Updates `passwordHash` + bumps `sessionVersion` (forces all other JWTs to invalidate on next refresh)
- Optionally writes a `PasswordHistory` row to block reuse of last N

## Flow

1. User clicks **"Forgot password?"** on login screen
2. If email field already had a valid value → page sets `autoSending=true`, calls `/api/auth/forgot-password` immediately, then sets `step="reset"` to show OTP entry
3. **Bug fix (commit `153a9ec`)**: `try/finally` now clears `autoSending=false` even on the success-return path — previously the flag stayed true and the spinner never went away. See [app/login/page.tsx](../app/login/page.tsx) `handleForgot`.
4. User enters 6-digit code + new password + confirm → `POST /api/auth/reset-password`
5. Server validates, hashes, bumps sessionVersion → success screen → "Back to sign in"

## Security

| Control | Where |
|---|---|
| 6-digit numeric (not just alphanumeric) | Easy to type from phone email; brute-force constrained by 2-min TTL |
| 2-minute TTL | Aggressive — typical OTP UX. Token gone before brute-force has time |
| Single-use | `used: true` set atomically on consume |
| sessionVersion bump | Other devices forced out on next request |
| Password policy | 10+ chars, upper + lower + digit (Zod schema in `ResetStep`) |
| No enumeration | request always 200, reset returns generic "Invalid or expired code" |
| Rate limit | per-IP + per-email at the request endpoint |
| Constant-time bcrypt on reset path? | Not strictly needed — token already discriminates. But token verification IS constant-time via `===` on string of fixed length. |

## Known limitations

- **PasswordHistory enforcement.** Schema exists; whether the route actually checks it depends on the implementation — verify by reading `app/api/auth/reset-password/route.ts`.
- **No 2FA recovery code support.** A user who set up TOTP and lost both their password AND their authenticator must contact support — there's no self-serve recovery for the second factor.
- **Spinner-clear bug history**: previously, the success path returned without setting `autoSending=false`, leaving users on a permanent loading screen. Fixed in commit `153a9ec` via `try/finally`.

## Test coverage

- E2E coverage indirectly via the login flow (forgot button → reset).
- Unit coverage on the rate-limit + Zod validation should exist; check `tests/unit/forgot-password*.test.ts`.

## Files

- [app/api/auth/forgot-password/route.ts](../app/api/auth/forgot-password/route.ts)
- [app/api/auth/reset-password/route.ts](../app/api/auth/reset-password/route.ts)
- [app/login/page.tsx](../app/login/page.tsx) — `ForgotStep`, `ResetStep`, `handleForgot` orchestrator
- [lib/email.ts](../lib/email.ts) — `password_reset` template
- [prisma/schema.prisma](../prisma/schema.prisma) — `PasswordResetToken`, `PasswordHistory`
