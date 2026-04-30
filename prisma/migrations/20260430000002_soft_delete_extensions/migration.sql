-- Sprint 5 US-509: soft-delete columns on RankSystem and Class.
--
-- Distinct from Class.isActive which means "paused / not currently scheduled" —
-- deletedAt means "removed from the timeline, hidden from default queries".
-- Existing isActive logic is preserved (Class.isActive remains, but consumers
-- can layer deletedAt IS NULL on top for "delete" semantics).
--
-- Non-destructive: ADD COLUMN + CREATE INDEX. Backfill is implicit (NULL = not deleted).

ALTER TABLE "RankSystem" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "RankSystem_tenantId_deletedAt_idx" ON "RankSystem"("tenantId", "deletedAt");

ALTER TABLE "Class" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "Class_tenantId_deletedAt_idx" ON "Class"("tenantId", "deletedAt");
