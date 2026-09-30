-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- TeamUp bridge: who collects each member's money, and when that standing
-- was true. Additive: a NOT NULL column with a constant default is a
-- metadata-only change on PostgreSQL 11+; the two others are nullable.
ALTER TABLE "Member" ADD COLUMN "billedBy" TEXT NOT NULL DEFAULT 'matflow';
ALTER TABLE "Member" ADD COLUMN "billingStatusAsOf" TIMESTAMP(3);
ALTER TABLE "Member" ADD COLUMN "billingStatusSource" TEXT;
ALTER TABLE "Member" ADD CONSTRAINT "Member_billedBy_check" CHECK ("billedBy" IN ('matflow', 'teamup'));

-- Import mode: "create" adds people; "refresh" updates TeamUp-owned standing.
ALTER TABLE "ImportJob" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'create';
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_mode_check" CHECK ("mode" IN ('create', 'refresh'));

COMMIT;
