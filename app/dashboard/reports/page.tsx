import ReportsView from "@/components/dashboard/ReportsView";
import { createEmptyReportsData, getReportsData } from "@/lib/reports";
import { requireRole } from "@/lib/authz";

export default async function ReportsPage() {
  // Audit iter-1-dashboard A4C-1: use centralised authz helper, not raw auth().
  const { session } = await requireRole(["owner", "manager"]);

  let data = createEmptyReportsData();

  try {
    data = await getReportsData(session.user.tenantId);
  } catch (error) {
    console.error("Failed to load reports data", error);
  }

  return (
    <ReportsView
      data={data}
      primaryColor={session.user.primaryColor}
    />
  );
}
