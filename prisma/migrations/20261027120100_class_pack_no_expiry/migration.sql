-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- G6 (owner decision, 27 Oct 2026): "It should be till it runs out". A class
-- pack is usable until its credits are used or it is refunded.
--
-- Expand-only: both columns become nullable and nothing else changes. No row
-- is rewritten, so while the previous build serves during the deploy it sees
-- exactly the data it sees today. The new code does not read
-- "MemberClassPack"."expiresAt" or the legacy status 'expired' at all
-- (lib/checkin.ts claimPack, app/api/member/class-packs), and writes NULL for
-- every pack it sells, so old dates — including on a pack bought through the
-- previous build during the deploy — are inert and need no data step.
-- "ClassPack"."validityDays" keeps its values (the previous build's webhook
-- still reads it while this deploy builds); new templates store NULL.
--
-- History: this file was first written (unshipped, test branch only) with a
-- CHECK and an UPDATE clearing active packs' expiry. Review of 27 Oct 2026
-- replaced that with the code-side rule above; 20261027130000 removes the
-- CHECK from any database that applied the first version.
ALTER TABLE "MemberClassPack" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE "ClassPack" ALTER COLUMN "validityDays" DROP NOT NULL;

COMMIT;
