# Login (Email + Password)

> **Status:** ✅ Working · 2-step UX (slug → credentials) · constant-time bcrypt to defeat timing enumeration · dual-axis rate limiting (per-IP + per-account).

## Purpose

Authenticate staff (`User`) or member (`Member`) accounts with an email + password against a specific tenant. The "club code" first step resolves the tenant before the credentials screen — branding (colours, logo, font) is hydrated for the right gym before the user types anything secret.

## Surfaces

| Surface | Path | What |
|---|---|---|
| Slug entry | [/login](../app/login/page.tsx) (`GymCodeStep`) | Type "totalbjj" → 600 ms debounce auto-lookup OR press Continue → resolves Tenant |
| Credentials screen | [/login](../app/login/page.tsx) (`LoginStep`) | Email + password + show/hide toggle, "Email me a sign-in link", "Forgot password?" |
| TOTP gate | [/login/totp](../app/login/totp/page.tsx) | Owners with TOTP enabled hit this after a successful credentials submit |

## Data model

- `Tenant` resolved by `slug` (unique). Branding fields (`primaryColor`, `secondaryColor`, `textColor`, `fontFamily`, `logoUrl`) are stamped onto the JWT at sign-in.
- `User` (staff): `@@unique([tenantId, email])`. `passwordHash` (bcrypt 12 rounds), `role` ∈ {owner, manager, coach, admin}, `sessionVersion` (Int, bumped to force sign-out), `totpSecret` + `totpEnabled`.
- `Member` (mobile/member): same `@@unique([tenantId, email])`, optional `passwordHash` (kid sub-accounts have none — passwordless), `sessionVersion`.

## Flow

1. **Slug step** — User types tenant code → [`lib/login-lookup.ts`](../lib/login-lookup.ts) hits `GET /api/tenant/[slug]` → returns branding. Local-storage cache (`gym-settings` key) merged on top to prevent flicker on return visits.
2. **Credentials submit** — Client calls NextAuth `signIn("credentials", { tenantSlug, email, password, redirect: false })`.
3. **`Credentials.authorize` callback in [auth.ts](../auth.ts)**:
   - Zod-validates `{ email, password ≥ 8, tenantSlug }` ([line 24-28](../auth.ts#L24)).
   - Two rate-limit buckets in parallel via `Promise.all` ([line 64-71](../auth.ts#L64)):
     - `login:ip:{ip}` — 30 attempts / 30 min (cross-tenant brute-force)
     - `login:{tenantSlug}:{email}` — 5 attempts / 15 min (account-targeted)
   - Looks up `User` and `Member` in parallel — most logins are members so doing both upfront saves a round-trip on the common path ([line 83-90](../auth.ts#L83)).
   - **Constant-time bcrypt** — always runs `bcrypt.compare(password, hash)` even when no record exists, against a pre-computed `DUMMY_HASH` ([line 10](../auth.ts#L10)). Without this, response time would leak account existence.
   - On match: returns the user shape with role + sessionVersion + tenant branding stamped.
4. **JWT callback** persists role, tenantId, primaryColor, etc. on the token (30-day maxAge). For owners with `totpEnabled === true`, `totpPending: true` is set — the proxy then redirects to `/login/totp` until verified.
5. **Redirect** — Member → `/member/home`. Staff → `/dashboard`. Owner with TOTP pending → `/login/totp` (proxy.ts handles this).

## Security posture

| Control | Where |
|---|---|
| Constant-time bcrypt fallback | [auth.ts:10, :96-101](../auth.ts#L10) |
| Per-IP rate limit | [auth.ts:67](../auth.ts#L67) — 30 / 30 min, bucket `login:ip:{ip}` |
| Per-account rate limit | [auth.ts:68](../auth.ts#L68) — 5 / 15 min, bucket `login:{slug}:{email}` |
| Tenant-scoped lookup | `findUnique({ tenantId_email })` — enforces tenant boundary before bcrypt |
| Demo-mode hard-block | [auth.ts:17-19](../auth.ts#L17) — throws if `DEMO_MODE=true` in production |
| Production secret enforcement | [auth.ts:20](../auth.ts#L20) — throws if no `NEXTAUTH_SECRET`/`AUTH_SECRET` |
| Session strategy | JWT, 30-day maxAge ([auth.ts:46](../auth.ts#L46)) — no DB session table |
| sessionVersion enforcement | Every JWT refresh re-checks `User.sessionVersion`/`Member.sessionVersion` (Node runtime only — Edge skips per [auth.ts:218-238](../auth.ts#L218)) |

## Known limitations

- **No email verification at sign-up.** Members are created either by staff (with invite link, see [accept-invite.md](accept-invite.md)) or via `/apply` flow — both manual paths. Self-service signup with email confirmation is not built.
- **8-char minimum** at the login Zod schema, but reset-password requires 10 chars + complexity (mismatch). Won't bite unless a legacy account has an 8-char password from before the policy tightened.
- **No CAPTCHA** on the login form — relies entirely on rate limits. Determined attackers can rotate IPs.

## Test coverage

- [tests/unit/login-branding-race.test.ts](../tests/unit/login-branding-race.test.ts) — debounced lookup race conditions
- [tests/unit/auth-rate-limit.test.ts](../tests/unit/auth-rate-limit.test.ts) — verifies dual buckets fire (if present)
- E2E [tests/e2e/auth/login.spec.ts](../tests/e2e/auth/login.spec.ts)

## Files

**Page** — [app/login/page.tsx](../app/login/page.tsx) (`GymCodeStep` + `LoginStep` + `ForgotStep` + `ResetStep`)
**Auth core** — [auth.ts](../auth.ts), [lib/login-lookup.ts](../lib/login-lookup.ts), [lib/auth-secret.ts](../lib/auth-secret.ts)
**Tenant resolve** — [app/api/tenant/[slug]/route.ts](../app/api/tenant/[slug]/route.ts)
**Proxy** — [proxy.ts](../proxy.ts)
