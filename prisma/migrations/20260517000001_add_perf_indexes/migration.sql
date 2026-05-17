-- Add composite indexes on hot tenant-scoped tables identified by the
-- perf audit (docs/PERF-FIX-2026-05-17.md round 2). Reads on the dashboard,
-- notifications, announcements, and waiver-history pages can use an
-- index-scan instead of a sequential scan once tenant rowcounts grow.
--
-- Index inserts add ~5-15μs per row; reads typically drop 10-100x at
-- >1000 rows per tenant.

-- CreateIndex
CREATE INDEX "Member_tenantId_joinedAt_idx" ON "Member"("tenantId", "joinedAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_sentAt_idx" ON "Notification"("tenantId", "sentAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_memberId_read_idx" ON "Notification"("tenantId", "memberId", "read");

-- CreateIndex
CREATE INDEX "Announcement_tenantId_createdAt_idx" ON "Announcement"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Announcement_tenantId_pinned_createdAt_idx" ON "Announcement"("tenantId", "pinned", "createdAt");

-- CreateIndex
CREATE INDEX "SignedWaiver_tenantId_acceptedAt_idx" ON "SignedWaiver"("tenantId", "acceptedAt");
