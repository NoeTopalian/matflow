-- Add Stripe linkage to MembershipTier so F2/F3 (member self-subscribe +
-- parent-pays-for-kid) can validate kid/adult tiers server-side instead
-- of trusting the client-supplied priceId.
--
-- Matches the existing ClassPack shape (stripePriceId / stripeProductId
-- on lines 682-683 of schema.prisma). Both fields are nullable so
-- existing tenants who never wired Stripe Connect don't break — owners
-- backfill once they're ready to use member-side billing.

ALTER TABLE "MembershipTier"
  ADD COLUMN "stripePriceId" TEXT,
  ADD COLUMN "stripeProductId" TEXT;
