-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Push subscriptions the push service reports gone (410) are marked inactive
-- instead of deleted (product rule, Noe, 6 Nov 2026: "nothing should be
-- automatically deleted"; lib/push.ts skips them when sending).
--
-- Expand-only and nullable: no backfill, no default, no rewrite of the table.

ALTER TABLE "PushSubscription" ADD COLUMN "disabledAt" TIMESTAMP(3);

COMMIT;
