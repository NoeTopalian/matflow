import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import WeeklyCalendar, { DayClass } from "@/components/dashboard/WeeklyCalendar";
import DashboardStats from "@/components/dashboard/DashboardStats";

async function getWeekClasses(tenantId: string): Promise<DayClass[]> {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const instances = await prisma.classInstance.findMany({
    where: {
      class: { tenantId },
      date: { gte: monday, lte: sunday },
      isCancelled: false,
    },
    include: {
      class: true,
      attendances: { select: { id: true } },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  return instances.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    time: inst.startTime,
    endTime: inst.endTime ?? undefined,
    coach: inst.class.coachName ?? "TBC",
    capacity: inst.class.maxCapacity ?? null,
    enrolled: inst.attendances.length,
    location: inst.class.location ?? undefined,
    date: inst.date.toISOString().split("T")[0],
  }));
}

async function getStats(tenantId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const [totalActive, newThisMonth, attendanceThisWeek, attendanceThisMonth] = await Promise.all([
    prisma.member.count({ where: { tenantId, status: "active" } }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
    prisma.attendanceRecord.count({
      where: { member: { tenantId }, checkInTime: { gte: startOfWeek } },
    }),
    prisma.attendanceRecord.count({
      where: { member: { tenantId }, checkInTime: { gte: startOfMonth } },
    }),
  ]);

  return { totalActive, newThisMonth, attendanceThisWeek, attendanceThisMonth };
}

export default async function DashboardPage() {
  const { session } = await requireStaff();

  let classes: DayClass[] = [];
  let stats = { totalActive: 0, newThisMonth: 0, attendanceThisWeek: 0, attendanceThisMonth: 0 };

  try {
    [classes, stats] = await Promise.all([
      getWeekClasses(session!.user.tenantId),
      getStats(session!.user.tenantId),
    ]);
  } catch {
    // DB not yet connected — empty state shown
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <DashboardStats
        stats={stats}
        userName={session!.user.name}
        primaryColor={session!.user.primaryColor}
      />
      <WeeklyCalendar
        classes={classes}
        primaryColor={session!.user.primaryColor}
      />
    </div>
  );
}
