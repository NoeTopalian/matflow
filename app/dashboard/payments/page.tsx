import { requireOwnerOrManager } from "@/lib/authz";
import PaymentsPageClient from "@/components/dashboard/PaymentsPageClient";

export const metadata = { title: "Payments | MatFlow" };

/**
 * /dashboard/payments — the money screen, gated server-side.
 *
 * This gate did not exist. The page was a client component whose own header
 * comment asserted that "the API enforces requireOwner() so any direct URL hit
 * by non-owners gets a redirect from the server" — a claim about the API, not
 * about the page. A coach who typed the URL got the full payments screen with
 * empty tables, which reads as "this club has no payments" rather than "you may
 * not see this".
 *
 * Owner AND manager, matching POST /api/payments/manual. Recording who has paid
 * is a manager's job at most clubs; letting them record a payment while hiding
 * who owes would leave the two halves of one workflow at different levels, and
 * a manager unable to see the list they are meant to work through.
 */
export default async function PaymentsPage() {
  await requireOwnerOrManager();
  return <PaymentsPageClient />;
}
