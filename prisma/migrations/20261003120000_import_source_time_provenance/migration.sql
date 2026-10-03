-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- How an import's source export time is known (3 Oct 2026, Total BJJ
-- handover): "owner_stated" when the owner entered it, "provisional" when it
-- is an estimate to be confirmed by a status refresh. NULL = no time given.
-- Additive and nullable: existing jobs keep NULL and read as before.
ALTER TABLE "ImportJob" ADD COLUMN "sourceExportedAtProvenance" TEXT;
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_sourceExportedAtProvenance_check"
  CHECK ("sourceExportedAtProvenance" IS NULL OR "sourceExportedAtProvenance" IN ('owner_stated', 'provisional'));

COMMIT;
