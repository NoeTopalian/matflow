-- B9 — Club Store products. Replaces the static catalogue in lib/products.ts
-- with a per-tenant CRUD model. lib/products.ts now contains only the LEGACY
-- demo seed used to backfill new tenants on first install.

CREATE TABLE "Product" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "pricePence"  INTEGER NOT NULL,
  "currency"    TEXT NOT NULL DEFAULT 'GBP',
  "category"    TEXT NOT NULL DEFAULT 'other',
  "symbol"      TEXT,
  "description" TEXT,
  "inStock"     BOOLEAN NOT NULL DEFAULT true,
  "deletedAt"   TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE INDEX "Product_tenantId_deletedAt_idx" ON "Product" ("tenantId", "deletedAt");
CREATE INDEX "Product_tenantId_inStock_deletedAt_idx" ON "Product" ("tenantId", "inStock", "deletedAt");

-- Same NOT VALID + VALIDATE pattern as 20260430000001_schema_check_constraints
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_check"
  CHECK ("category" IN ('clothing', 'food', 'drink', 'equipment', 'other')) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_category_check";

ALTER TABLE "Product" ADD CONSTRAINT "Product_pricePence_nonneg_check"
  CHECK ("pricePence" >= 0) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_pricePence_nonneg_check";
