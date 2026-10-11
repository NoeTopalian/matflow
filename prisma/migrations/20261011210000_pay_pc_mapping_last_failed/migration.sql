-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PC, round 3 (11 Oct 2026): the last failed payment attempt on
-- a MemberSubscription. A failed FIRST invoice (the payer is still on the
-- payment form) is recorded here and on the Payment row only, never as
-- overdue or dunning. Additive, nullable: no existing row changes.
ALTER TABLE "MemberSubscription" ADD COLUMN "lastPaymentFailedAt" TIMESTAMP(3);
ALTER TABLE "MemberSubscription" ADD COLUMN "lastFailedInvoiceId" TEXT;

COMMIT;
