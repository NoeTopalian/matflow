import ReportsView from "@/components/dashboard/ReportsView";
import { getReportsData } from "@/lib/reports";
import { requireRole } from "@/lib/authz";

export default async function ReportsPage() {
  // Audit iter-1-dashboard A4C-1: use centralised authz helper, not raw auth().
  const { session } = await requireRole(["owner", "manager"]);

  // UI-RULES §7: no try/catch here on purpose. This page used to fall back to
  // createEmptyReportsData() on failure, rendering a complete report of zeros
  // that is indistinguishable from a genuinely terrible month — the single
  // most dangerous shape of this bug, because an owner can act on it. A throw
  // now reaches app/dashboard/error.tsx and the owner is told the report
  // couldn't load, with a retry.
  const data = await getReportsData(session.user.tenantId);

  return (
    <ReportsView
      data={data}
      primaryColor={session.user.primaryColor}
    />
  );
}
