import { prisma } from "@/lib/prisma";

export interface ReportsData {
  summary: {
    totalMembers: number;
    activeMembers: number;
    inactiveMembers: number;
    cancelledMembers: number;
    tasterMembers: number;
    totalCheckIns: number;
    totalActiveClasses: number;
    attendanceThisWeek: number;
    attendanceLastWeek: number;
    newMembersThisMonth: number;
    newMembersLastMonth: number;
  };
  weeklyAttendance: { week: string; count: number; isCurrentWeek: boolean }[];
  monthlySignups: { month: string; count: number; isCurrentMonth: boolean }[];
  membersByStatus: { status: string; label: string; count: number; percentage: number }[];
  checkInMethods: { method: string; label: string; count: number; percentage: number }[];
  topClasses: {
    name: string;
    count: number;
    sessions: number;
    averageAttendance: number;
    fillRate: number | null;
  }[];
}

const DEFAULT_WEEKS = 12;

const METHOD_LABELS: Record<string, string> = {
  qr: "QR",
  admin: "Admin",
  self: "Self",
  auto: "Auto",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  cancelled: "Cancelled",
  taster: "Taster",
};

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampWeeks(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_WEEKS;
  return Math.min(Math.max(Math.trunc(value ?? DEFAULT_WEEKS), 4), 24);
}

