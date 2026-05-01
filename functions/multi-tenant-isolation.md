# Multi-Tenant Isolation

> **Status:** ✅ Working · `tenantId` on every model · scoped session JWT · API helpers enforce scope · CHECK constraints + composite uniques at the DB layer.

## Purpose

Multi-tenant means: one Postgres database, one Next.js deployment, many gyms — each gym sees only its own members, payments, classes, settings. A bug here doesn't just leak data; it can leak everyone's data to everyone. The whole platform's trust model rests on this one invariant: **no row from tenant A is ever read or written by tenant B.**

This document is the load-bearing summary of how that invariant is maintained across the schema, the session, the API, and the DB.

## The four layers of isolation

### Layer 1 — Schema

Every model carries `tenantId String`. Every relevant index or unique constraint is *composite* with `tenantId`:

```prisma
model Member {
  tenantId String
  email    String
  ...
  @@unique([tenantId, email])      // two gyms can each have alice@example.com
  @@index([tenantId, status])
}

model Class {
  tenantId String
  name     String
  ...
  @@unique([tenantId, name])
}

model RankSystem {
  tenantId   String
  discipline String
  name       String
  ...
  @@unique([tenantId, discipline, name])
}
```

Without composite uniques, two gyms couldn't both have a member named alice@example.com. With them, the constraint enforces uniqueness *within a tenant* and explicitly *across tenants* it's allowed.

The reverse holds for FKs: every relation goes through `tenantId` somewhere — either directly or transitively via Member/User/Class.

### Layer 2 — Session

The NextAuth JWT carries `tenantId` (and `tenantSlug`, `role`, `primaryColor`):

```ts
// auth.ts callbacks.jwt
async jwt({ token, user, trigger }) {
  if (user) {
    token.tenantId = user.tenantId;
    token.tenantSlug = user.tenantSlug;
    token.role = user.role;
    ...
  }
  ...
  return token;
}
```

The user has no path to change `tenantId` mid-session — it's signed into the JWT at login time. Cross-tenant takeover would require forging the JWT, which requires `AUTH_SECRET`.

### Layer 3 — API helpers

Every API route starts with one of these helpers from [lib/authz.ts](../lib/authz.ts):

```ts
export async function requireStaff() {
  const session = await auth();
  if (!session?.user) throw new HttpError(401, "Unauthorised");
  if (!["owner","manager","coach"].includes(session.user.role)) throw new HttpError(403);
  return { session, tenantId: session.user.tenantId, userId: session.user.id };
}

export async function requireOwnerOrManager() { /* same with stricter role */ }
export async function requireOwner() { /* owner only */ }
export async function requireMember() { /* member only */ }
```

The returned `tenantId` is what every query MUST filter by. The convention is:

```ts
const { tenantId } = await requireStaff();
const members = await prisma.member.findMany({ where: { tenantId, status: "active" } });
```

Code reviewers grep for `prisma.X.findMany({where:{` without `tenantId:` — that's the smell. Same for `findFirst`, `findUnique` (when targeting tenant-scoped models — `findUnique({where:{id}})` on a tenant-scoped model is a smell unless wrapped in a tenant check).

### Layer 4 — DB-level CHECK constraints + indexes

Some invariants are too important to leave to API hygiene. Examples:

- `Order.totalPence >= 0` — CHECK
- `Order.status IN ('pending','paid','cancelled')` — CHECK
- `Payment.status IN (...)` — CHECK
- `Member.status IN ('active','inactive','suspended')` — CHECK
- All composite uniques on `(tenantId, ...)` enforced at the DB

Migrations use `NOT VALID + VALIDATE` for new CHECKs on existing tables to avoid full-table locks (see [database-migrations.md](database-migrations.md)).

## The "tenant from session, not from body" rule

API routes NEVER accept `tenantId` from request body or query string. Always:

```ts
const { tenantId } = await requireStaff();   // ✅ from session
// not:
const { tenantId } = await req.json();       // ❌ user-controlled
```

Same for `userId` when writing audit logs or attribution fields.

## Tenant lookup by slug (public surfaces)

Public endpoints (`/checkin/{slug}`, `/api/checkin/{slug}/...`) resolve `slug → tenantId` at the start of the handler:

