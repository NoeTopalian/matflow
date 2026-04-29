-- Sprint 4-A P (#20): Class.maxRankId for ranked-class booking gating.
-- Non-destructive: ADD COLUMN + ADD CONSTRAINT FK.

ALTER TABLE "Class" ADD COLUMN "maxRankId" TEXT;

ALTER TABLE "Class"
  ADD CONSTRAINT "Class_maxRankId_fkey"
  FOREIGN KEY ("maxRankId") REFERENCES "RankSystem"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
