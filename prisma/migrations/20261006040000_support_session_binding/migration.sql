-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Support (impersonation) session binding, 6 Oct 2026. Additive, nullable, no
-- default, no backfill: safe on a live database. The one live support session
-- of an operator: SHA-256 of the nonce in the matflow_impersonation cookie and
-- its expiry. NULL = no live support session (every existing row).
ALTER TABLE "Operator" ADD COLUMN "supportNonceHash" TEXT;
ALTER TABLE "Operator" ADD COLUMN "supportExpiresAt" TIMESTAMP(3);

COMMIT;
