# Session Version Rotation (Forced Sign-Outs)

> **Status:** ✅ Working · monotonic counter on `User`/`Member` re-checked on every JWT refresh in Node runtime · the primary mechanism for forcing all devices to re-authenticate.

## Purpose

Stateless JWTs are great for scale but can't be revoked once issued. To work around this, every JWT carries the user's `sessionVersion` at sign-in time; the JWT refresh callback re-fetches the current value from the DB and rejects any token whose embedded version doesn't match. Bumping `sessionVersion` therefore acts as a "logout this user from everywhere".

## How it works

### At sign-in
The Credentials callback in [auth.ts:104-119](../auth.ts#L104) stamps `token.sessionVersion = user.sessionVersion` onto the JWT.

### On every JWT refresh
The `jwt({token, user})` callback in [auth.ts:218-238](../auth.ts#L218) runs on every request that needs the session:

```ts
if (
  process.env.NEXT_RUNTIME !== "edge" &&
  token.id && token.tenantId && token.tenantId !== "demo-tenant"
) {
  try {
    const tokenMemberId = token.memberId as string | null;
    const currentVersion = tokenMemberId
      ? (await prisma.member.findUnique({
          where: { id: tokenMemberId },
          select: { sessionVersion: true },
        }))?.sessionVersion
      : (await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { sessionVersion: true },
        }))?.sessionVersion;

    if (currentVersion !== undefined && currentVersion !== token.sessionVersion) {
      return null;  // ← invalidates the token
    }
  } catch { /* DB transient — keep token */ }
}
```

The session callback at [auth.ts:242](../auth.ts#L242) recognises a `null` return and produces an empty session, which `proxy.ts` then treats as unauthenticated → redirect to `/login`.

### Edge runtime exception
Prisma can't run in the Edge runtime. The middleware (proxy.ts) runs on Edge and therefore can't enforce the version check itself. The protective gap is closed by the next Node-runtime request (server component, API route, page render) — which IS guaranteed for any meaningful navigation.

## Callers that bump `sessionVersion`

| Caller | Purpose |
|---|---|
| `POST /api/auth/logout-all` | Explicit "sign out everywhere" |
| `POST /api/auth/reset-password` | Forgot-password flow — invalidates other devices on success |
| `POST /api/members/accept-invite` | First-time signup completes — invalidates any prior token (defensive) |
| `POST /api/auth/totp/disable` | Removing 2FA — forces re-auth so attackers who silently disabled it are kicked too |
| `POST /api/staff/[id]` | Optional: when a staff role changes, bump so the JWT's role claim is forced to refresh |
| Direct DB `UPDATE` | Owner can run an SQL bump in emergencies |

## Security

| Control | Where |
|---|---|
| Node-only check | Prisma adapter doesn't run in Edge — see `process.env.NEXT_RUNTIME !== "edge"` guard |
| DB-transient grace | `try/catch` keeps the token alive on transient DB errors — preferable to mass logout on a Postgres blip |
| Demo tenant skip | `token.tenantId !== "demo-tenant"` — dev fallback paths don't need real version checks |
| Member vs User selector | `tokenMemberId` discriminates which table to query — single-query path |
| No version-mismatch leak | Session callback returns empty session, never errors back to the client |

## Performance

Each JWT refresh runs one Prisma `findUnique` on the User or Member table by primary key — single-row lookup, hits the b-tree index. Effectively free (<5ms p99) compared to the full request cost.

If you're worried, the obvious optimisation is to cache the `(memberId, sessionVersion)` tuple in the JWT itself with a short TTL (e.g. 1 min) — only re-check after that. Not currently done since the lookup is so cheap.

## Known limitations

- **Edge-only routes lag** — pure Edge requests don't enforce. In practice every navigation eventually hits a Node route, so the lag is bounded.
- **No "log me out of THIS device" granularity** — the check is binary (token version matches or doesn't). Per-device tracking would need a `Session` table.
- **No event log** of why a sessionVersion was bumped. Adding `User.lastVersionBumpReason` would help debugging "why am I randomly signed out?" complaints.

## Files

- [auth.ts](../auth.ts) — JWT callback at lines 218-238 (the enforcement)
- [app/api/auth/logout-all/route.ts](../app/api/auth/logout-all/route.ts)
- [app/api/auth/reset-password/route.ts](../app/api/auth/reset-password/route.ts)
- [app/api/members/accept-invite/route.ts](../app/api/members/accept-invite/route.ts) — `sessionVersion: { increment: 1 }`
- [app/api/auth/totp/disable/route.ts](../app/api/auth/totp/disable/route.ts)
- [prisma/schema.prisma](../prisma/schema.prisma) — `User.sessionVersion` + `Member.sessionVersion`
