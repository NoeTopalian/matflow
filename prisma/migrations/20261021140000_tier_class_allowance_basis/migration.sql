-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Product decision (Noe, 20 Oct 2026): a plan's class allowance resets on an
-- EXPLICIT basis, never a rolling window. "classLimit" classes per period:
--   basis "week"  = each calendar week (Monday start);
--   basis "month" = each calendar month;
--   basis "weeks" = every "classLimitWeeks" weeks (2-8), counted from the
--                   plan's "classLimitAnchor" date (per plan; see
--                   docs/readiness/CLASS-ALLOWANCE-RESET-MODEL-2026-10-21.md).
-- All NULL = Unlimited. The reader rule (lib/class-allowance.ts) also reads a
-- non-null legacy "maxClassesPerWeek" with no basis as N each calendar week.
--
-- Expand-only on top of 20261017052858_tier_class_allowance (same release,
-- never deployed): two nullable columns, no default, no backfill. The pair
-- CHECK from that migration is replaced by CHECKs that describe the new set;
-- every existing row is NULL in every allowance column, so validation is
-- instant. "maxClassesPerWeek" is neither dropped nor renamed (the previous
-- build reads and edits it; an INSERT from it leaves the new columns NULL).

ALTER TABLE "MembershipTier" ADD COLUMN     "classLimitBasis" TEXT,
ADD COLUMN     "classLimitAnchor" DATE;

ALTER TABLE "MembershipTier" DROP CONSTRAINT IF EXISTS "MembershipTier_classLimit_pair_check";
ALTER TABLE "MembershipTier" DROP CONSTRAINT IF EXISTS "MembershipTier_classLimitWeeks_check";

-- The basis is one of three words.
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_classLimitBasis_check"
  CHECK ("classLimitBasis" IS NULL OR "classLimitBasis" IN ('week', 'month', 'weeks')) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_classLimitBasis_check";

-- A limit and a basis are set together or cleared together.
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_classLimit_basis_pair_check"
  CHECK (("classLimit" IS NULL) = ("classLimitBasis" IS NULL)) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_classLimit_basis_pair_check";

-- Every N weeks needs the weeks (2-8) and the start date; any other basis has neither.
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_classLimitWeeks_check"
  CHECK (
    ("classLimitBasis" = 'weeks' AND "classLimitWeeks" BETWEEN 2 AND 8 AND "classLimitAnchor" IS NOT NULL)
    OR ("classLimitBasis" IS DISTINCT FROM 'weeks' AND "classLimitWeeks" IS NULL AND "classLimitAnchor" IS NULL)
  ) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_classLimitWeeks_check";

COMMIT;
