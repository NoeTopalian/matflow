-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- T6a (Sean note 1): which memberships include a class.
--
-- Expand-only. A class with NO rows is open to every member, exactly as before
-- this table existed, so there is no backfill and every existing class behaves
-- as it does today. The previous build neither reads nor writes the table, so
-- promoting back is schema-safe (rows written meanwhile are ignored: gated
-- classes reopen under the old build).

CREATE TABLE "ClassMembershipTier" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "classId"         TEXT NOT NULL,
    "tierId"          TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    CONSTRAINT "ClassMembershipTier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassMembershipTier_classId_tierId_key" ON "ClassMembershipTier"("classId", "tierId");
CREATE INDEX "ClassMembershipTier_tenantId_classId_idx" ON "ClassMembershipTier"("tenantId", "classId");
CREATE INDEX "ClassMembershipTier_tenantId_tierId_idx" ON "ClassMembershipTier"("tenantId", "tierId");

-- Tenant RESTRICT (as ClassRoster): the retention purge deletes these rows
-- before the tenant. Class and tier CASCADE; the user who added it SET NULL.
ALTER TABLE "ClassMembershipTier" ADD CONSTRAINT "ClassMembershipTier_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassMembershipTier" ADD CONSTRAINT "ClassMembershipTier_classId_fkey"
  FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassMembershipTier" ADD CONSTRAINT "ClassMembershipTier_tierId_fkey"
  FOREIGN KEY ("tierId") REFERENCES "MembershipTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassMembershipTier" ADD CONSTRAINT "ClassMembershipTier_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "ClassMembershipTier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassMembershipTier" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ClassMembershipTier" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

COMMIT;
