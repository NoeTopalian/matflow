-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Mats: a club's training areas, and which one a class runs on.
--
-- Expand-only. No data is written: a club has no mats until someone adds them
-- on the Timetable page, and every class starts with no mat, so the timetable
-- of every existing club is exactly as it was. The previous build neither
-- reads nor writes any of this, so promoting back is schema-safe.

CREATE TABLE "Mat" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "nameKey"   TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Mat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Mat_tenantId_nameKey_key" ON "Mat"("tenantId", "nameKey");
CREATE INDEX "Mat_tenantId_sortOrder_idx" ON "Mat"("tenantId", "sortOrder");

-- Tenant RESTRICT (as ClassMembershipTier): the retention purge deletes mats
-- before the tenant.
ALTER TABLE "Mat" ADD CONSTRAINT "Mat_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "Mat" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Mat" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Mat" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- A class is on a mat or it is not. SET NULL: removing a mat never removes a class.
ALTER TABLE "Class" ADD COLUMN "matId" TEXT;
CREATE INDEX "Class_matId_idx" ON "Class"("matId");
ALTER TABLE "Class" ADD CONSTRAINT "Class_matId_fkey"
  FOREIGN KEY ("matId") REFERENCES "Mat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
