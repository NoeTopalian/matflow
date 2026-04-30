import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import AnalysisView from "@/components/dashboard/AnalysisView";

export const metadata = { title: "Analysis | MatFlow" };

export default async function AnalysisPage() {
  const session = await auth();
  if (!session) redirect("/login");
  if (session.user.role !== "owner") redirect("/dashboard");

  const tenantId = session.user.tenantId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    totalMembers,
    newThisMonth,
    newLastMonth,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    statusGroups,
    monthlyCheckIns,
    // Distinct member IDs that checked in at least once this month — used to
    // compute a true engagement % bounded by total membership (was previously
    // computed as `checkins / members` and could blow past 100%).
    activeMemberIdsThisMonth,
  ] = await Promise.all([
    prisma.member.count({ where: { tenantId, status: "active" } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.attendanceRecord.count({ where: { classInstance: { class: { tenantId } }, checkInTime: { gte: startOfMonth } } }),
    prisma.attendanceRecord.count({ where: { classInstance: { class: { tenantId } }, checkInTime: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.class.count({ where: { tenantId, isActive: true } }),
    prisma.member.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
    prisma.attendanceRecord.findMany({
      where: { classInstance: { class: { tenantId } }, checkInTime: { gte: sixMonthsAgo } },
      select: { checkInTime: true },
    }),
    prisma.attendanceRecord.findMany({
      where: { classInstance: { class: { tenantId } }, checkInTime: { gte: startOfMonth } },
      select: { memberId: true },
      distinct: ["memberId"],
    }),
  ]);

  const activeMembersThisMonth = activeMemberIdsThisMonth.length;

  const monthlyTrend: { label: string; value: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthlyTrend.push({
      label: d.toLocaleString("en-GB", { month: "short" }),
      value: 0,
    });
  }
  for (const rec of monthlyCheckIns) {
    const ageMonths = (now.getFullYear() - rec.checkInTime.getFullYear()) * 12 + (now.getMonth() - rec.checkInTime.getMonth());
    const idx = 5 - ageMonths;
    if (idx >= 0 && idx < 6) monthlyTrend[idx].value += 1;
  }

  const STATUS_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive", cancelled: "Cancelled", taster: "Taster" };
  const membersByStatus = statusGroups
    .map((g) => ({ status: g.status, label: STATUS_LABELS[g.status] ?? g.status, count: g._count }))
    .sort((a, b) => b.count - a.count);

  const metrics = {
    totalMembers,
    newThisMonth,
    newLastMonth,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    activeMembersThisMonth,
    monthLabel: now.toLocaleString("default", { month: "long", year: "numeric" }),
    gymName: session.user.tenantName,
    membersByStatus,
    monthlyTrend,
  };

  return <AnalysisView metrics={metrics} primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
