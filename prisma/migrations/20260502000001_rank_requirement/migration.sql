-- Assessment Fix #1: per-rank-system thresholds for "ready for promotion"
-- suggestions. Owner can override per discipline; sensible defaults
-- (30 attendances + 6 months) when no row exists for a given rankSystem.
--
-- Catalog-only ADD TABLE — no data backfill needed. Existing tenants
-- get default thresholds via the app-layer fallback in lib/promotion-candidates.ts
-- until they explicitly set custom values via the (forthcoming) Settings UI.

CREATE TABLE "RankRequirement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "rankSystemId" TEXT NOT NULL,
    "minAttendances" INTEGER NOT NULL DEFAULT 30,
    "minMonths" INTEGER NOT NULL DEFAULT 6,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RankRequirement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RankRequirement_rankSystemId_key" ON "RankRequirement"("rankSystemId");
CREATE INDEX "RankRequirement_tenantId_idx" ON "RankRequirement"("tenantId");

ALTER TABLE "RankRequirement" ADD CONSTRAINT "RankRequirement_rankSystemId_fkey"
  FOREIGN KEY ("rankSystemId") REFERENCES "RankSystem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
