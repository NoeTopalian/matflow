-- Sprint 3 K: Kids sub-accounts (self-relation Member.parentMemberId)
-- Non-destructive: ADD COLUMN + CREATE INDEX + ADD CONSTRAINT FK with onDelete SET NULL.

ALTER TABLE "Member" ADD COLUMN "parentMemberId" TEXT;
ALTER TABLE "Member" ADD COLUMN "hasKidsHint" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Member_parentMemberId_idx" ON "Member"("parentMemberId");

ALTER TABLE "Member"
  ADD CONSTRAINT "Member_parentMemberId_fkey"
  FOREIGN KEY ("parentMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
