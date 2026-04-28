-- Add indexes for hot dashboard / report queries.

-- AttendanceRecord: tenant-scoped attendance reports by date range.
-- Step 1: Add column nullable to allow backfill
ALTER TABLE "AttendanceRecord" ADD COLUMN "tenantId" TEXT;

-- Step 2: Backfill tenantId from each row's owning Member
UPDATE "AttendanceRecord" a
SET "tenantId" = m."tenantId"
FROM "Member" m
WHERE a."memberId" = m."id";

-- Step 3: Lock the column NOT NULL after backfill
ALTER TABLE "AttendanceRecord" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX "AttendanceRecord_tenantId_checkInTime_idx"
  ON "AttendanceRecord" ("tenantId", "checkInTime");

-- Payment: ledger filters by status and date.
CREATE INDEX "Payment_tenantId_status_idx"
  ON "Payment" ("tenantId", "status");
CREATE INDEX "Payment_tenantId_paidAt_idx"
  ON "Payment" ("tenantId", "paidAt");

-- Member: active-member counts on the dashboard.
CREATE INDEX "Member_tenantId_status_idx"
  ON "Member" ("tenantId", "status");
