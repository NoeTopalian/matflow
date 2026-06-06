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
  // Audit iter-3-database A8I3-P-H-1 [High]: top-level + nested select
  // throughout. Was: outer `include: { classInstance: { include: { class:
  // { select } } } }` returned ALL ClassInstance scalars (date, startTime,
  // endTime, isCancelled, cancellationReason, classId, tenantId,
  // deletedAt, createdAt, updatedAt) per row when only `date + startTime`
  // are used. Also dropped the redundant `member: { tenantId }` join —
  // the outer `tenantId` filter + RLS already enforce isolation.
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.attendanceRecord.findMany({
      where: { tenantId },
      select: {
        id: true,
        memberId: true,
        classInstanceId: true,
        checkInMethod: true,
        checkInTime: true,
        member: { select: { name: true } },
        classInstance: {
          select: {
            date: true,
            startTime: true,
            class: { select: { name: true } },
          },
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
  // Lane 1 iter-1 P-05 [Critical] fix: stop materialising every attendance
  // row in JS just to count it. The previous shape fetched up to ~50k rows/
  // month for a busy gym to compute three integers. Now: aggregate at the
  // DB and only fetch the small top-class probe.
  const result = await withTenantContext(tenantId, async (tx) => {
    const [totalThisMonth, totalThisWeek, uniqueMembersGroups, topClassBucket] = await Promise.all([
      tx.attendanceRecord.count({
        where: { tenantId, checkInTime: { gte: startOfMonth } },
      }),
      tx.attendanceRecord.count({
        where: { tenantId, checkInTime: { gte: startOfWeek } },
      }),
      tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: { tenantId, checkInTime: { gte: startOfMonth } },
      }),
      tx.attendanceRecord.groupBy({
        by: ["classInstanceId"],
        where: { tenantId, checkInTime: { gte: startOfMonth } },
        _count: true,
        orderBy: { _count: { classInstanceId: "desc" } },
        take: 1,
      }),
    ]);

    let topClass: string | null = null;
    const topId = topClassBucket[0]?.classInstanceId ?? null;
    if (topId) {
      const inst = await tx.classInstance.findFirst({
        where: { id: topId, class: { tenantId } },
        select: { class: { select: { name: true } } },
      });
      topClass = inst?.class.name ?? null;
    }
    return {
      totalThisMonth,
      totalThisWeek,
      uniqueMembersThisMonth: uniqueMembersGroups.length,
      topClass,
    };
  });

  return result;
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
