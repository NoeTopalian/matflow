# Session & Cookies (NextAuth JWT Strategy)

> **Status:** ✅ Working · stateless JWT in an httpOnly cookie · 30-day max-age · brand info refreshed every 5 min on top of the token.

## Purpose

Stateless session via NextAuth v5's JWT strategy. No DB Session table — everything the app needs (user id, role, tenantId, branding, etc.) is encoded into a signed cookie. Brand info is refreshed periodically so settings changes propagate without forcing re-login (see [jwt-brand-refresh.md](jwt-brand-refresh.md)).

## NextAuth config (auth.ts)

```ts
session: {
  strategy: "jwt",
  maxAge: 30 * 24 * 60 * 60, // 30 days
},
pages: {
  signIn: "/login",
},
```

- **Strategy: jwt** — no Session table. NextAuth signs+encrypts the token with `NEXTAUTH_SECRET` (or `AUTH_SECRET`) and sets it as an httpOnly cookie.
- **Max-age 30 days** — sliding refresh on activity. Long-lived because re-auth UX hurts; offset by the `sessionVersion` revocation mechanism.
- **Cookie scope** — defaults: `httpOnly`, `sameSite=lax`, `secure` in production, no domain (host-only).

## JWT payload shape

After `jwt({token, user})` callback in [auth.ts:173-241](../auth.ts#L173), the token carries:

```ts
{
  id: string,                  // User.id or Member.id
  role: "owner"|"manager"|"coach"|"admin"|"member",
  sessionVersion: number,      // re-checked vs DB on every refresh — see session-version-rotation.md
  tenantId: string,
  tenantSlug: string,
  tenantName: string,
  primaryColor: string,        // refreshed every 5 min — see jwt-brand-refresh.md
  secondaryColor: string,
  textColor: string,
  memberId: string | null,     // null for staff
  totpPending: boolean,        // owner-only, see totp-2fa.md
  brandFetchedAt: number,      // unix-ms — used by the 5-min refresh check
}
```

The session callback in [auth.ts:242-260](../auth.ts#L242) projects this into `session.user.*`.

## NextAuth handlers

Three exports from `auth.ts`:

```ts
export const { handlers, auth, signIn, signOut } = NextAuth({...})
```

- `handlers` re-exported by [app/api/auth/[...nextauth]/route.ts](../app/api/auth/[...nextauth]/route.ts) → wires `GET/POST /api/auth/*` (signin, callback, csrf, signout, session)
- `auth()` — server-side session getter, used in route handlers and server components
- `signIn()` / `signOut()` — server-action helpers

## Type augmentation

[types/next-auth.d.ts](../types/next-auth.d.ts) declares the extended `Session.user` and `JWT` shapes so TypeScript sees `tenantId`, `role`, etc. instead of just `name | email | image`.

## Flow

### Sign-in
1. NextAuth Credentials authorize callback returns the user object (see [login-credentials.md](login-credentials.md))
2. JWT callback runs with `user` set — populates token from user fields, stamps `brandFetchedAt`
3. NextAuth signs token, sets `authjs.session-token` cookie (or `__Secure-authjs.session-token` in prod)
4. Browser holds the cookie for 30 days (or until manually cleared)

### Subsequent request
1. Browser sends cookie
2. NextAuth verifies signature, deserialises token
3. JWT callback runs without `user` — re-checks `sessionVersion` (Node only) and refreshes brand if stale
4. Session callback projects token → `session.user`
5. `auth()` in server code returns the session

### Sign-out
1. Client calls `signOut({ callbackUrl: "/login" })` from `next-auth/react`
2. NextAuth posts to `/api/auth/signout`, clears the cookie
3. Optional: client also POSTs `/api/auth/logout-all` to bump `sessionVersion` and force other devices off

## Security

| Control | Where |
|---|---|
| httpOnly cookie | NextAuth default — no JS access |
| sameSite=lax | Default — CSRF-resistant for top-level navigations |
| secure in production | Auto-set via `NEXTAUTH_URL` https detection |
| Signed + encrypted | `NEXTAUTH_SECRET` does both authenticity + confidentiality |
| sessionVersion check | Stateful revocation on top of stateless JWTs (see [session-version-rotation.md](session-version-rotation.md)) |
| 30-day expiry | Hard cap regardless of activity |
| Production secret enforcement | [auth.ts:20](../auth.ts#L20) throws if `NEXTAUTH_SECRET`/`AUTH_SECRET` unset in prod |

## Known limitations

- **JWT size grows linearly** with claims — tenant branding adds ~200 bytes per claim. Currently fine; would matter if we added `permissions: string[]` per role.
- **No silent token refresh** — when a user's role changes server-side, they keep the old JWT until next refresh OR a `sessionVersion` bump. The brand refresh path could be extended to also re-check role, but isn't today.
- **Cross-subdomain sessions not supported** — cookie is host-only. A `customDomain` per tenant would need cookie domain logic.

## Files

- [auth.ts](../auth.ts) — full NextAuth config
- [app/api/auth/[...nextauth]/route.ts](../app/api/auth/[...nextauth]/route.ts) — handlers re-export
- [types/next-auth.d.ts](../types/next-auth.d.ts) — type augmentation
- [lib/auth-secret.ts](../lib/auth-secret.ts) — secret helper
- [lib/brand-refresh.ts](../lib/brand-refresh.ts) — 5-min brand refresh helper
- [proxy.ts](../proxy.ts) — middleware that consumes the session
