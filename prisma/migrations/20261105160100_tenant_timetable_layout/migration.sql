-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- How a club splits classes at the same time: by mat or by time. NULL = nobody
-- has chosen, and the timetable follows the mats (lib/timetable-layout.ts).
--
-- Expand-only, no backfill. Its own file, so no file holds a lock on "Class"
-- while it waits for "Tenant".

ALTER TABLE "Tenant" ADD COLUMN "timetableLayout" TEXT;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_timetableLayout_check"
  CHECK ("timetableLayout" IS NULL OR "timetableLayout" IN ('mat', 'time'));

COMMIT;
