import { requireStaff } from "@/lib/authz";
import CardScanner from "@/components/dashboard/CardScanner";

export const metadata = { title: "Scan Cards | MatFlow" };

/**
 * Staff surface for scanning printed member ID cards into a class register.
 *
 * `requireStaff()` is explicit rather than inherited. The dashboard layout
 * gates too, but the batch endpoint behind this page writes attendance, so the
 * page that reaches it states its own requirement instead of depending on a
 * parent that a later refactor could loosen.
 */
export default async function ScanPage() {
  await requireStaff();
  return <CardScanner />;
}
