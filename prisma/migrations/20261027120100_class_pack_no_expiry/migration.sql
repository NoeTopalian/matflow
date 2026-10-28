-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Owner decision, 27 Oct 2026: "Class packs: the club chooses an expiry or no
-- expiry per new pack product. Existing purchases keep their recorded terms
-- and remaining credits; do not revive expired credits or extend existing
-- purchases through a blanket never-expire change."
--
-- Expand-only: both columns become nullable so a product can say "Never
-- expires" (validityDays NULL) and a purchase from such a product records no
-- expiry (expiresAt NULL). No data step: every existing row keeps its values,
-- so existing purchases keep their dates and expired packs stay expired. The
-- previous build serving during the deploy sees exactly the data it sees
-- today; only the new build creates a NULL-validity product.
--
-- History: this file was first written (unshipped, test branch only) with a
-- CHECK and an UPDATE clearing active packs' expiry. That was withdrawn the
-- same day; 20261027130000 removes the CHECK from any database that applied
-- the first version.
ALTER TABLE "MemberClassPack" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE "ClassPack" ALTER COLUMN "validityDays" DROP NOT NULL;

COMMIT;
