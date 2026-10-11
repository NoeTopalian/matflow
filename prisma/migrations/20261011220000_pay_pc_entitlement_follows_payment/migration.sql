-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PC, review round (11 Oct 2026). Additive only.
-- RP-2: entitlement follows payment, not sign-up. A MemberSubscription now
--   carries the tier the sign-up is for, the member's paymentStatus captured
--   at creation, and when it was first paid.
-- RP-10: lastEventCreated widened to BIGINT (Stripe event.created is unix
--   seconds; INTEGER overflows in 2038). Widening keeps every value.
-- RP-9: Tenant.stripeConnectedAt, set by the OAuth callback, so a
--   deauthorisation event from an earlier connection can be ignored.
ALTER TABLE "MemberSubscription" ADD COLUMN "membershipTierId" TEXT,
ADD COLUMN "priorPaymentStatus" TEXT,
ADD COLUMN "firstPaidAt" TIMESTAMP(3),
ALTER COLUMN "lastEventCreated" SET DATA TYPE BIGINT;

ALTER TABLE "Tenant" ADD COLUMN "stripeConnectedAt" TIMESTAMP(3);

COMMIT;
