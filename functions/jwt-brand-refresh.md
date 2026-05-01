# JWT Brand Refresh

> **Status:** ✅ Working (LB-004) · `BRAND_REFRESH_INTERVAL_MS = 5 * 60 * 1000` · `shouldRefreshBrand()` helper · refresh logic in `auth.ts` `jwt` callback.

## Purpose

Tenant branding (gym name, primary/secondary/text colour) is stamped onto the NextAuth JWT at sign-in time so every page can render the correct logo and colours without an extra DB roundtrip. But the JWT lives 30 days — without a refresh path, an owner editing their primary colour wouldn't see the change until they next signed out.

This module solves that: re-fetch tenant branding from the DB at most once every 5 minutes per session, and patch the JWT in place.

## Why not always re-fetch

Two pulls in opposite directions:

1. **Freshness** — branding changes should propagate within a useful time window
2. **Cost** — every API request triggers `auth()`, which triggers the `jwt` callback. A DB roundtrip on every request would be expensive and unnecessary

5 minutes is the chosen middle: changes show up within one coffee, and a tenant making 10k requests/hour doesn't generate 10k SELECTs.

## File — [lib/brand-refresh.ts](../lib/brand-refresh.ts)

```ts
// LB-004 (audit H10): JWT brand refresh threshold.
//
// Tenant branding (name, primaryColor, secondaryColor, textColor) is stamped
// onto the JWT at sign-in time, but the JWT lasts 30 days — so without a
// periodic refetch a settings change wouldn't propagate until the user logged
// out. We re-query the tenant table at most once every 5 minutes per session.

export const BRAND_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function shouldRefreshBrand(brandFetchedAt: number | undefined, now: number = Date.now()): boolean {
  if (!brandFetchedAt) return true;
  return now - brandFetchedAt > BRAND_REFRESH_INTERVAL_MS;
}
```

The whole API: one constant + one pure function. The pure function is testable in isolation — we don't have to mock the clock.

## Wiring in `auth.ts`

Inside the NextAuth `jwt` callback:

```ts
async jwt({ token, user, trigger }) {
  if (user) {
    // First sign-in — stamp everything from the user record
    token.tenantId = user.tenantId;
    token.tenantSlug = user.tenantSlug;
    token.role = user.role;
    token.primaryColor = user.primaryColor;
    token.secondaryColor = user.secondaryColor;
    token.textColor = user.textColor;
    token.tenantName = user.tenantName;
    token.brandFetchedAt = Date.now();
    return token;
  }

  // Subsequent requests — refresh branding if stale
  if (token.tenantId && shouldRefreshBrand(token.brandFetchedAt as number | undefined)) {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: token.tenantId as string },
        select: { name: true, primaryColor: true, secondaryColor: true, textColor: true },
      });
      if (tenant) {
        token.tenantName = tenant.name;
        token.primaryColor = tenant.primaryColor;
        token.secondaryColor = tenant.secondaryColor;
        token.textColor = tenant.textColor;
        token.brandFetchedAt = Date.now();
      }
    } catch {
      // Best-effort — keep stale brand rather than fail the request
    }
  }

  return token;
}
```

The `try/catch` is deliberate: a brand-refresh failure must never sign the user out or 500 the request. We just keep showing the stale colour until the next refresh attempt succeeds.

## What's refreshed (and what's NOT)

Refreshed (changes propagate within 5 min):
- `tenantName`
- `primaryColor` / `secondaryColor` / `textColor`

