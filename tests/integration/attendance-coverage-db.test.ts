// Attendance coverage start is tenant-scoped (owner rule, 28 Oct 2026; lib/attendance-coverage.ts).
//
// A club's coverage start is the club-local day of ITS earliest attendance record of any method, imported history
// included. Another club's earlier records must not move it: if they did, a club with no records would read as
// "records start <someone else's date>" and its empty months would turn into zeros. Three synthetic clubs on the
// Neon TEST branch:
//   A: an imported visit on 3 Mar 2026 (its earliest) and a MatFlow check-in on 1 May 2026;
//   B: a MatFlow check-in on 10 Jun 2025 — earlier than anything of A's;
//   C: no attendance at all.
// Asserted through the raw read (inside withTenantContext, so RLS backs the filter under matflow_app) and through
// getReportsData, the Reports page's own load. Runs as both roles via the matflow-verify-local db-tests.mjs runner.
// Fixture prefix cov- (names, slugs, example.test addresses); torn down by tenant id.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

// getReportsData lives beside the cached wrapper; the cache is not under test and needs Next's runtime.
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn, revalidateTag: vi.fn() }));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { readAttendanceCoverageStart } from "@/lib/attendance-coverage";
import { getReportsData } from "@/lib/reports";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `cov-${Date.now().toString(36)}`;
const LONDON = "Europe/London";

type Club = { tenantId: string };
const made: string[] = [];

async function mkClub(label: string, visits: { at: string; method: string }[]): Promise<Club> {
  return withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: LONDON } });
    made.push(t.id);
    if (visits.length === 0) return { tenantId: t.id };
    const m = await tx.member.create({ data: { tenantId: t.id, name: `cov ${label} member`, email: `${STAMP}-${label}@example.test` } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: `cov ${label} class`, duration: 60 } });
    for (const v of visits) {
      const day = new Date(v.at);
      const inst = await tx.classInstance.create({
        data: { classId: cls.id, date: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())), startTime: "18:00", endTime: "19:00" },
      });
      await tx.attendanceRecord.create({
        data: { tenantId: t.id, memberId: m.id, classInstanceId: inst.id, checkInTime: day, checkInMethod: v.method },
      });
    }
    return { tenantId: t.id };
  });
}

describe.skipIf(!HAS_DB)("attendance coverage start is per club", () => {
  let A: Club;
  let B: Club;
  let C: Club;

  beforeAll(async () => {
    A = await mkClub("a", [
      { at: "2026-03-03T18:45:00.000Z", method: "import" },
      { at: "2026-05-01T18:10:00.000Z", method: "admin" },
    ]);
    B = await mkClub("b", [{ at: "2025-06-10T18:00:00.000Z", method: "admin" }]);
    C = await mkClub("c", []);
  }, 90_000);

  afterAll(async () => {
    if (made.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId: { in: made } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: made } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: made } } });
      await tx.member.deleteMany({ where: { tenantId: { in: made } } });
      await tx.tenant.deleteMany({ where: { id: { in: made } } });
    });
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { id: { in: made } } }));
    expect(left).toBe(0);
  }, 90_000);

  it("each club's start is its own earliest record (any method, imported included), at midnight club time", async () => {
    const a = await withTenantContext(A.tenantId, (tx) => readAttendanceCoverageStart(tx, A.tenantId, LONDON));
    const b = await withTenantContext(B.tenantId, (tx) => readAttendanceCoverageStart(tx, B.tenantId, LONDON));
    const c = await withTenantContext(C.tenantId, (tx) => readAttendanceCoverageStart(tx, C.tenantId, LONDON));
    // A's earliest is the IMPORTED visit, not its first MatFlow check-in; B's earlier record does not count for A.
    expect(a?.toISOString()).toBe("2026-03-03T00:00:00.000Z");
    // 10 Jun 2025 is BST: midnight in London is 23:00Z the day before.
    expect(b?.toISOString()).toBe("2025-06-09T23:00:00.000Z");
    // C has no records: no coverage, whatever the other clubs hold.
    expect(c).toBeNull();
  });

  it("the Reports load carries each club's own coverage", async () => {
    const a = await getReportsData(A.tenantId, { period: { period: "custom", from: "2026-01", to: "2026-02" } });
    expect(a.attendanceCoverage).toMatchObject({ start: "2026-03-03T00:00:00.000Z", period: "before" });
    expect(a.attendanceRate.value).toBeNull();

    const c = await getReportsData(C.tenantId, {});
    expect(c.attendanceCoverage).toMatchObject({ start: null, period: "none", previous: "none", thisWeek: "none", lastWeek: "none" });
    expect(c.weeklyAttendance.every((row) => row.coverage === "none")).toBe(true);
  }, 90_000);
});
