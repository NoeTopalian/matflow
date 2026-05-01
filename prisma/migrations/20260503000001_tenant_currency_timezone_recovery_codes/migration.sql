-- Wizard v2 foundation: new fields for owner onboarding wizard + TOTP
-- recovery codes (Fix 4 follow-up).
--
-- Tenant fields:
--   currency           — CHECK (GBP | EUR | USD); default GBP. Drives default
--                        currency on new MembershipTier / ClassPack / Payment / Order rows.
--                        Existing rows unaffected (each carries its own currency string).
--   timezone           — IANA timezone string. Default Europe/London for the
--                        bulk of UK gyms. Used by class-instance generation +
--                        report timestamp formatting going forward.
--   address            — Free-text gym address. Receipts + waivers.
--   country            — CHECK (UK | IE | US | EU | OTHER). Drives default
--                        currency in the wizard + receipt formatting.
--
-- User field:
--   totpRecoveryCodes  — JSONB array of HMAC-SHA256 hashed recovery codes
--                        (one-time use). Generated in Wizard Step 2 post-enrolment.
--                        Consumed via /api/auth/totp/recover when an owner loses
--                        their authenticator device.
--
-- Lock posture: 5 ADD COLUMNs, all nullable or with constant defaults — these
-- are catalog-only operations on PostgreSQL (no table rewrite). The CHECK
-- constraints use the project's NOT VALID + VALIDATE pattern so adding them
-- doesn't lock during validation.

ALTER TABLE "Tenant" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'GBP';
ALTER TABLE "Tenant" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/London';
ALTER TABLE "Tenant" ADD COLUMN "address" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "country" TEXT;
ALTER TABLE "User" ADD COLUMN "totpRecoveryCodes" JSONB;

ALTER TABLE "Tenant" ADD CONSTRAINT tenant_currency_check
  CHECK ("currency" IN ('GBP','EUR','USD')) NOT VALID;
ALTER TABLE "Tenant" VALIDATE CONSTRAINT tenant_currency_check;

ALTER TABLE "Tenant" ADD CONSTRAINT tenant_country_check
  CHECK ("country" IS NULL OR "country" IN ('UK','IE','US','EU','OTHER')) NOT VALID;
ALTER TABLE "Tenant" VALIDATE CONSTRAINT tenant_country_check;
