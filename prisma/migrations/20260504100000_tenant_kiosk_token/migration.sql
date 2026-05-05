-- Kiosk check-in token columns on Tenant.
--
-- Per-gym public kiosk URL: /kiosk/<rawToken>. Server hashes the raw token
-- with HMAC-SHA256 (lib/token-hash.ts) and looks up Tenant.kioskTokenHash.
-- Raw token is shown ONCE on enable/regenerate and never persisted — same
-- pattern as MagicLinkToken / PasswordResetToken.
--
-- Owner controls lifecycle from settings → integrations:
--   enable      — mint a fresh token, store hash, set issuedAt
--   regenerate  — mint new + invalidate old in one update
--   disable     — null both columns; old URL 404s on next request
--
-- Both columns nullable; existing tenants land with kiosk disabled.

ALTER TABLE "Tenant" ADD COLUMN "kioskTokenHash"     TEXT;
ALTER TABLE "Tenant" ADD COLUMN "kioskTokenIssuedAt" TIMESTAMP(3);

-- Tenant has no tenantId column (its id IS the tenant id) so RLS already
-- isolates rows via the existing tenant_isolation policy. No new policy needed.
