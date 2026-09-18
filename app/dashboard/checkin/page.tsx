import { requireStaff } from "@/lib/authz";
import AttendanceHub from "@/components/dashboard/AttendanceHub";

export const metadata = { title: "Mark Attendance | MatFlow" };

/**
 * The one attendance screen. The session list, the "today" window and the
 * on-now ordering all come from /api/coach/today (the club's day-marker band,
 * materialised on read), so this page no longer computes a process-zone
 * window of its own or preselects the earliest class of the day.
 */
export default async function CheckinPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; class?: string }>;
}) {
  const { mode, class: classId } = await searchParams;
  // All four staff roles: a coach marks attendance here. What a coach may
  // write is decided by the routes (the instructorId narrowing is gone at all
  // five sites), not by hiding the screen.
  const { session } = await requireStaff();
  return (
    <AttendanceHub
      initialMode={mode === "scan" ? "scan" : "tick"}
      preselectClassId={classId ?? null}
      role={session.user.role}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
    />
  );
}
