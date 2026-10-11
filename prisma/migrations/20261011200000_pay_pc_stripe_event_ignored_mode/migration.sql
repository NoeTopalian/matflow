-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PC (11 Oct 2026): a verified webhook event whose livemode does
-- not match the platform key (a test-mode event reaching the live Connect
-- endpoint, or the reverse) is now acknowledged with 200 and recorded as
-- "ignored_mode" instead of being refused with 400, so Stripe never retries
-- it for three days or disables the endpoint. The status CHECK from
-- 20261011180000_pay_pd_stripe_event_store gains that one value. Additive: no
-- existing row changes, every existing value stays valid.

ALTER TABLE "StripeEvent" DROP CONSTRAINT "StripeEvent_status_check";
ALTER TABLE "StripeEvent" ADD CONSTRAINT "StripeEvent_status_check"
  CHECK ("status" IN ('received', 'processed', 'failed', 'ignored_foreign', 'ignored_stale', 'ignored_mode', 'replayed'));

COMMIT;
