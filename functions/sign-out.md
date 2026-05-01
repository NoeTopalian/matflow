# Sign-Out (Single Device + Logout-All)

> **Status:** ✅ Working · NextAuth `signOut()` clears the JWT cookie · "Logout all sessions" bumps `sessionVersion` to invalidate every existing JWT for that user.

## Purpose

Clear the local browser session. For paranoid users (or after a password reset / TOTP disable / suspected token theft), bump `sessionVersion` so every other device that was holding a JWT for this account is forced to re-authenticate on its next request.

## Surfaces

| Surface | Path |
|---|---|
| Single-device sign-out | Member portal: [/member/profile](../app/member/profile/page.tsx) "Sign Out" button. Owner: account menu in topbar |
| Logout-all | Settings → Account section (owner) — "Sign out everywhere" |

## Data model

```prisma
model User   { ... sessionVersion Int @default(0) ... }
model Member { ... sessionVersion Int @default(0) ... }
```

The JWT carries the value at sign-in time; the JWT callback re-checks DB on every refresh.

## API routes

### `POST /api/auth/signout` (NextAuth built-in)
Standard NextAuth — clears the session cookie locally. No DB write.

### `POST /api/auth/logout-all`
Authed (any role). Increments `User.sessionVersion` (or `Member.sessionVersion`):

```ts
await prisma.user.update({
  where: { id: session.user.id },
  data: { sessionVersion: { increment: 1 } },
});
```

Then triggers a local sign-out for the current device too. All other devices' JWTs now have a stale `sessionVersion` and will be rejected on next refresh.

## Flow

### Single-device
1. User clicks Sign Out → client calls `signOut({ callbackUrl: "/login" })` from `next-auth/react`
2. NextAuth POSTs to `/api/auth/signout` which clears the cookie
3. Browser redirects to `/login`
4. Other devices: unaffected — their JWTs are still valid for up to 30 days

### Logout-all
1. User clicks "Sign out everywhere" → confirm dialog → `POST /api/auth/logout-all`
2. Server bumps `sessionVersion` in DB
3. Server returns success → client `signOut()` locally
4. **Other devices**: on their next request, the JWT callback in [auth.ts:218-238](../auth.ts#L218) re-fetches `sessionVersion` from DB. If it doesn't match the value in the token, the callback returns `null`. NextAuth then treats the session as unauthenticated → next request hits `proxy.ts` → redirect to `/login`.

## Security

| Control | Where |
|---|---|
| sessionVersion enforcement | [auth.ts:218-238](../auth.ts#L218) — Node runtime only; Edge skips because Prisma is Node-only |
| Edge fallback | The next page-render in Node runtime catches it; protective lag is at most one Edge-only request |
| Audit | Logout-all should be `logAudit({ action: "auth.logout_all" })` — verify it's wired |
| Member vs User branch | `tokenMemberId` selects which table to query — same logic both sides |
| Demo-mode tokens | Skipped (token.tenantId === "demo-tenant") so dev fallback isn't broken |

## Known limitations

- **No "list active sessions" UI.** Users can't see *where* they're signed in. Logout-all is the only nuclear option. Per-device session tracking would require a `Session` table — currently using JWT-only for stateless scale.
- **Up to ~5 minutes of staleness** in some pathological cases — if a device only hits Edge-runtime routes (unlikely in practice; most pages are server-rendered Node).
- **Auto-logout on idle** is not implemented — sessions live for the full 30-day JWT TTL unless invalidated.

## Files

- [app/api/auth/logout-all/route.ts](../app/api/auth/logout-all/route.ts)
- [auth.ts](../auth.ts) — sessionVersion check at lines 218-238
- [app/member/profile/page.tsx](../app/member/profile/page.tsx) — member-side Sign Out button
- [components/layout/Topbar.tsx](../components/layout/Topbar.tsx) — staff topbar account menu
- See also [session-version-rotation.md](session-version-rotation.md) for all callers that bump
