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

  // Audit iter-2-database A8I2-P-H-1: collapse into ONE withTenantContext.
  // Was: two separate `withTenantContext` acquisitions (the second only
  // when topInstanceId resolved, but that's the common case). The bucket
  // → resolve topClass pipeline now shares one connection.
  const { monthRecords, weekRecords, topClass } = await withTenantContext(tenantId, async (tx) => {
    const [month, week] = await Promise.all([
      tx.attendanceRecord.findMany({
        where: { tenantId, checkInTime: { gte: startOfMonth } },
        select: { memberId: true, classInstanceId: true },
      }),
      tx.attendanceRecord.findMany({
        where: { tenantId, checkInTime: { gte: startOfWeek } },
        select: { memberId: true },
      }),
    ]);

    // Find top class this month — bucket in JS, then resolve the class
    // name with one indexed PK lookup.
    const counts = new Map<string, number>();
    for (const r of month) counts.set(r.classInstanceId, (counts.get(r.classInstanceId) ?? 0) + 1);
    let topId: string | null = null;
    let topCount = 0;
    for (const [id, c] of counts) if (c > topCount) { topCount = c; topId = id; }

    let topName: string | null = null;
    if (topId) {
      const inst = await tx.classInstance.findFirst({
        where: { id: topId, class: { tenantId } },
        select: { class: { select: { name: true } } },
      });
      topName = inst?.class.name ?? null;
    }
    return { monthRecords: month, weekRecords: week, topClass: topName };
  });

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