```ts
const tenant = await prisma.tenant.findUnique({where:{slug}});
if (!tenant) return notFound();
const tenantId = tenant.id;
// from this point, every query filters by tenantId
```

Slug is a stable, indexed PK proxy. Slug enumeration doesn't grant access — the kiosk is intentionally public, but writes still need session OR a tenant-scoped HMAC (e.g. invite tokens).

## Session-version rotation

When an owner forces sign-out (security event, role change), they bump `User.sessionVersion`. The next request from that user's old JWT mismatches the DB and is rejected. Without this, multi-tenant *within a tenant* (across roles) would have a hole. See [session-version-rotation.md](session-version-rotation.md).

## Soft-delete + tenant scope

Soft-deleted rows (`deletedAt != null`) are still tenant-scoped, but most reads filter `deletedAt: null`. The deleted row is not "exposed to other tenants" — it's hidden from its own tenant unless explicitly looked up. Models with soft-delete: `Class`, `RankSystem`, `Product`, `Member`. See [LB-009 audit doc](../docs/audit/LB-009-soft-delete-tenant-scope.md).

## Cross-tenant testing

[tests/integration/security.test.ts](../tests/integration/security.test.ts) exercises the cross-tenant attack surface:

- Login as user from tenant A
- Try to fetch `/api/members/{id}` where `id` belongs to tenant B → expect 404
- Try to mark-paid a Payment from tenant B → expect 404
- Try to refund a Payment from tenant B → expect 404
- Try to access `/api/audit-log` with the wrong session → expect 403/401

The pattern: 404 (not 403) — we don't even tell the attacker the resource exists.

## Connect (Stripe) tenant isolation

Stripe Connect adds another dimension — money flowing through gym A's connected account must NEVER credit gym B. The webhook handler resolves member by `stripeCustomerId` (which is unique per Connect account anyway) and FK-scopes writes through `Member.tenantId`. See [stripe-webhook.md](stripe-webhook.md).

## Rate-limit buckets carry tenant context

Rate limit bucket keys are scoped to either the actor (member/user) OR the tenant — never anonymous globals. So one tenant DDoSing themselves doesn't lock out another. See [rate-limiting.md](rate-limiting.md).

## Audit log

`AuditLog.tenantId` makes every event tenant-scoped at the audit layer too. `requireOwner()` on the read API ensures the owner of tenant A can't read tenant B's events. See [audit-log.md](audit-log.md).

## Known limitations

- **No row-level security in Postgres** — we don't use Postgres RLS policies. Isolation is enforced at the application layer. RLS would be defence-in-depth; not done because Prisma 7's RLS support is rough.
- **No tenant-aware database connection pooling** — a single shared Prisma client serves all tenants. Per-tenant connections (à la Heroku Connect) would isolate at the connection level too.
- **No automated linting** for "queries without tenantId filter". A custom ESLint rule could catch the smell at PR time.
- **No quarterly cross-tenant fuzz test** — security.test.ts is comprehensive but additions to the codebase aren't auto-covered.
- **Public surfaces (kiosk, apply) deliberately don't auth** — they tenant-scope via slug. A slug enumeration grants no privileged access today, but a future endpoint that read PII via slug would be a regression.
- **Stripe customer dedup is per Connect account** — fine because each tenant has its own Connect account, but if a tenant ever switched accounts, member.stripeCustomerId would be stale.

## Test coverage

- [tests/integration/security.test.ts](../tests/integration/security.test.ts) — cross-tenant access controls
- Per-route unit tests assert `requireStaff/Owner/Manager` calls
- Migration tests assert CHECK constraints

## Files

- [lib/authz.ts](../lib/authz.ts) — `requireStaff` / `requireOwnerOrManager` / `requireOwner` / `requireMember`
- [auth.ts](../auth.ts) — JWT callback that bakes `tenantId` into the session
- [proxy.ts](../proxy.ts) — auth gate; member↔staff URL routing
- [prisma/schema.prisma](../prisma/schema.prisma) — every model has `tenantId` + composite uniques
- [tests/integration/security.test.ts](../tests/integration/security.test.ts)
- See [session-version-rotation.md](session-version-rotation.md), [audit-log.md](audit-log.md), [rate-limiting.md](rate-limiting.md), [database-migrations.md](database-migrations.md), [proxy-middleware.md](proxy-middleware.md)
