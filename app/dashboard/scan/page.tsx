import { redirect } from "next/navigation";

export const metadata = { title: "Scan Cards | MatFlow" };

/**
 * Scan Cards is a section of Mark Attendance now (Noe, 18 Sep 2026: "the scan
 * cards should be a section under mark attendance"). Bookmarks, the demo
 * script and the older specs land in the right place.
 */
export default function ScanPage() {
  redirect("/dashboard/checkin?mode=scan");
}
