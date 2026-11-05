-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- T9c opt-in public club page (Q9, Noe 17 Oct 2026). Additive only: nullable
-- text columns and NOT NULL booleans with a constant DEFAULT false (a
-- metadata-only change in Postgres 11+, no table rewrite). No backfill. Every
-- existing club reads as "not published" and every existing tier as "price not
-- shown", so the old build keeps serving unchanged and ignores the columns.
-- No new table, so no new RLS policy: both tables already carry theirs.

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "publicPageAddress" TEXT,
ADD COLUMN     "publicPageDescription" TEXT,
ADD COLUMN     "publicPageEmail" TEXT,
ADD COLUMN     "publicPageEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicPageEnabledAt" TIMESTAMP(3),
ADD COLUMN     "publicPagePhone" TEXT;

-- AlterTable
ALTER TABLE "MembershipTier" ADD COLUMN     "showOnPublicPage" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
