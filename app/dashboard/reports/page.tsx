import { auth } from "@/auth";
import ReportsView from "@/components/dashboard/ReportsView";
import { createEmptyReportsData, getReportsData } from "@/lib/reports";
import { redirect } from "next/navigation";

export default async function ReportsPage() {
  const session = await auth();
  if (!session) redirect("/login");
  if (!["owner", "manager"].includes(session.user.role)) redirect("/dashboard");

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
