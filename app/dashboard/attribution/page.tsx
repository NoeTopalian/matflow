import { requireRole } from "@/lib/authz";
import { getAttributionData } from "@/lib/attribution";
import AttributionView from "@/components/dashboard/AttributionView";

/**
 * Attribution / conversion dashboard (M1). Owner + manager only, matching the
 * reports surface. "These coaches ran N trials, converted M — here's each
 * coach's %."
 */
export default async function AttributionPage() {
  const { session } = await requireRole(["owner", "manager"]);

  // UI-RULES §7: no try/catch here on purpose. A load failure must reach
  // app/dashboard/error.tsx and be shown as an error with retry, never a
  // fabricated report of zero conversions an owner could act on.
  const data = await getAttributionData(session.user.tenantId);

  return <AttributionView data={data} />;
}
