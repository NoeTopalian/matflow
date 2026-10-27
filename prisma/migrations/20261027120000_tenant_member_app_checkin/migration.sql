-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- G5 (owner decision, 27 Oct 2026): "In app sign ins are optionally set up by
-- the gym owners, and they should be able to turn it off in their gym
-- settings. It should be on as default."
--
-- Expand-only. NOT NULL with a constant DEFAULT is a catalogue-only change on
-- PostgreSQL 11+ (no table rewrite), and every existing club reads true, which
-- is today's behaviour. The previous build neither selects nor writes the
-- column, and its INSERTs take the default.
ALTER TABLE "Tenant" ADD COLUMN "memberAppCheckin" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