NOT refreshed (sticky for the JWT lifetime):
- `tenantId` (slugs / IDs don't change without a full reauth)
- `tenantSlug`
- `role` (role changes force session-version rotation — see [session-version-rotation.md](session-version-rotation.md))
- `userId` / `email` / `name`

This is intentional. The brand-refresh path is for cosmetic changes; security-relevant changes go through session version rotation, which actively invalidates old JWTs rather than passively refreshing them.

## What if the tenant is deleted mid-session?

`tenant` would be `null`, the inner `if (tenant)` skips the patch, and we keep showing whatever brand was last cached. Eventually the next API call to a real route would fail (`requireStaff` would not find the tenant's user) and route them out. We don't proactively kick them at the JWT layer.

## Test coverage

[tests/unit/jwt-brand-refresh.test.ts](../tests/unit/jwt-brand-refresh.test.ts) covers:

- `shouldRefreshBrand(undefined)` returns `true` (no prior fetch — refresh)
- `shouldRefreshBrand(now - 4min)` returns `false` (within window)
- `shouldRefreshBrand(now - 6min)` returns `true` (past window)
- Boundary at exactly 5 minutes returns `false` (`>`, not `>=`)
- Now-parameter override works for clock-mocking

The tests exist because the original H10 audit was specifically about ensuring the threshold was both correct AND testable. Pure-function helper makes both true.

## Why 5 minutes specifically

Trade-off space:

| Interval | Pros | Cons |
|---|---|---|
| 30 seconds | Near-realtime updates | 100x more DB queries vs 5min |
| 5 minutes | One owner-coffee window | Brand changes feel "near-instant" |
| 1 hour | Negligible DB load | Frustrating during launch-day brand tweaks |

5 minutes is comfortable for the most common scenario: owner tweaks brand, refreshes, sees the change.

If we ever surface a "Force refresh now" button for owners, that would be a session-version bump, not a brand-refresh tweak.

## Audit context

The original audit finding (H10) was: "JWT contains stale tenant branding for up to 30 days". The verdict was Medium severity (no security impact, just UX), so the fix was the lightweight 5-minute refresh rather than a hard session invalidation on every brand change.

The decision was captured in [docs/audit/LB-004.md](../docs/audit/LB-004-jwt-brand-refresh.md).

## Security

| Control | Where |
|---|---|
| Read-only refresh | We only read tenant branding — no writes from this path |
| Tenant scope | `where: {id: token.tenantId}` from the existing JWT — no privilege change possible |
| Best-effort | DB error → keep stale brand rather than fail the request |
| Bounded query frequency | 5-min throttle ensures no per-request hot path |
| No security-relevant fields refreshed | Role/permissions/tenantId are sticky — security changes go through session rotation instead |
| Pure function helper | Easy to unit-test, no clock dependency |

## Known limitations

- **5 minutes is hardcoded** — no per-tenant override (e.g. "premium tenants get 30s refresh"). Not requested.
- **Doesn't handle multi-instance freshness** — if tenant A user is on instance 1 and the brand-refresh writes to JWT, that JWT is whatever instance saw last. Multiple parallel tabs may show subtly different cached brands for ~5min until both refresh.
- **No "force refresh now" event** — owner editing brand has no signal to invalidate all sessions immediately. Would require session-version bump (heavier hammer).
- **Doesn't refresh `tenantSlug`** — slug changes are rare but would persist as stale until next sign-in.
- **Doesn't refresh `tenantName`** in the User row used for "fallback" rendering — only on the JWT itself. Pages using JWT data are fresh; pages re-querying via `prisma.user.findUnique` could see drift.
- **Pure function is module-level** — testing the wiring (auth callback) requires integration tests, which aren't comprehensive yet.

## Files

- [lib/brand-refresh.ts](../lib/brand-refresh.ts) — `shouldRefreshBrand()` + constant
- [auth.ts](../auth.ts) — `jwt` callback that wires it in
- [tests/unit/jwt-brand-refresh.test.ts](../tests/unit/jwt-brand-refresh.test.ts)
- [docs/audit/LB-004-jwt-brand-refresh.md](../docs/audit/LB-004-jwt-brand-refresh.md)
- See [session-and-cookies.md](session-and-cookies.md), [session-version-rotation.md](session-version-rotation.md), [settings-branding.md](settings-branding.md)
