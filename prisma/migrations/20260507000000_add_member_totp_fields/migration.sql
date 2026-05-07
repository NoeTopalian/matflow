-- Add optional TOTP fields to Member (mirrors User shape).
-- Once totpEnabled flips true, the member cannot self-disable; only operator
-- (admin.member.totp_reset) or gym staff (member.totp_reset) can clear via
-- dedicated reset endpoints.
--
-- Safe on Neon (PG15+): ALTER TABLE ADD COLUMN with non-NULL default is
-- metadata-only since PG11; no rewrite, no row scan.

ALTER TABLE "Member" ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Member" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "Member" ADD COLUMN "totpRecoveryCodes" JSONB;
