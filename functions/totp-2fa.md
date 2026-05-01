# TOTP Two-Factor Authentication

> **Status:** ✅ Working · owner-only · TOTP shared secret stored on `User`, verified via `otplib` · enforced as a post-login `totpPending` gate in the JWT.

## Purpose

Add a second factor (TOTP / Google Authenticator / 1Password / etc.) to owner accounts only. After a successful credentials login, owners with `totpEnabled=true` are redirected to `/login/totp` and must enter a 6-digit code before any dashboard route works.

## Surfaces

| Surface | Path |
|---|---|
| Setup drawer | Settings → Account → "Two-Factor Authentication" → "Set up" button | [`SettingsPage.tsx`](../components/dashboard/SettingsPage.tsx) Account section
| Disable drawer | Same panel after enabled — "Disable 2FA" button (re-verifies code first) |
| TOTP gate page | [/login/totp](../app/login/totp/page.tsx) — single 6-digit input with auto-submit on length |

## Data model

```prisma
model User {
  ...
  totpSecret  String?   // base32-encoded shared secret
  totpEnabled Boolean   @default(false)
  ...
}
```

JWT carries `totpPending: boolean` after sign-in.

## API routes

### `POST /api/auth/totp/setup`
Owner only. Generates a fresh shared secret + provisioning URI:

- `otplib.authenticator.generateSecret()` → 32-char base32
- Returns `{ secret, qrUrl }` — qrUrl is the `otpauth://totp/MatFlow:{email}?secret=...&issuer=MatFlow` URI for the QR code
- Stashes the secret in a temporary place (could be the User row with `totpEnabled=false`, OR a separate setup table) — verify behaviour by reading the route

### `POST /api/auth/totp/verify`
Owner only. Body: `{ code }`.

- Rate-limit per-user (5 / 10 min)
- `otplib.authenticator.verify({ secret: user.totpSecret, token: code })` — accepts ±1 step (~30 sec window)
- On success: sets `User.totpEnabled = true`, clears the JWT's `totpPending` flag (caller resigns or refresh)
- Used both for first-time setup (after scanning QR) AND for the per-login gate at `/login/totp`

### `POST /api/auth/totp/disable`
Owner only. Body: `{ code }`.

- Re-verifies the code first (defense against session-hijack disabling 2FA silently)
- Clears `totpSecret`, sets `totpEnabled=false`
- Bumps `sessionVersion` to force all devices to re-auth

## Flow

### Enable
1. Owner → Settings → Account → Set up
2. Drawer fetches `/api/auth/totp/setup` → shows QR code (rendered via [qrcode](https://www.npmjs.com/package/qrcode) lib client-side)
3. Owner scans QR in their authenticator app
4. Drawer prompts for first 6-digit code → `POST /api/auth/totp/verify`
5. Server marks `totpEnabled=true`, drawer closes, panel shows "2FA enabled" state

### Login gate
1. Owner with `totpEnabled` signs in via credentials
2. JWT callback in [auth.ts](../auth.ts) sets `token.totpPending = true` ([line 121](../auth.ts#L121))
3. Proxy ([proxy.ts](../proxy.ts) lines 36-42) redirects to `/login/totp` for any non-`/login/totp` path
4. User enters code → `POST /api/auth/totp/verify` → `totpPending=false` → next request lands on `/dashboard`

### Disable
1. Owner re-enters current code in disable drawer → `POST /api/auth/totp/disable`
2. `totpSecret` cleared, `totpEnabled=false`, `sessionVersion++`
3. All other sessions for this user are invalidated; current session continues

## Security

| Control | Where |
|---|---|
| TOTP standard | RFC 6238 via `otplib` — 30-sec window, SHA1, 6-digit |
| Rate-limit on verify | 5 attempts / 10 min — prevents code brute-force (10⁶ space) |
| Rate-limit on disable | Same bucket — code re-verified before clearing |
| Owner-only enforcement | `requireOwner()` on all 3 routes |
| sessionVersion bump on disable | Forces re-auth across devices when 2FA removed |
| Secret storage | Plaintext base32 in DB column (stretch: encrypt with `lib/encryption.ts` — currently not done) |
| Edge runtime aware | TOTP gate enforced via `proxy.ts` which runs on Edge — JWT `totpPending` flag drives the redirect without DB hit |

## Known limitations

- **Secret stored unencrypted.** Database breach = TOTP bypass. Encrypting via `lib/encryption.ts` (AES-256-GCM) would harden this — schema-only change.
- **No backup codes.** Owner who loses their authenticator must contact support. Worth implementing single-use recovery codes (`User.totpBackupCodes` Json array of bcrypt-hashed codes).
- **Owners only.** Members and other staff roles (manager, coach, admin) cannot enable TOTP. By design today; could be expanded.
- **No WebAuthn / hardware keys.** TOTP only. WebAuthn would be a significant additional integration.

## Files

- [app/api/auth/totp/setup/route.ts](../app/api/auth/totp/setup/route.ts)
- [app/api/auth/totp/verify/route.ts](../app/api/auth/totp/verify/route.ts)
- [app/api/auth/totp/disable/route.ts](../app/api/auth/totp/disable/route.ts)
- [app/login/totp/page.tsx](../app/login/totp/page.tsx) — 6-digit input gate
- [components/dashboard/SettingsPage.tsx](../components/dashboard/SettingsPage.tsx) — Account tab setup/disable drawer
- [auth.ts](../auth.ts) — `totpPending` JWT flag
- [proxy.ts](../proxy.ts) — TOTP gate redirect
