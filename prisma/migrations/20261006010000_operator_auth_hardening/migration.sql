-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Operator auth hardening (6 Oct 2026). Additive, nullable, no default, no
-- backfill: safe on a live database, and every existing row reads as before.

-- Single-use operator TOTP: the last accepted time-step.
ALTER TABLE "Operator" ADD COLUMN "totpLastUsedStep" INTEGER;

-- Single-use step-up grant: hash of the outstanding nonce and its expiry.
ALTER TABLE "Operator" ADD COLUMN "stepUpNonceHash" TEXT;
ALTER TABLE "Operator" ADD COLUMN "stepUpExpiresAt" TIMESTAMP(3);

-- Temporary-password expiry. NULL = no expiry recorded (all existing rows).
ALTER TABLE "User" ADD COLUMN "tempPasswordExpiresAt" TIMESTAMP(3);

COMMIT;
