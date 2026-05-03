-- Account lockout columns on User and Member.
--
-- Adds:
--   failedLoginCount  — count of consecutive failed bcrypt comparisons
--   lockedUntil       — if set and in the future, all login attempts reject
--                       without running bcrypt. Cleared on successful login.
--
-- Both columns are nullable / default so existing rows don't violate NOT NULL.
-- Failed-count is reset to 0 on every successful login. Lock duration is
-- 1 hour (set by auth.ts).

ALTER TABLE "User" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "lockedUntil" TIMESTAMP(3);
CREATE INDEX "User_lockedUntil_idx" ON "User"("lockedUntil");

ALTER TABLE "Member" ADD COLUMN "failedLoginCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Member" ADD COLUMN "lockedUntil" TIMESTAMP(3);
CREATE INDEX "Member_lockedUntil_idx" ON "Member"("lockedUntil");
