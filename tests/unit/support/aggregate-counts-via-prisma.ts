/**
 * Test double for lib/aggregate-counts.ts in unit tests that fake the Prisma client (no database, no $queryRaw).
 *
 * Each read is implemented with EXACTLY the Prisma calls it replaced in S3 (6 Nov 2026), so a unit test that mocks
 * `tx.attendanceRecord.count` / `tx.member.count` / `findFirst` keeps exercising its page's logic and the `where`
 * shapes it always asserted. That the SQL returns the same numbers as these calls is proved on a real database by
 * tests/integration/s3-aggregate-parity-db.test.ts, which runs this very code shape beside the SQL.
 *
 * Use: vi.mock("@/lib/aggregate-counts", () => import("./support/aggregate-counts-via-prisma"));
 * (adjust the relative path). Pure helpers are re-exported from the real module.
 */
import { vi } from "vitest";
import type {
  AtRiskGateProbes,
  AtRiskGateWindows,
  AttendanceScope,
  AttendanceSummaryCounts,
  CountWindow,
  DashboardCounts,
} from "@/lib/aggregate-counts";
import { ACTIVE_MEMBER, CAN_TRAIN_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { liveClassWhere } from "@/lib/class-live";

const actual = await vi.importActual<typeof import("@/lib/aggregate-counts")>("@/lib/aggregate-counts");
export const { windowCountsInOrder, attendanceSummaryFromRow, dashboardCountsFromRow, atRiskProbesFromRow } = actual;

// The fakes in the unit tests are loosely typed delegates; this is the slice of them these reads call.
type FakeTx = {
  attendanceRecord: {
    count(a: unknown): PromiseLike<number>;
    groupBy(a: unknown): PromiseLike<unknown[]>;
    findFirst(a: unknown): PromiseLike<{ checkInTime: Date } | null>;
  };
  member: { count(a: unknown): PromiseLike<number> };
  class: { count(a: unknown): PromiseLike<number> };
  membershipTier: { count(a: unknown): PromiseLike<number> };
};

export async function countAttendanceInWindows(tx: unknown, tenantId: string, windows: readonly CountWindow[], scope: AttendanceScope = {}): Promise<number[]> {
  const t = tx as FakeTx;
  const attendanceScope = {
    ...(scope.classId ? { classInstance: { classId: scope.classId } } : {}),
    ...(scope.accountTypes ? { member: { accountType: { in: [...scope.accountTypes] } } } : {}),
  };
  return Promise.all(windows.map((b) => t.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: b.start, lt: b.end }, ...attendanceScope } })));
}

export async function readAttendanceSummaryCounts(tx: unknown, tenantId: string, since: { monthStart: Date; weekStart: Date }): Promise<AttendanceSummaryCounts> {
  const t = tx as FakeTx;
  const [totalThisMonth, totalThisWeek, groups] = await Promise.all([
    t.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: since.monthStart } } }),
    t.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: since.weekStart } } }),
    t.attendanceRecord.groupBy({ by: ["memberId"], where: { tenantId, checkInTime: { gte: since.monthStart } } }),
  ]);
  return { totalThisMonth, totalThisWeek, uniqueMembersThisMonth: groups.length };
}

export async function readDashboardCounts(tx: unknown, tenantId: string, since: { monthStart: Date; weekStart: Date }): Promise<DashboardCounts> {
  const t = tx as FakeTx;
  const [totalActive, newThisMonth, attendanceThisWeek, attendanceThisMonth, waiverMissing, missingPhone, tierCount, liveClassCount, memberCount] =
    await Promise.all([
      t.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
      t.member.count({ where: { tenantId, joinedAt: { gte: since.monthStart }, ...TRAINING_MEMBER } }),
      t.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: since.weekStart } } }),
      t.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: since.monthStart } } }),
      t.member.count({ where: { tenantId, ...CAN_TRAIN_MEMBER, waiverAccepted: false } }),
      t.member.count({ where: { tenantId, ...CAN_TRAIN_MEMBER, OR: [{ phone: null }, { phone: "" }] } }),
      t.membershipTier.count({ where: { tenantId } }),
      t.class.count({ where: liveClassWhere(tenantId) }),
      t.member.count({ where: { tenantId } }),
    ]);
  return { totalActive, newThisMonth, attendanceThisWeek, attendanceThisMonth, waiverMissing, missingPhone, memberCount, liveClassCount, tierCount };
}

export async function readAtRiskGateProbes(tx: unknown, tenantId: string, w: AtRiskGateWindows): Promise<AtRiskGateProbes> {
  const t = tx as FakeTx;
  const probe = async (checkInTime: { gte?: Date; lt?: Date }, order: "asc" | "desc") =>
    (
      await t.attendanceRecord.findFirst({
        where: { tenantId, checkInMethod: { not: "import" }, importJobId: null, checkInTime },
        orderBy: { checkInTime: order },
        select: { checkInTime: true },
      })
    )?.checkInTime ?? null;
  const before = await probe({ gte: w.weekBefore, lt: w.since }, "desc");
  const first = await probe({ gte: w.since }, "asc");
  return {
    before,
    first,
    earlier: !before && !first ? await probe({ lt: w.weekBefore }, "desc") : null,
    firstHalf: before ? await probe({ gte: w.since, lt: w.mid }, "asc") : null,
    secondHalf: before ? await probe({ gte: w.mid }, "asc") : null,
  };
}
