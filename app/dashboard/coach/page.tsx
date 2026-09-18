import { redirect } from "next/navigation";

export const metadata = { title: "Coach Register | MatFlow" };

/**
 * Today's Register is the "Tick names" section of Mark Attendance now (18 Sep
 * 2026): one attendance screen for every staff role, with the session on now
 * already selected. The old address keeps working.
 */
export default function CoachPage() {
  redirect("/dashboard/checkin");
}
