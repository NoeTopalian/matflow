-- Sprint 4-A Q (#21): Class.coachUserId FK replacing the free-text coachName string.
-- coachName is preserved for backward compatibility — code reads FK first then falls back.
-- Non-destructive: ADD COLUMN + ADD CONSTRAINT FK.

ALTER TABLE "Class" ADD COLUMN "coachUserId" TEXT;

ALTER TABLE "Class"
  ADD CONSTRAINT "Class_coachUserId_fkey"
  FOREIGN KEY ("coachUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
