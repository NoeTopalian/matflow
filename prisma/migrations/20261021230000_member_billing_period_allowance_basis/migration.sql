-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- "N attendances per member's billing period" (owner scope, 21 Oct 2026).
-- A fourth allowance basis, "billing": each member's own period, from one
-- renewal date to the next. The period comes from the member, not the plan:
--   - Stripe-billed: the paid period stated on the last paid invoice, stored
--     here by the webhook (invoice.payment_succeeded, first line's period);
--   - desk / TeamUp-billed: derived at read time from "nextDueAt" and the
--     tier's billingCycle (no column needed).
-- Expand-only: two nullable timestamps, no default, no backfill. A member
-- with neither source is "period unknown": refused at member-decided doors,
-- asked about at staff doors (lib/class-allowance.ts withMemberBillingPeriod).

ALTER TABLE "Member" ADD COLUMN     "billingPeriodStart" TIMESTAMP(3),
ADD COLUMN     "billingPeriodEnd" TIMESTAMP(3);

-- The basis CHECK gains the fourth word. Same name, replaced in place.
ALTER TABLE "MembershipTier" DROP CONSTRAINT IF EXISTS "MembershipTier_classLimitBasis_check";
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_classLimitBasis_check"
  CHECK ("classLimitBasis" IS NULL OR "classLimitBasis" IN ('week', 'month', 'weeks', 'billing')) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_classLimitBasis_check";

COMMIT;
