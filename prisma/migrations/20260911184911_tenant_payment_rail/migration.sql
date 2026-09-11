-- Tenant.paymentRail — how a club takes money from its members.
--
-- The onboarding wizard has always offered "Pay at desk only — members pay
-- cash or card at reception. No online charges." Choosing it persisted a
-- single unrelated BACS flag, and NOTHING anywhere read a payment rail: the
-- shop's behaviour came from a platform-wide environment variable, so a club
-- that explicitly chose no online charges still got a Stripe checkout. This
-- column is what makes that choice real.
--
-- Additive and nullable, so it is safe on a populated table and needs no
-- backfill: NULL means "not chosen", and callers fall back to whether Stripe
-- is connected, which is exactly today's behaviour.
ALTER TABLE "Tenant" ADD COLUMN "paymentRail" TEXT;

-- ---------------------------------------------------------------------------
-- Everything below is PRE-EXISTING DRIFT between prisma/schema.prisma and the
-- test database, which `prisma migrate dev` swept into this migration because
-- it reconciles every difference it finds, not just the one you asked for.
--
-- It is kept (so schema and database agree) but made CONDITIONAL. Production
-- may or may not carry the same drift, and an unconditional DROP or RENAME of
-- something that is not there fails the migration — which does not merely fail
-- one deploy: Prisma leaves the attempt recorded unfinished, every later
-- `migrate deploy` aborts on it, and no further deploy can land until someone
-- runs a recovery command by hand against production. Guarding these makes
-- them no-ops wherever they have already happened.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'LoginEvent_tenantId_fkey' AND conrelid = '"LoginEvent"'::regclass
  ) THEN
    ALTER TABLE "LoginEvent" DROP CONSTRAINT "LoginEvent_tenantId_fkey";
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'MagicLinkToken_token_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'MagicLinkToken_tokenHash_key') THEN
    ALTER INDEX "MagicLinkToken_token_key" RENAME TO "MagicLinkToken_tokenHash_key";
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'PasswordResetToken_token_key')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'PasswordResetToken_tokenHash_key') THEN
    ALTER INDEX "PasswordResetToken_token_key" RENAME TO "PasswordResetToken_tokenHash_key";
  END IF;
END
$$;
