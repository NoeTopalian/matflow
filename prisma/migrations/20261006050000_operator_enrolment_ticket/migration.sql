-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Operator enrolment ticket, 6 Oct 2026 (review finding D3). Additive,
-- nullable, no default, no backfill: safe on a live database. An operator with
-- no authenticator may enrol one only with the single-use ticket printed by
-- scripts/operator-access.mjs (create / recover): SHA-256 of the ticket and its
-- expiry (30 minutes). Cleared when the enrolment succeeds. NULL = no ticket
-- outstanding (every existing row; enrolled operators never need one).
ALTER TABLE "Operator" ADD COLUMN "enrolmentTicketHash" TEXT;
ALTER TABLE "Operator" ADD COLUMN "enrolmentTicketExpiresAt" TIMESTAMP(3);

COMMIT;
