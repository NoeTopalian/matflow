# RLS Foundation — rollout guide

## What this migration does

Creates `tenant_isolation` policies on every tenant-scoped table. The policies are **dormant** — they only fire once `ENABLE ROW LEVEL SECURITY` is run on each table. Until activation, application behaviour is unchanged.

## Why dormant?

Activating RLS without first migrating every database call to set `app.current_tenant_id` would silently turn every query into a zero-row result. The safe pattern is:

1. **This migration**: define policies (zero risk).
2. **Code migration sweep**: convert each `prisma.foo.bar(...)` call site to `withTenantContext(tenantId, (tx) => tx.foo.bar(...))`. See `lib/prisma-tenant.ts`.
3. **Activation migration**: run `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY` on each table once its callers are migrated.

## Helper API (`lib/prisma-tenant.ts`)

- `withTenantContext(tenantId, fn)` — runs `fn` in a transaction with `app.current_tenant_id` set. Use this in any authenticated API route after `requireSession()` / `requireRole()`.
- `withRlsBypass(fn)` — escape hatch for legitimate cross-tenant operations (Stripe webhooks, cron jobs, auth flows resolving tenant by slug). Audit every call site.

## Why `set_config(..., true)` not `SET LOCAL`?

`set_config()` is a function call so Prisma can parameterise the tenantId safely. The third argument (`true`) makes the setting transaction-local — equivalent to `SET LOCAL` but parameterisable. This is required because `DATABASE_URL?pgbouncer=true` runs Postgres in transaction-mode pooling, where session-scoped GUCs don't persist across queries.

## Rollback

If activation goes wrong:

```sql
ALTER TABLE "Member" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Member" NO FORCE ROW LEVEL SECURITY;
-- … repeat per table
DROP POLICY tenant_isolation ON "Member";
```

The policies (this migration) can be dropped without affecting data.

## Testing

`tests/integration/rls-foundation.test.ts` ENABLES RLS on Member temporarily, runs assertions, then DISABLES it. The test skips when `DATABASE_URL` is not set. Run via `npm test`.

## Follow-up sweep checklist

API handlers that read or write tenant-scoped data must migrate to `withTenantContext`. Discover them with:

```
rg "prisma\.\w+\.(findMany|findFirst|findUnique|create|update|delete|count|aggregate|upsert|groupBy)" app/api lib --type ts -l
```

Pilot route already migrated (proves the pattern):
- `app/api/members/route.ts` (GET handler)