function startOfWeek(date: Date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function formatWeek(date: Date) {
  return `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })}`;
}

function formatMonth(date: Date) {
  return date.toLocaleString("en-GB", { month: "short", year: "2-digit" });
}

function percent(count: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

function roundedAverage(total: number, sessions: number) {
  if (sessions <= 0) return 0;
  return Math.round((total / sessions) * 10) / 10;
}

export function createEmptyReportsData(): ReportsData {
  return {
    summary: {
      totalMembers: 0,
      activeMembers: 0,
      inactiveMembers: 0,
      cancelledMembers: 0,
      tasterMembers: 0,
      totalCheckIns: 0,
      totalActiveClasses: 0,
      attendanceThisWeek: 0,
      attendanceLastWeek: 0,
      newMembersThisMonth: 0,
      newMembersLastMonth: 0,
    },
    weeklyAttendance: [],
    monthlySignups: [],
    membersByStatus: [],
    checkInMethods: [],
    topClasses: [],
  };
}

export async function getReportsData(
  tenantId: string,
  options: { weeksBack?: number } = {},
): Promise<ReportsData> {
  const weeksBack = clampWeeks(options.weeksBack);
  const now = new Date();
  const currentWeekStart = startOfWeek(now);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const weeklyWindowStart = addDays(currentWeekStart, -(weeksBack - 1) * 7);
  const currentMonthStart = startOfMonth(now);
  const previousMonthStart = addMonths(currentMonthStart, -1);
  const sixMonthsAgo = addMonths(currentMonthStart, -5);

  const [
    weeklyRecords,
    methodCounts,
    memberStatusCounts,
    newMembers,
    topRaw,
    totalMembers,
    totalCheckIns,
    totalActiveClasses,
    attendanceThisWeek,
    attendanceLastWeek,
    newMembersThisMonth,
    newMembersLastMonth,
  ] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { member: { tenantId }, checkInTime: { gte: weeklyWindowStart } },
      select: { checkInTime: true },
      take: 10000,
    }).then((rows) => {
      if (rows.length === 10000) console.warn("[reports] truncated at 10000 rows (attendance window)");
      return rows;
    }),
    prisma.attendanceRecord.groupBy({
      by: ["checkInMethod"],
      where: { member: { tenantId } },
      _count: true,
    }),
    prisma.member.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: true,
    }),
    prisma.member.findMany({
      where: { tenantId, joinedAt: { gte: sixMonthsAgo } },
      select: { joinedAt: true },
      take: 5000,
    }).then((rows) => {
      if (rows.length === 5000) console.warn("[reports] truncated at 5000 rows (member-join window)");
      return rows;
    }),
    prisma.attendanceRecord.groupBy({
      by: ["classInstanceId"],
      where: { member: { tenantId } },
      _count: true,
      orderBy: { _count: { classInstanceId: "desc" } },
      take: 200,
    }),
    prisma.member.count({ where: { tenantId } }),
    prisma.attendanceRecord.count({ where: { member: { tenantId } } }),
    prisma.class.count({ where: { tenantId, isActive: true } }),
    prisma.attendanceRecord.count({
      where: { member: { tenantId }, checkInTime: { gte: currentWeekStart } },
    }),
    prisma.attendanceRecord.count({
      where: {
        member: { tenantId },
        checkInTime: { gte: previousWeekStart, lt: currentWeekStart },
      },
    }),
    prisma.member.count({ where: { tenantId, joinedAt: { gte: currentMonthStart } } }),
    prisma.member.count({
      where: {
        tenantId,
        joinedAt: { gte: previousMonthStart, lt: currentMonthStart },
      },
    }),
  ]);

  const weeklyMap = new Map<number, { week: string; count: number; isCurrentWeek: boolean }>();
  for (let i = 0; i < weeksBack; i++) {
    const d = addDays(weeklyWindowStart, i * 7);
    weeklyMap.set(d.getTime(), {
      week: formatWeek(d),
      count: 0,
      isCurrentWeek: d.getTime() === currentWeekStart.getTime(),
    });
  }

  for (const rec of weeklyRecords) {
    const week = startOfWeek(rec.checkInTime).getTime();
    const bucket = weeklyMap.get(week);
    if (bucket) bucket.count += 1;
  }

  const monthlyMap = new Map<string, { month: string; count: number; isCurrentMonth: boolean }>();
  for (let i = 5; i >= 0; i--) {
    const d = addMonths(currentMonthStart, -i);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthlyMap.set(key, {
      month: formatMonth(d),
      count: 0,
      isCurrentMonth: d.getTime() === currentMonthStart.getTime(),
    });
  }

  for (const member of newMembers) {
    const d = startOfMonth(member.joinedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = monthlyMap.get(key);
    if (bucket) bucket.count += 1;
  }

  const statusCount = new Map(memberStatusCounts.map((row) => [row.status, row._count]));
  const membersByStatus = memberStatusCounts
    .map((row) => ({
      status: row.status,
      label: STATUS_LABELS[row.status] ?? titleCase(row.status),
      count: row._count,
      percentage: percent(row._count, totalMembers),
    }))
    .sort((a, b) => b.count - a.count);

  const totalMethodCount = methodCounts.reduce((sum, row) => sum + row._count, 0);
  const checkInMethods = methodCounts
    .map((row) => ({
      method: row.checkInMethod,
      label: METHOD_LABELS[row.checkInMethod] ?? titleCase(row.checkInMethod),
      count: row._count,
      percentage: percent(row._count, totalMethodCount),
    }))
    .sort((a, b) => b.count - a.count);

  const instanceIds = topRaw.map((row) => row.classInstanceId);
  const instances = instanceIds.length
    ? await prisma.classInstance.findMany({
        where: { id: { in: instanceIds } },
        include: { class: { select: { name: true, maxCapacity: true } } },
      })
    : [];

  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  const classStats = new Map<
    string,
    { count: number; sessions: Set<string>; capacityTotal: number }
  >();

  for (const row of topRaw) {
    const instance = instancesById.get(row.classInstanceId);
    if (!instance) continue;

    const name = instance.class.name;
    const existing = classStats.get(name) ?? { count: 0, sessions: new Set<string>(), capacityTotal: 0 };
    existing.count += row._count;
    existing.sessions.add(row.classInstanceId);
    if (typeof instance.class.maxCapacity === "number" && instance.class.maxCapacity > 0) {
      existing.capacityTotal += instance.class.maxCapacity;
    }
    classStats.set(name, existing);
  }

  const topClasses = Array.from(classStats.entries())
    .map(([name, stats]) => {
      const sessions = stats.sessions.size;
      return {
        name,
        count: stats.count,
        sessions,
        averageAttendance: roundedAverage(stats.count, sessions),
        fillRate: stats.capacityTotal > 0 ? percent(stats.count, stats.capacityTotal) : null,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    summary: {
      totalMembers,
      activeMembers: statusCount.get("active") ?? 0,
      inactiveMembers: statusCount.get("inactive") ?? 0,
      cancelledMembers: statusCount.get("cancelled") ?? 0,
      tasterMembers: statusCount.get("taster") ?? 0,
      totalCheckIns,
      totalActiveClasses,
      attendanceThisWeek,
      attendanceLastWeek,
      newMembersThisMonth,
      newMembersLastMonth,
    },
    weeklyAttendance: Array.from(weeklyMap.values()),
    monthlySignups: Array.from(monthlyMap.values()),
    membersByStatus,
    checkInMethods,
    topClasses,
  };
}
