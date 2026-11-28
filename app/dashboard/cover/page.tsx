import { requireStaff } from "@/lib/authz";
import CoverBoard from "@/components/dashboard/CoverBoard";

export const metadata = { title: "Class cover | MatFlow" };

/**
 * Session cover (Noe, 26 Nov 2026): every staff role. What each person may do to a session is decided by
 * POST /api/coach/instances/[id]/cover and shown from GET /api/coach/cover; this page only renders the board.
 */
export default async function CoverPage() {
  await requireStaff();
  return <CoverBoard />;
}
