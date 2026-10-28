-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- G6 rework (review of 27 Oct 2026). The first, unshipped version of
-- 20261027120100_class_pack_no_expiry added the CHECK
-- "MemberClassPack_expired_has_expiry_check"; it reached the Neon test branch
-- only. The shipped version of that migration no longer adds it, so on a fresh
-- database (and on production) this is a no-op; on the test branch it brings
-- the schema to the same end state. Nothing writes the status 'expired' any
-- more, so the constraint has nothing left to guard.
ALTER TABLE "MemberClassPack" DROP CONSTRAINT IF EXISTS "MemberClassPack_expired_has_expiry_check";

COMMIT;
