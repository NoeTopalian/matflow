-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- The club's public contact address (1 Oct 2026): what members see and reply
-- to. Not a login. billingContactEmail / privacyContactEmail fall back to it
-- when empty; every email sent on the club's behalf carries it as Reply-To.
ALTER TABLE "Tenant" ADD COLUMN "contactEmail" TEXT;

COMMIT;
