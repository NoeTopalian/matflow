import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import AttendanceView from "@/components/dashboard/AttendanceView";

export type AttendanceRow = {
  id: string;
  memberName: string;
  memberId: string;
  className: string;
  classInstanceId: string;
  date: string;      // "2026-03-10"
  startTime: string; // "18:00"
  checkInMethod: string;
  checkInTime: string; // ISO
  checkedInByName: string | null; // staff user who clicked "check in" — null for self/kiosk/auto
};

export type AttendanceSummary = {
  totalThisMonth: number;
  totalThisWeek: number;
  uniqueMembersThisMonth: number;
  topClass: string | null;
};

async function getRecentAttendance(tenantId: string, limit = 100): Promise<AttendanceRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.attendanceRecord.findMany({
      where: { tenantId, member: { tenantId } },
      include: {
        member: { select: { name: true } },
        classInstance: {
          include: { class: { select: { name: true } } },
        },
        checkedInByUser: { select: { name: true } },
      },
      orderBy: { checkInTime: "desc" },
      take: limit,
    }),
  );

  return rows.map((r) => ({
    id: r.id,
    memberName: r.member.name,
    memberId: r.memberId,
    className: r.classInstance.class.name,
    classInstanceId: r.classInstanceId,
    date: r.classInstance.date.toISOString().split("T")[0],
    startTime: r.classInstance.startTime,
    checkInMethod: r.checkInMethod,
    checkInTime: r.checkInTime.toISOString(),
    checkedInByName: r.checkedInByUser?.name ?? null,
  }));
}

async function getSummary(tenantId: string): Promise<AttendanceSummary> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);

  const [monthRecords, weekRecords] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.attendanceRecord.findMany({
        where: {
          tenantId,
          checkInTime: { gte: startOfMonth },
        },
        select: { memberId: true, classInstanceId: true },
      }),
      tx.attendanceRecord.findMany({
        where: {
          tenantId,
          checkInTime: { gte: startOfWeek },
        },
        select: { memberId: true },
      }),
    ]),
  );

  // Find top class this month
  const classCounts = new Map<string, number>();
  for (const r of monthRecords) {
    classCounts.set(r.classInstanceId, (classCounts.get(r.classInstanceId) ?? 0) + 1);
  }
  let topInstanceId: string | null = null;
  let topCount = 0;
  for (const [id, count] of classCounts) {
    if (count > topCount) { topCount = count; topInstanceId = id; }
  }

  let topClass: string | null = null;
  if (topInstanceId) {
    const inst = await withTenantContext(tenantId, (tx) =>
      tx.classInstance.findFirst({
        where: { id: topInstanceId, class: { tenantId } },
        include: { class: { select: { name: true } } },
      }),
    );
    topClass = inst?.class.name ?? null;
  }

  return {
    totalThisMonth: monthRecords.length,
    totalThisWeek: weekRecords.length,
    uniqueMembersThisMonth: new Set(monthRecords.map((r) => r.memberId)).size,
    topClass,
  };
}

export default async function AttendancePage() {
  const { session } = await requireStaff();

  let records: AttendanceRow[] = [];
  let summary: AttendanceSummary = {
    totalThisMonth: 0,
    totalThisWeek: 0,
    uniqueMembersThisMonth: 0,
    topClass: null,
  };

  try {
    [records, summary] = await Promise.all([
      getRecentAttendance(session!.user.tenantId),
      getSummary(session!.user.tenantId),
    ]);
  } catch {
    // DB not connected
  }

  return (
    <AttendanceView
      records={records}
      summary={summary}
      primaryColor={session!.user.primaryColor}
    />
  );
}
