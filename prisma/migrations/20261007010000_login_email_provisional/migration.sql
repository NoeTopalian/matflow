-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Provisional login identifier (7 Oct 2026). Additive, nullable, no default,
-- no backfill: safe on a live database, and every existing row reads as before.

-- Non-null = the login email is an identifier only, NOT a verified mailbox:
-- no reset code, sign-in link or external sign-in reaches it (lib/login-email.ts).
ALTER TABLE "User" ADD COLUMN "loginEmailProvisionalSince" TIMESTAMP(3);

-- Single-use staff TOTP for step-up confirmations: the last accepted time-step.
ALTER TABLE "User" ADD COLUMN "totpLastUsedStep" INTEGER;

COMMIT;
