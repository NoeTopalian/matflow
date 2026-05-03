# RLS Activation — flipping policies from dormant to enforced

## What this migration does

Runs `ENABLE + FORCE ROW LEVEL SECURITY` on every tenant-scoped table. The policies created in `20260503100000_rls_policies_foundation` go from inert to enforcing.

## Pre-flight gates (do all of these before staging)

1. **Code verification** — confirm the only files still importing `prisma` directly are foundational:
   ```sh
   grep -rln "import.*prisma.*from.*lib/prisma" app/api lib --include="*.ts"
   ```
   Expected: `lib/rate-limit.ts`, `app/api/settings/route.ts` (type-only), `app/api/health/route.ts`. Anything else is a route that needs migration before this migration runs, or it will return zero rows / fail.

2. **Test verification** — `tests/integration/rls-foundation.test.ts` passes against a real database (not the production one):
   ```sh
   DATABASE_URL=<staging-or-test-db> npm test -- rls-foundation
   ```

3. **Stripe webhook smoke test** — the webhook is the riskiest path because Stripe will replay any event we 500 on. Send a test event from Stripe CLI to a staging deployment with this migration applied and confirm the event is processed (StripeEvent row created, the relevant Payment / Member updated).

4. **Cron smoke test** — invoke `/api/cron/monthly-reports` manually with the bearer token. Confirm it processes every active tenant.

5. **Login smoke test** — credentials login, magic-link request + verify, password reset flow.

## How to deploy

The build script runs `prisma migrate deploy && next build` — this migration auto-applies on the next deploy. Stage it on Vercel preview first and smoke-test the gates above before promoting to production.

## Rollback

Run by hand against the affected database:

```sql
-- Quick global rollback — disable RLS on every table this migration enabled.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND rowsecurity = true
  LOOP
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', r.tablename);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;
```

The policies stay in place. Re-activation is just running the SQL in this directory again.

## What changes operationally

- **Bare `prisma.X.Y(...)` calls return zero rows** — the GUC `app.current_tenant_id` is NULL by default, so the `USING` clause evaluates `tenant_id = NULL` which is false. This is the safe-by-default behaviour.
- **`withTenantContext(tenantId, ...)`** scopes the transaction to one tenant via `set_config('app.current_tenant_id', tenantId, true)`.
- **`withRlsBypass(...)`** sets `set_config('app.bypass_rls', 'on', true)` for trusted cross-tenant operations: webhooks, cron, auth flows that resolve tenant by slug, public form submissions, tenant creation.

## Why FORCE in addition to ENABLE

Postgres ENABLE ROW LEVEL SECURITY exempts the table owner. Prisma typically connects as the database owner on Neon, so without FORCE, RLS would silently do nothing for production traffic. FORCE makes the policy apply to the owner too — that's the security goal.
