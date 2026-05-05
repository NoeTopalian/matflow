-- Record which admin/staff member checked someone in.
--
-- AttendanceRecord today captures `checkInMethod` (admin / self / kiosk /
-- auto) but not WHICH admin. This adds a nullable FK to User so the
-- attendance log + audit trail can show "checked in by Noe" next to
-- admin-method rows. Self / kiosk / auto entries leave the column null.
--
-- Existing rows are not backfilled — they stay null. ON DELETE SET NULL so
-- a deleted staff user doesn't cascade into deleting attendance rows.

ALTER TABLE "AttendanceRecord" ADD COLUMN "checkedInById" TEXT;

ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_checkedInById_fkey"
  FOREIGN KEY ("checkedInById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AttendanceRecord_checkedInById_idx" ON "AttendanceRecord"("checkedInById");
