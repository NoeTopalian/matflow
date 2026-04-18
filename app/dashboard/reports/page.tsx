import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import ReportsView, { ReportsData } from "@/components/dashboard/ReportsView";

async function getReportsData(tenantId: string): Promise<ReportsData> {
  const now = new Date();
  const WEEKS = 12;

  // Weekly attendance buckets
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7) - (WEEKS - 1) * 7);
  weekStart.setHours(0, 0, 0, 0);

  const allRecords = await prisma.attendanceRecord.findMany({
    where: { member: { tenantId }, checkInTime: { gte: weekStart } },
    select: { checkInTime: true, checkInMethod: true },
  });

  const weeklyMap = new Map<string, number>();
  for (let i = 0; i < WEEKS; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i * 7);
    const label = `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
    weeklyMap.set(label, 0);
  }
  for (const rec of allRecords) {
    const d = new Date(rec.checkInTime);
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    mon.setHours(0, 0, 0, 0);
    const label = `${mon.getDate()} ${mon.toLocaleString("en-GB", { month: "short" })}`;
    if (weeklyMap.has(label)) weeklyMap.set(label, (weeklyMap.get(label) ?? 0) + 1);
  }
  const weeklyAttendance = Array.from(weeklyMap.entries()).map(([week, count]) => ({ week, count }));

  // Check-in method breakdown
  const methodCounts = await prisma.attendanceRecord.groupBy({
    by: ["checkInMethod"],
    where: { member: { tenantId } },
    _count: true,
  });
  const checkInMethods = methodCounts.map((m) => ({ method: m.checkInMethod, count: m._count }));

  // Member status breakdown
  const memberStatusCounts = await prisma.member.groupBy({
    by: ["status"],
    where: { tenantId },
    _count: true,
  });
  const membersByStatus = memberStatusCounts.map((m) => ({ status: m.status, count: m._count }));

  // Monthly signups (last 6 months)
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const newMembers = await prisma.member.findMany({
    where: { tenantId, joinedAt: { gte: sixMonthsAgo } },
    select: { joinedAt: true },
  });
  const monthlyMap = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    monthlyMap.set(label, 0);
  }
  for (const m of newMembers) {
    const label = m.joinedAt.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    if (monthlyMap.has(label)) monthlyMap.set(label, (monthlyMap.get(label) ?? 0) + 1);
  }
  const monthlySignups = Array.from(monthlyMap.entries()).map(([month, count]) => ({ month, count }));

  // Top 5 classes
  const topRaw = await prisma.attendanceRecord.groupBy({
    by: ["classInstanceId"],
    where: { member: { tenantId } },
    _count: true,
    orderBy: { _count: { classInstanceId: "desc" } },
    take: 100,
  });
  const instanceIds = topRaw.map((t) => t.classInstanceId);
  const instances = await prisma.classInstance.findMany({
    where: { id: { in: instanceIds } },
    include: { class: { select: { name: true } } },
  });
  const classNameMap = new Map<string, number>();
  for (const t of topRaw) {
    const inst = instances.find((i) => i.id === t.classInstanceId);
    if (!inst) continue;
    const name = inst.class.name;
    classNameMap.set(name, (classNameMap.get(name) ?? 0) + t._count);
  }
  const topClasses = Array.from(classNameMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // Summary
  const [totalMembers, totalCheckIns, totalActiveClasses] = await Promise.all([
    prisma.member.count({ where: { tenantId } }),
    prisma.attendanceRecord.count({ where: { member: { tenantId } } }),
    prisma.class.count({ where: { tenantId, isActive: true } }),
  ]);

  return {
    summary: { totalMembers, totalCheckIns, totalActiveClasses },
    weeklyAttendance,
    monthlySignups,
    membersByStatus,
    checkInMethods,
    topClasses,
  };
}

export default async function ReportsPage() {
  const session = await auth();

  let data: ReportsData = {
    summary: { totalMembers: 0, totalCheckIns: 0, totalActiveClasses: 0 },
    weeklyAttendance: [],
    monthlySignups: [],
    membersByStatus: [],
    checkInMethods: [],
    topClasses: [],
  };

  try {
    data = await getReportsData(session!.user.tenantId);
  } catch {
    // DB not connected
  }

  return (
    <>
      <div className="mx-4 mt-4 px-4 py-2.5 rounded-xl text-xs text-amber-400 font-medium" style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)" }}>
        📊 Report exports and scheduled emails are coming soon.
      </div>
      <ReportsView
        data={data}
        primaryColor={session!.user.primaryColor}
      />
    </>
  );
}
