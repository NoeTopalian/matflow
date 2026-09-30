-- All-or-nothing: Prisma does not wrap a migration in a transaction (the 30 Sep
-- failure drill left a partial ALTER behind), so this one does it itself.
BEGIN;

-- F-3: an operator password reset flags the account until the user sets their own password.
-- Additive, nullable-equivalent (NOT NULL with a constant default is a metadata-only change on Postgres 11+).
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
