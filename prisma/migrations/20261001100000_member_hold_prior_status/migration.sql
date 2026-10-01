-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- The standing a hold replaced, restored exactly on resume. Nullable;
-- a hold placed before this column existed resumes as it always did.
ALTER TABLE "Member" ADD COLUMN "holdPriorStatus" TEXT;

COMMIT;
