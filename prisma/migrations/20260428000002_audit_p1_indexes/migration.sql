-- Add indexes for hot dashboard / report queries.

-- AttendanceRecord: tenant-scoped attendance reports by date range.
ALTER TABLE "AttendanceRecord" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT '';
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
