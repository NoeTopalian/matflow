-- Fix 3: cache Stripe Connect account capabilities on Tenant so checkout
-- routes can gate on charges_enabled / payouts_enabled / past-due
-- requirements without an extra round-trip to Stripe per request.
--
-- Refreshed on account.updated webhook (real-time) and lazy-refresh-on-stale.
-- See lib/stripe-account-status.ts.
--
-- Nullable: existing tenants get NULL on deploy. The first checkout per
-- tenant after deploy will trigger ensureCanAcceptCharges() to lazy-fetch
-- and persist; webhook subscriptions take it from there.

ALTER TABLE "Tenant" ADD COLUMN "stripeAccountStatus" JSONB;
