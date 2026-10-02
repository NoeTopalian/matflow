-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Real TeamUp import (2 Oct 2026). Two things the first importer folded away:
--
-- 1. Every source membership row is kept, per member and per import job, so a
--    person's history (plans, dates, holds, scheduled starts) is a record and
--    not a guess, every row of the file has exactly one disposition, and the
--    profile and Activity feed can show "imported history" without ever
--    calling it a new purchase.
-- 2. Guardianship is suggested, never granted, by an import. A link made from
--    a shared email or an emergency contact carries guardianConfirmedAt NULL
--    until the owner confirms it; the parent portal only acts for a child
--    whose link is confirmed. Every link that exists today was made by staff
--    or the member and is backfilled as confirmed, so nothing regresses.

CREATE TABLE "ImportedMembership" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "importJobId"       TEXT NOT NULL,
    -- NULL for a row that did not become part of a member (duplicate,
    -- deleted customer, quarantined): the row is still accounted for.
    "memberId"          TEXT,
    -- CSV record ordinal, header = 1 (RFC-4180 records, not physical lines).
    "sourceRow"         INTEGER NOT NULL,
    "sourceFingerprint" TEXT NOT NULL,
    "planLabel"         TEXT NOT NULL,
    "type"              TEXT NOT NULL,
    "status"            TEXT NOT NULL,
    "processor"         TEXT,
    -- Date-only in the source; kept date-only (no timezone shift).
    "purchaseDate"      DATE,
    "startDate"         DATE,
    "expiryDate"        DATE,
    "cancelledDate"     DATE,
    -- The one timestamp in the export (with offset); kept as an instant.
    "completedAt"       TIMESTAMP(3),
    "isFirst"           BOOLEAN,
    "otherActive"       TEXT,
    -- current | scheduled | held | history | duplicate | quarantined | excluded
    "entitlement"       TEXT NOT NULL,
    -- member_history | duplicate_of:<row> | quarantined:<reason> | excluded:deleted_customer
    "disposition"       TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImportedMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ImportedMembership_importJobId_sourceRow_key" ON "ImportedMembership"("importJobId", "sourceRow");
CREATE INDEX "ImportedMembership_tenantId_memberId_idx" ON "ImportedMembership"("tenantId", "memberId");
CREATE INDEX "ImportedMembership_tenantId_importJobId_idx" ON "ImportedMembership"("tenantId", "importJobId");

ALTER TABLE "ImportedMembership" ADD CONSTRAINT "ImportedMembership_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ImportedMembership" ADD CONSTRAINT "ImportedMembership_importJobId_fkey"
  FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A rolled-back member takes its history rows with it.
ALTER TABLE "ImportedMembership" ADD CONSTRAINT "ImportedMembership_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "ImportedMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportedMembership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportedMembership" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- Guardianship confirmation.
ALTER TABLE "Member" ADD COLUMN "guardianConfirmedAt" TIMESTAMP(3);
-- shared_email | emergency_contact | staff | member — how the link came to be.
ALTER TABLE "Member" ADD COLUMN "guardianSuggestedBy" TEXT;
-- A contact address the import saw but could not verify (the payer's address
-- behind a guardian draft; the shared address of a second adult). Never a
-- login; shown to the owner to confirm. The login email stays synthesised.
ALTER TABLE "Member" ADD COLUMN "unverifiedEmail" TEXT;

-- Every existing link was made by staff or the member themselves: confirmed.
UPDATE "Member" SET "guardianConfirmedAt" = CURRENT_TIMESTAMP, "guardianSuggestedBy" = 'staff'
WHERE "parentMemberId" IS NOT NULL AND "guardianConfirmedAt" IS NULL;

COMMIT;
