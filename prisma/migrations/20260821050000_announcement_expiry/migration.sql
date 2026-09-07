-- Temporary announcements (Noe, 2026-08-21): expiresAt NULL = permanent.
-- Expired rows are hidden from member reads but kept for staff, so this is
-- purely additive — no backfill, no data movement.
ALTER TABLE "Announcement" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Backs the member-facing filter (expiresAt IS NULL OR expiresAt > now()).
CREATE INDEX "Announcement_tenantId_expiresAt_idx" ON "Announcement"("tenantId", "expiresAt");
