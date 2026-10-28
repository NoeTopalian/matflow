-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- A pack marked "expired" must carry the date it passed (owner decision, 27 Oct 2026: expiry is chosen per pack
-- product; "Never expires" stores "expiresAt" NULL).
--
-- Why the guard exists: the build before this release marks a pack "expired" in its member pack list when
-- `expiresAt < now`, and in JavaScript `null < now` is true. During the deploy window, or afterwards while Vercel
-- Skew Protection keeps an older deployment serving clients that loaded it, that older build would mark a
-- no-expiry pack expired and the member would lose it. With this CHECK that write fails (the older build's list
-- request errors for that member) and the pack stays active. The current code never writes "expired" at all
-- (expiry is applied when reading), so for it the constraint is an invariant, not a behaviour change.
--
-- It can only ever bite a no-expiry pack, and no-expiry packs exist only once this release sells them: every pack
-- sold before it has a date. Dated packs are unaffected — marking a pack with a date expired is still allowed.
--
-- NOT VALID then VALIDATE: both statements run in this one transaction, so the lock the ADD takes is held
-- through the VALIDATE scan and writes to the table wait for it; the split buys nothing here (corrected 28 Oct
-- 2026). The table is small and the bounded waits above cap it, so the effect is negligible. It validates
-- because no existing row can break it: "expiresAt" was NOT NULL until 20261027120100, so every legacy
-- "expired" row (written only by the old list, from a past date) has a date; after 20261027120100 nothing writes
-- "expired". The Neon test branch was checked read-only on 28 Oct 2026: 0 "expired" rows with a NULL date.
ALTER TABLE "MemberClassPack" ADD CONSTRAINT "MemberClassPack_expired_needs_date_check"
  CHECK ("status" <> 'expired' OR "expiresAt" IS NOT NULL) NOT VALID;
ALTER TABLE "MemberClassPack" VALIDATE CONSTRAINT "MemberClassPack_expired_needs_date_check";

COMMIT;
