-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Tenant lifecycle safety (6 Oct 2026, operator audit findings 5 and 6).
-- Additive, nullable, no default, no backfill: safe on a live database, and
-- every existing row reads exactly as before.

-- Restore-versus-purge: the retention cron's claim on a soft-deleted club.
-- NULL = no purge has started (every existing row).
ALTER TABLE "Tenant" ADD COLUMN "purgeStartedAt" TIMESTAMP(3);

-- Suspension record: the status un-suspend restores, and the member-billing
-- inventory taken at suspension. NULL on clubs suspended before this change;
-- un-suspend falls back to the audit trail for those.
ALTER TABLE "Tenant" ADD COLUMN "suspendedPreviousStatus" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "suspensionBilling" JSONB;

COMMIT;
