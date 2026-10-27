-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- G6 (owner decision, 27 Oct 2026): "It should be till it runs out". A class
-- pack is usable until its credits are used; NULL "expiresAt" means it never
-- expires, and a pack no longer has a validity period.
--
-- 1. Both columns become nullable. Expand-only: nothing is dropped or renamed,
--    and "ClassPack"."validityDays" keeps its values (the previous build's
--    webhook still reads it while this deploy builds).
ALTER TABLE "MemberClassPack" ALTER COLUMN "expiresAt" DROP NOT NULL;
ALTER TABLE "ClassPack" ALTER COLUMN "validityDays" DROP NOT NULL;

-- 2. An expired pack must carry the expiry it passed. This is the invariant
--    the new code keeps (only a non-NULL past date is ever marked expired),
--    and it is also the guard for the deploy window: the previous build's
--    member pack list marks a pack expired when "expiresAt" < now, and in
--    JavaScript null < now is true, so without this CHECK any member opening
--    the pack list before the new build is live would expire every pack step 3
--    clears. With it, that write fails and the pack stays active.
--    Every existing "expired" row has a non-NULL expiry (the column was
--    NOT NULL until step 1), so validation cannot fail.
ALTER TABLE "MemberClassPack" ADD CONSTRAINT "MemberClassPack_expired_has_expiry_check"
  CHECK ("status" <> 'expired' OR "expiresAt" IS NOT NULL) NOT VALID;
ALTER TABLE "MemberClassPack" VALIDATE CONSTRAINT "MemberClassPack_expired_has_expiry_check";

-- 3. Packs already sold lose their expiry. Only "active" rows: "expired" and
--    "refunded" rows are history and stay as they are (a refunded pack keeps
--    status "refunded" and 0 credits, and still stops working).
UPDATE "MemberClassPack" SET "expiresAt" = NULL WHERE "status" = 'active' AND "expiresAt" IS NOT NULL;

COMMIT;
