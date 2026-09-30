-- All-or-nothing: Prisma does not wrap a migration in a transaction (the 30 Sep
-- failure drill left a partial ALTER behind), so this one does it itself.
BEGIN;

-- MembershipTier.billingCycle: widen the CHECK from {monthly, annual, none} to
-- add the week-based cycles a club migrating from another platform actually
-- bills on (weekly, fortnightly, every 4 weeks). Additive: every existing row
-- already satisfies the new set. The canonical list is lib/billing-cycle.ts.
ALTER TABLE "MembershipTier" DROP CONSTRAINT IF EXISTS "MembershipTier_billingCycle_check";
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_billingCycle_check"
  CHECK ("billingCycle" IN ('weekly', 'fortnightly', 'four_weekly', 'monthly', 'annual', 'none')) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_billingCycle_check";

COMMIT;
