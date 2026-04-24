-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "AttendanceRecord_memberId_checkInTime_idx" ON "AttendanceRecord"("memberId", "checkInTime");

-- CreateIndex
CREATE INDEX "ClassInstance_classId_date_idx" ON "ClassInstance"("classId", "date");

-- CreateIndex
CREATE INDEX "ClassInstance_date_isCancelled_idx" ON "ClassInstance"("date", "isCancelled");
