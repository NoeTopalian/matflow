-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Review H-1 (21 Oct 2026): the every-N-weeks CHECK from
-- 20261021140000_tier_class_allowance_basis accepted basis 'weeks' with a
-- NULL "classLimitWeeks": `NULL BETWEEN 2 AND 8` is NULL, `NULL OR FALSE` is
-- NULL, and a CHECK whose expression is NULL passes. Such a row would then
-- read as Unlimited. Both migrations belong to the same unreleased build;
-- the constraint is replaced rather than the earlier file edited, so a test
-- branch that already applied it stays in step with the checksums.
ALTER TABLE "MembershipTier" DROP CONSTRAINT IF EXISTS "MembershipTier_classLimitWeeks_check";
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_classLimitWeeks_check"
  CHECK (
    ("classLimitBasis" = 'weeks' AND "classLimitWeeks" IS NOT NULL AND "classLimitWeeks" BETWEEN 2 AND 8 AND "classLimitAnchor" IS NOT NULL)
    OR ("classLimitBasis" IS DISTINCT FROM 'weeks' AND "classLimitWeeks" IS NULL AND "classLimitAnchor" IS NULL)
  ) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_classLimitWeeks_check";

COMMIT;
