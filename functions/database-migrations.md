# Database Migrations

> **Status:** ✅ Working · Prisma Migrate · `migrate deploy` runs as a build step on Vercel · NOT VALID + VALIDATE pattern for live-table CHECK constraints · audit subdirectory under `prisma/migrations/`.

## Purpose

A reproducible, version-controlled schema. Every change to `prisma/schema.prisma` ships alongside a migration file in `prisma/migrations/{timestamp}_{name}/migration.sql` that brings any database (dev, preview, prod) to that schema version exactly.

## Workflow

### Local development

```bash
# After editing prisma/schema.prisma
npx prisma migrate dev --name describe_change_here
# → applies + generates client + creates migration file
```

`migrate dev` is destructive in the worst case (drops + recreates if the diff is too complex), so we only use it on the local DB.

### Production

```bash
# Vercel build step (configured in package.json):
"build": "prisma migrate deploy && next build"
```

`migrate deploy` is forward-only — applies any pending migrations in order, never resets. Safe for production. If a migration fails, the build fails, the deployment doesn't ship.

### Direct SQL when needed

For migrations Prisma's diff can't express (CHECK constraints, partial indexes, etc.), we hand-edit the generated `migration.sql`. The schema.prisma still tracks the column type, but the constraint lives in raw SQL.

Example (from [20260430000005_orders/migration.sql](../prisma/migrations/20260430000005_orders/migration.sql)):

```sql
-- Prisma-generated CREATE TABLE for Order ...

-- Hand-added CHECK constraints
ALTER TABLE "Order" ADD CONSTRAINT order_status_check
  CHECK ("status" IN ('pending','paid','cancelled')) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT order_status_check;

ALTER TABLE "Order" ADD CONSTRAINT order_payment_method_check
  CHECK ("paymentMethod" IN ('pay_at_desk','stripe')) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT order_payment_method_check;

ALTER TABLE "Order" ADD CONSTRAINT order_total_pence_nonneg_check
  CHECK ("totalPence" >= 0) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT order_total_pence_nonneg_check;
```

When `schema.prisma` doesn't model the constraint, we add a comment alongside the field documenting it:

```prisma
status String @default("pending")  // CHECK: pending | paid | cancelled
```

## NOT VALID + VALIDATE pattern

The most important migration trick in this codebase. Adding a CHECK constraint to a populated table normally:

1. Acquires an `ACCESS EXCLUSIVE` lock (blocks all reads + writes)
2. Scans the entire table to verify all rows satisfy the constraint
3. Releases the lock

For a 50M-row table that's minutes of downtime. The two-phase pattern fixes it:

```sql
-- Phase 1: add the constraint without scanning (instant, lightweight lock)
ALTER TABLE foo ADD CONSTRAINT bar CHECK (...) NOT VALID;

-- Phase 2: scan in a separate transaction (acquires SHARE UPDATE EXCLUSIVE
-- — non-blocking for normal reads/writes)
ALTER TABLE foo VALIDATE CONSTRAINT bar;
```

After Phase 1, all NEW writes must satisfy the constraint. Phase 2 confirms historical rows match. We run them in the same migration file because we control the data and can verify Phase 2 won't fail; for hostile production data with an in-flight backfill, you'd run them in separate deployments.

Used in:
- [20260430000003_product_category_check](../prisma/migrations/20260430000003_product_category_check/migration.sql) — Product.category enum
- [20260430000005_orders](../prisma/migrations/20260430000005_orders/migration.sql) — Order status / paymentMethod / totalPence
- Most enum-as-CHECK constraints

## Naming convention

`{YYYYMMDDhhmmss}_{snake_case_description}/migration.sql`

Examples:
- `20260426232743_bacs_direct_debit/`
- `20260430000005_orders/`
- `20260501000001_member_emergency_contact_relation/`

The timestamp prefix gives a stable lexicographic order that matches creation time. Prisma applies them in name order.

## What's tracked

- `prisma/schema.prisma` — source of truth for shape
- `prisma/migrations/*/migration.sql` — actual SQL applied
- `prisma/migrations/migration_lock.toml` — pins `provider = "postgresql"`

The `_prisma_migrations` table on the DB side records which migrations have been applied. `migrate deploy` reads it to skip already-applied ones.

## Build script

[package.json](../package.json):

```json
{
  "scripts": {
    "build": "prisma migrate deploy && next build",
    "postinstall": "prisma generate"
  }
}
```

