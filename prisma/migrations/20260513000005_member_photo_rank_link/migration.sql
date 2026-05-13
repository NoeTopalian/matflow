ALTER TABLE "MemberPhoto" ADD COLUMN "memberRankId" TEXT;

ALTER TABLE "MemberPhoto"
  ADD CONSTRAINT "MemberPhoto_memberRankId_fkey"
  FOREIGN KEY ("memberRankId") REFERENCES "MemberRank"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MemberPhoto_memberRankId_idx"
  ON "MemberPhoto" ("memberRankId") WHERE "memberRankId" IS NOT NULL;
