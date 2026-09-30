-- All-or-nothing: Prisma does not wrap a migration in a transaction (the 30 Sep
-- failure drill left a partial ALTER behind), so this one does it itself.
BEGIN;

-- Total BJJ controlled launch. All additive and nullable: metadata-only
-- ADD COLUMNs (no rewrite) plus indexes on small tables. The deployed build
-- never reads these columns, so it keeps working on the new schema.

-- Review mode (G2): the club can be inspected while billing, bulk invitations
-- and erasure are refused server-side (lib/review-lock.ts).
ALTER TABLE "Tenant" ADD COLUMN "reviewLockedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "reviewSnapshotAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "reviewNote" TEXT;

-- Import provenance and reconciliation.
ALTER TABLE "ImportJob" ADD COLUMN "fileHash" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN "sourceExportedAt" TIMESTAMP(3);
ALTER TABLE "ImportJob" ADD COLUMN "mappingVersion" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN "manifest" JSONB;
ALTER TABLE "ImportJob" ADD COLUMN "rolledBackAt" TIMESTAMP(3);
CREATE INDEX "ImportJob_tenantId_fileHash_idx" ON "ImportJob"("tenantId", "fileHash");

-- Rows an import created carry its id, so rollback-by-job never touches a row
-- created any other way. externalRef is the source platform's customer id.
ALTER TABLE "Member" ADD COLUMN "importJobId" TEXT;
ALTER TABLE "Member" ADD COLUMN "externalRef" TEXT;
CREATE UNIQUE INDEX "Member_tenantId_externalRef_key" ON "Member"("tenantId", "externalRef");
CREATE INDEX "Member_importJobId_idx" ON "Member"("importJobId");

ALTER TABLE "AttendanceRecord" ADD COLUMN "importJobId" TEXT;
ALTER TABLE "AttendanceRecord" ADD COLUMN "sourceRowId" TEXT;
CREATE INDEX "AttendanceRecord_importJobId_idx" ON "AttendanceRecord"("importJobId");

COMMIT;
