-- Audit iter-1-operator-admin Batch B + Batch C migration:
--   A6I1-V-1 (H2-4): AuditLog.userId + AttendanceRecord.checkedInById onDelete SetNull
--   A6I1-V-4:        AuditLog.tenantId nullable (platform-level audit events)
--   A6I1-P-3:        Payment cross-tenant indexes + Dispute cross-tenant index
--   A6I1-P-4:        AuditLog standalone createdAt index
--
-- IF NOT EXISTS guards keep CREATE INDEX idempotent against test-branch
-- divergence. ALTER COLUMN/CONSTRAINT statements are not idempotent in
-- Postgres without manual checks but we accept that — `prisma migrate
-- deploy` records the migration name once applied; rerunning becomes a
-- no-op via the _prisma_migrations table.

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-V-1: AuditLog.userId onDelete SetNull
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-V-1: AttendanceRecord.checkedInById onDelete SetNull
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT IF EXISTS "AttendanceRecord_checkedInById_fkey";
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_checkedInById_fkey"
  FOREIGN KEY ("checkedInById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-V-1 (verifier missed it; surfaced during fix): Class.coachUserId
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Class" DROP CONSTRAINT IF EXISTS "Class_coachUserId_fkey";
ALTER TABLE "Class" ADD CONSTRAINT "Class_coachUserId_fkey"
  FOREIGN KEY ("coachUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-V-4: AuditLog.tenantId nullable
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "AuditLog" ALTER COLUMN "tenantId" DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-P-3: Payment cross-tenant indexes
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Payment_status_paidAt_idx"    ON "Payment"("status", "paidAt");

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-P-3: Dispute cross-tenant index
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Dispute_status_updatedAt_idx" ON "Dispute"("status", "updatedAt");

-- ─────────────────────────────────────────────────────────────────────────
-- A6I1-P-4: AuditLog standalone createdAt index
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
