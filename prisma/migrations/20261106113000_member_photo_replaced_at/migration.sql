-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- A promotion photo replaced by a newer one is kept, not deleted (product rule,
-- Noe, 6 Nov 2026: "nothing should be automatically deleted"), and hidden from
-- every photo list. Keeping the row keeps the file reachable: a member's
-- erasure finds photos by memberId, a club's erasure by tenantId.
--
-- Expand-only and nullable: no backfill, no default, no rewrite of the table.

ALTER TABLE "MemberPhoto" ADD COLUMN "replacedAt" TIMESTAMP(3);

COMMIT;
