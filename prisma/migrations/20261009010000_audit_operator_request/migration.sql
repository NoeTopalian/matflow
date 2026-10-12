-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Audit actor + correlation columns (admin hub lane C, 9 Oct 2026, ledger AH-03).
-- Additive and nullable, no default, no backfill: safe on a live database, every
-- existing row reads as before, and code built before this migration (which
-- never names these columns) keeps working against it. Deploy order: this
-- migration BEFORE the code that writes the columns.

-- The operator behind the row (distinct from "userId", the subject user).
-- SET NULL: deleting an Operator keeps the record of what was done.
ALTER TABLE "AuditLog" ADD COLUMN "operatorId" TEXT;

-- Correlation id: SHA-256 of the spent step-up nonce on step-up rows (the
-- idempotent-replay lookup key), otherwise the platform request id or a UUID.
ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT;

CREATE INDEX "AuditLog_tenantId_requestId_idx" ON "AuditLog"("tenantId", "requestId");

ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
