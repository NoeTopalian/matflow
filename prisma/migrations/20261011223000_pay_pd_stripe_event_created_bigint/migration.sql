-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PD (11 Oct 2026, review RP-10): StripeEvent.created holds
-- Stripe's event.created (unix seconds). INTEGER is 32-bit signed and runs out
-- in January 2038; BIGINT does not. A widening conversion: every existing value
-- is kept exactly; no row changes meaning.
ALTER TABLE "StripeEvent" ALTER COLUMN "created" TYPE BIGINT;

COMMIT;
