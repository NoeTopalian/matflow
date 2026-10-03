-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Attendance-history import of a real TeamUp attendance export (3 Oct 2026).
--
-- 1. ImportedBooking keeps every SOURCE booking (attended, registered, late
--    cancelled, no show) as a fact with its provenance. Only an attended
--    booking of a resolved person in a past session also becomes an
--    AttendanceRecord, so reports keep counting attendance only. Keyed by a
--    booking key that excludes the status: a later export that turns
--    "registered" into "attended" updates the row instead of adding one.
-- 2. ImportSourceMapping keeps the owner's person / offering / venue decisions
--    so a later export of the same club reuses them.
-- 3. ImportUpload(+Chunk) holds an uploaded file sent in chunks well under the
--    host's 4.5 MB request-body limit, verified by size and sha256.
-- 4. A historical session has no source end time and a historical class no
--    source duration: both columns become nullable instead of being invented.
--    Class / ClassInstance.sourceImportJobId mark rows an import created.
-- Additive only: no existing row changes.

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "sourceImportJobId" TEXT,
ALTER COLUMN "duration" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ClassInstance" ADD COLUMN     "sourceImportJobId" TEXT,
ALTER COLUMN "endTime" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ImportJob" ADD COLUMN     "leaseToken" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "mappings" JSONB;

-- CreateTable
CREATE TABLE "ImportedBooking" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bookingKey" TEXT NOT NULL,
    "sourcePersonKey" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceEmail" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "startsAtRaw" TEXT NOT NULL,
    "offeringLabel" TEXT NOT NULL,
    "venueLabel" TEXT NOT NULL,
    "instructorsRaw" TEXT,
    "bookingMethod" TEXT,
    "bookingSource" TEXT,
    "customerMembershipRef" TEXT,
    "membershipRef" TEXT,
    "membershipName" TEXT,
    "checkinAtRaw" TEXT,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT NOT NULL,
    "rowFingerprint" TEXT NOT NULL,
    "sourceSnapshotAt" TIMESTAMP(3),
    "memberId" TEXT,
    "matchMethod" TEXT,
    "classInstanceId" TEXT,
    "attendanceRecordId" TEXT,
    "attendanceOwned" BOOLEAN NOT NULL DEFAULT false,
    "disposition" TEXT NOT NULL,
    "createdByJobId" TEXT NOT NULL,
    "lastJobId" TEXT NOT NULL,
    "previousState" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportedBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportSourceMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportSourceMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportUpload" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "expectedBytes" INTEGER NOT NULL,
    "expectedSha256" TEXT NOT NULL,
    "chunkSize" INTEGER NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportUploadChunk" (
    "uploadId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "ImportUploadChunk_pkey" PRIMARY KEY ("uploadId","index")
);

-- CreateIndex
CREATE INDEX "ImportedBooking_tenantId_memberId_idx" ON "ImportedBooking"("tenantId", "memberId");

-- CreateIndex
CREATE INDEX "ImportedBooking_tenantId_createdByJobId_idx" ON "ImportedBooking"("tenantId", "createdByJobId");

-- CreateIndex
CREATE INDEX "ImportedBooking_tenantId_lastJobId_idx" ON "ImportedBooking"("tenantId", "lastJobId");

-- CreateIndex
CREATE INDEX "ImportedBooking_tenantId_sourcePersonKey_idx" ON "ImportedBooking"("tenantId", "sourcePersonKey");

-- CreateIndex
CREATE INDEX "ImportedBooking_attendanceRecordId_idx" ON "ImportedBooking"("attendanceRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "ImportedBooking_tenantId_source_bookingKey_key" ON "ImportedBooking"("tenantId", "source", "bookingKey");

-- CreateIndex
CREATE INDEX "ImportSourceMapping_tenantId_kind_idx" ON "ImportSourceMapping"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSourceMapping_tenantId_source_kind_sourceKey_key" ON "ImportSourceMapping"("tenantId", "source", "kind", "sourceKey");

-- CreateIndex
CREATE INDEX "ImportUpload_tenantId_createdAt_idx" ON "ImportUpload"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportUpload_expiresAt_idx" ON "ImportUpload"("expiresAt");

-- CreateIndex
CREATE INDEX "Class_sourceImportJobId_idx" ON "Class"("sourceImportJobId");

-- CreateIndex
CREATE INDEX "ClassInstance_sourceImportJobId_idx" ON "ClassInstance"("sourceImportJobId");

-- AddForeignKey
ALTER TABLE "ImportedBooking" ADD CONSTRAINT "ImportedBooking_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportedBooking" ADD CONSTRAINT "ImportedBooking_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSourceMapping" ADD CONSTRAINT "ImportSourceMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportUpload" ADD CONSTRAINT "ImportUpload_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportUploadChunk" ADD CONSTRAINT "ImportUploadChunk_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "ImportUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "ImportedBooking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportedBooking" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportedBooking" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));
ALTER TABLE "ImportSourceMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportSourceMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportSourceMapping" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));
ALTER TABLE "ImportUpload" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportUpload" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportUpload" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));
ALTER TABLE "ImportUploadChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportUploadChunk" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ImportUploadChunk" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));

COMMIT;
