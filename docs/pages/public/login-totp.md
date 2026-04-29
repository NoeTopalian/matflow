# /login/totp

| | |
|---|---|
| **File** | app/login/totp/page.tsx |
| **Section** | public |
| **Auth gating** | Not in PUBLIC_PREFIXES — proxy enforces auth; proxy also redirects `totpPending !== true` users away from this route back to `/dashboard` |
| **Roles allowed** | Any authenticated user with `totpPending === true` in their session JWT |
| **Status** | ✅ working |

## Purpose
Second factor verification step for users who have TOTP enabled. Presents a numeric 6-digit input. On submit, POSTs the code to `/api/auth/totp/verify`; on success the server clears `totpPending` and the page pushes to `/dashboard`. A "sign out and use a different account" button is available via `signOut({ callbackUrl: "/login" })`.

## Inbound links
- [/login](login.md) — `router.push("/login/totp")` after credential sign-in when `totpPending === true`
- proxy — redirects any non-`/login/totp` navigation when `totpPending === true`

## Outbound links
- [/dashboard](../dashboard/home.md) — `router.push("/dashboard")` on successful verification
- [/login](login.md) — `signOut({ callbackUrl: "/login" })` via sign-out button

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/totp/verify | Verify 6-digit TOTP code; clears `totpPending` on success |

## Sub-components
— (all UI inline in page file)

## Mobile / responsive
- Centred single-column layout, max-width `sm`. Works on all viewports.

## States handled
- Loading spinner while verifying.
- Error message (red text) on invalid code; input cleared and refocused.
- Network error message.
- Button disabled until exactly 6 digits entered.

## Known issues
— none

## Notes
The proxy (proxy.ts lines 33–41) enforces the TOTP gate: users with `totpPending === true` are forcibly redirected here from any other route. Users without `totpPending` who visit this URL are redirected to `/dashboard`. TOTP is enrolled via `/dashboard/settings`.
