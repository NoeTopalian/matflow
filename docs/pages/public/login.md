# /login

| | |
|---|---|
| **File** | app/login/page.tsx |
| **Section** | public |
| **Auth gating** | PUBLIC_PREFIXES includes `/login` — no auth required |
| **Roles allowed** | unauthenticated (redirected away once signed in) |
| **Status** | ✅ working |

## Purpose
Three-step authentication flow: (1) club code entry that resolves the gym's branding via `/api/tenant/[slug]`; (2) email + password sign-in with `next-auth signIn("credentials")`; (3) forgot-password sub-flow (ForgotStep → ResetStep) that emails a 6-digit OTP via `/api/auth/forgot-password` and accepts the OTP + new password via `/api/auth/reset-password`. After successful login, members are sent to `/member/home`, staff to `/dashboard`, and users with `totpPending` to `/login/totp`. Supports `?club=<slug>` and `?email=<email>` query params to pre-populate steps.

## Inbound links
- [/apply](apply.md) — "Back to sign in" link after application submitted
- [/login/totp](login-totp.md) — sign-out button sends users back here

## Outbound links
- [/apply](apply.md) — "Apply for Account Creation" link on club-code step
- [/login/totp](login-totp.md) — `router.push("/login/totp")` when `totpPending === true`
- [/member/home](../member/home.md) — `router.push("/member/home")` for role `member`
- [/dashboard](../dashboard/home.md) — `router.push("/dashboard")` for staff roles

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/tenant/[slug] | Resolve club code to gym branding (name, logo, colors) |
| POST | /api/auth/forgot-password | Send 6-digit reset OTP to member email |
| POST | /api/auth/reset-password | Verify OTP and set new password |
| POST | /api/auth/signin (next-auth) | Credential sign-in via `signIn("credentials", ...)` |

## Sub-components
All four steps (`GymCodeStep`, `LoginStep`, `ForgotStep`, `ResetStep`) are defined inline in the same file — no external component imports.

## Mobile / responsive
- Full-screen dark layout (`min-h-screen`). Single-column, max-width 360 px centred. Works on all viewports. No breakpoint classes — mobile-first by default.

## States handled
- Loading spinners on every async action.
- Error messages displayed inline beneath the relevant field.
- `autoSending` spinner shown while OTP is auto-dispatched when a valid email was pre-filled.
- `done` state in ResetStep shows success screen.

## Known issues
- **P3** — OTP input uses `inputMode="text"` (should be `inputMode="numeric"`) — see docs/AUDIT-2026-04-27.md WP-G.
- **P1 open** — Email delivery depends on `RESEND_API_KEY` being set; forgot-password flow silently fails if key is absent — see PRODUCTION_QA_AUDIT.md.

## Notes
The `?club=` query param enables deep-linking directly to step 2 (e.g. from a gym's website). Demo tenants (`gym.demo === true`) short-circuit sign-in and push directly to `/member/home`.
