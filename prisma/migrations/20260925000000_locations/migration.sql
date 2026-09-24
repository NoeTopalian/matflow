-- ADR-001 D2: Location as an additive attribute inside a club. A club with
-- one venue is unchanged: a class with NULL "locationId" belongs to every
-- location of its club, and every existing club gets one default location
-- named from its address (or "Main") so the picker has something to show.
-- Nothing here changes tenancy, money or access.

CREATE TABLE "Location" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Location_tenantId_name_key" ON "Location"("tenantId", "name");
CREATE INDEX "Location_tenantId_idx" ON "Location"("tenantId");
-- At most one default per club, enforced where it matters.
CREATE UNIQUE INDEX "Location_tenantId_default_key" ON "Location"("tenantId") WHERE "isDefault";

ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Class" ADD COLUMN "locationId" TEXT;
ALTER TABLE "Class" ADD CONSTRAINT "Class_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Class_locationId_idx" ON "Class"("locationId");

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "Location" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Location" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Location" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- Backfill: one default location per existing club. Classes stay NULL
-- ("all locations"), so single-venue behaviour is exactly as before.
INSERT INTO "Location" ("id", "tenantId", "name", "address", "isDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."id", 'Main', t."address", true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE NOT EXISTS (SELECT 1 FROM "Location" l WHERE l."tenantId" = t."id");