`prisma generate` runs on `npm install` so the Prisma client is always in sync with `schema.prisma` for type-checking. `migrate deploy` runs before `next build` so a failed migration aborts the deploy before any new code ships.

### `DATABASE_URL_DIRECT`

`migrate deploy` requires a direct (non-pooled) Postgres connection. Neon serves this via a separate hostname — we set `DATABASE_URL_DIRECT` in Vercel env and Prisma uses it for migrations:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_DIRECT")
}
```

Runtime queries still use the pooled `DATABASE_URL`.

## Soft-delete migration

The pattern for adding `deletedAt`:

1. Add `deletedAt DateTime?` to the model
2. Generate migration — `ALTER TABLE foo ADD COLUMN "deletedAt" TIMESTAMP(3)`
3. (Optionally) add a partial index for non-deleted rows: `CREATE INDEX foo_active ON foo("tenantId") WHERE "deletedAt" IS NULL`
4. Update existing queries to filter `where: {deletedAt: null}`

Documented in [LB-009](../docs/audit/LB-009-soft-delete-tenant-scope.md).

## Rollback strategy

Prisma doesn't generate down-migrations. Our policy:

- **Never roll back a deployed migration** — write a new forward migration that reverses the change
- **Pre-deploy verify** in staging — preview deployments hit a separate Neon database with prod schema
- **Schema additions are safe** — add column nullable, deploy, backfill, then make NOT NULL in a follow-up
- **Schema deletions are scary** — drop the column AFTER all code paths that read it have shipped

For destructive changes (rename column, change type), the safe pattern is:

1. Add new column alongside old
2. Dual-write from app
3. Backfill old → new
4. Switch reads to new
5. Drop old

## Audit migrations

Some migrations exist purely for compliance / governance (no schema impact). Examples:

- `20260501000001_member_emergency_contact_relation` — adds `emergencyContactRelation` column tied to onboarding gate
- Soft-delete + tenant-scope audit (LB-009) — index additions only

These have a comment header in the SQL explaining the audit context + linked doc in [docs/audit/](../docs/audit/).

## Generating the Prisma client

```bash
npx prisma generate
```

Runs automatically:
- On `npm install` (via `postinstall` in package.json)
- After `migrate dev` / `migrate deploy`
- In `npm run build`

Output goes to `node_modules/.prisma/client`. We commit `schema.prisma` only — never the generated client.

## Security

| Control | Where |
|---|---|
| Forward-only deploys | `migrate deploy` never resets prod |
| CHECK constraints at DB layer | Backstop for application-layer enum gates |
| NOT VALID + VALIDATE | Live-table constraint adds without long locks |
| Direct URL for migrations | Bypasses pooler — required for DDL |
| Build aborts on migration fail | No code ships against incompatible schema |
| Migration files committed to repo | Reviewable in PRs; rollback via revert + new migration |
| Soft-delete preserves history | `deletedAt` filtering in app; raw rows still in DB for audit |
| Separate test/staging DBs | Schema verified before prod |

## Known limitations

- **No automated migration test** — we don't run `migrate deploy` against a fresh DB in CI. A failure surfaces at deploy time, not PR time. Worth adding.
- **No down-migrations** — recovery from a bad deploy is "ship a new forward migration", not "rollback". Acceptable but slow for emergencies.
- **Hand-edited SQL is reviewer-dependent** — Prisma validates type changes; CHECK constraint changes get reviewed by humans. A migration linter could catch obvious mistakes.
- **Migration name is the only natural key** — two devs racing on parallel branches with the same migration name → conflict at merge time.
- **`prisma migrate dev` can drift** — if local DB diverges from migrations, the next `migrate dev` may want to drop/recreate. The team avoids this by always running `migrate dev` after pull.
- **No multi-step migration tooling** — for the Add column → backfill → make NOT NULL flow, each step is a separate migration. No native "phased migration" support.
- **Neon branch-per-PR** isn't wired today — schema changes can't be isolated per preview.

## Files

- [prisma/schema.prisma](../prisma/schema.prisma) — source of truth
- [prisma/migrations/](../prisma/migrations/) — applied migrations history
- [package.json](../package.json) — build script orchestrating `migrate deploy`
- [docs/audit/](../docs/audit/) — audit-trail docs for LB-* migrations
- See [multi-tenant-isolation.md](multi-tenant-isolation.md), [encryption-secrets.md](encryption-secrets.md), [orders-pay-at-desk.md](orders-pay-at-desk.md), [products-catalogue.md](products-catalogue.md), [bacs-direct-debit.md](bacs-direct-debit.md)
