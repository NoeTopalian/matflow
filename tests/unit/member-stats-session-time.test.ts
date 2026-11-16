// Member progress tells the truth about when training happened and when the club has no records (Round 10, 16 Nov 2026).
// F-1: a session is dated by when it RAN, not when the coach ticked the register. F-2 (owner rule, 28 Oct 2026): weeks
// after the club's records stop are "no records", never "did not train".
import { describe, expect, it, vi, afterEach } from "vitest";
import { computeMemberStats, computeWeeklyCounts } from "@/lib/member-stats";

type Row = { checkInTime: Date; classInstance: { date: Date; startTime: string; class: { id: string; name: string } } | null };

function fakeTx(rows: Row[], coverage: { lastImported: Date | null; first: Date | null; firstAfter: Date | null } = { lastImported: null, first: null, firstAfter: null }) {
  return {
    attendanceRecord: {
      findMany: vi.fn(async () => rows),
      // lib/attendance-coverage.ts readAttendanceCoverage: first record, last imported, first after the history end.
      findFirst: vi.fn(async (args: { where: Record<string, unknown>; orderBy: { checkInTime: "asc" | "desc" } }) => {
        if (args.where.OR) return coverage.lastImported ? { checkInTime: coverage.lastImported } : null;
        if (args.where.checkInTime) return coverage.firstAfter ? { checkInTime: coverage.firstAfter } : null;
        return coverage.first ? { checkInTime: coverage.first } : null;
      }),
    },
    importJob: { findFirst: vi.fn(async () => (coverage.lastImported ? { id: "job" } : null)) },
    classInstance: { findMany: vi.fn(async () => []) },
    memberRank: { findMany: vi.fn(async () => []) },
    member: { findFirst: vi.fn(async () => ({ membershipTierId: null })) },
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
  };
}

const cls = { id: "c1", name: "Adults Gi" };
/** A session on `day` (YYYY-MM-DD, its stored UTC-midnight marker) at `time`, ticked at `tickedAt`. */
const row = (day: string, time: string, tickedAt: string): Row => ({
  checkInTime: new Date(tickedAt),
  classInstance: { date: new Date(`${day}T00:00:00.000Z`), startTime: time, class: cls },
});

afterEach(() => vi.useRealTimers());

describe("F-1: training is dated by the session, not the tick", () => {
  it("a Sunday class ticked on Monday stays in Sunday's week: the streak holds and the heat strip shows Sunday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z")); // Wednesday 18 Nov
    // Weekly Sunday 18:00 class for four weeks; the 15 Nov register was caught up on Monday 16 Nov at 09:00.
    const rows = [
      row("2026-10-25", "18:00", "2026-10-25T18:05:00Z"),
      row("2026-11-01", "18:00", "2026-11-01T18:05:00Z"),
      row("2026-11-08", "18:00", "2026-11-08T18:05:00Z"),
      row("2026-11-15", "18:00", "2026-11-16T09:00:00Z"),
    ];
    const { stats } = await computeMemberStats(fakeTx(rows) as never, { memberId: "m1", tenantId: "t1" });
    // Week of Mon 9 Nov holds the 15 Nov class; this week (Mon 16 Nov) has nothing yet.
    const byWeek = Object.fromEntries(stats.weeklyCounts.map((w) => [w.weekStart, w.count]));
    expect(byWeek["2026-11-09"]).toBe(1);
    expect(byWeek["2026-11-16"]).toBe(0);
    expect(stats.thisWeek).toBe(0);
    expect(stats.streakWeeks).toBe(4);
    const lastClass = stats.weeklyCounts.find((w) => w.weekStart === "2026-11-09")!.classes[0];
    expect(lastClass.date).toBe("2026-11-15T18:00:00.000Z");
    expect(stats.noRecordsSince).toBeNull();
  });

  it("a record without a session time keeps its check-in time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const { stats } = await computeMemberStats(fakeTx([{ checkInTime: new Date("2026-11-17T10:00:00Z"), classInstance: null }]) as never, { memberId: "m1", tenantId: "t1" });
    expect(stats.thisWeek).toBe(1);
    expect(stats.totalClasses).toBe(1);
  });
});

describe("F-2: no club records is not 'did not train'", () => {
  it("after imported history ends with nothing recorded since, the stats carry noRecordsSince and the empty weeks are no-records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const rows = [row("2026-09-27", "18:00", "2026-09-27T17:00:00Z"), row("2026-10-02", "18:00", "2026-10-02T17:00:00Z")];
    const tx = fakeTx(rows, { first: new Date("2026-01-05T18:00:00Z"), lastImported: new Date("2026-10-02T17:00:00Z"), firstAfter: null });
    const { stats } = await computeMemberStats(tx as never, { memberId: "m1", tenantId: "t1" });
    expect(stats.noRecordsSince).toBe("2026-10-02T23:00:00.000Z"); // midnight after 2 Oct, London (BST)
    const after = stats.weeklyCounts.filter((w) => w.weekStart >= "2026-10-05");
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((w) => w.noRecords === true && w.count === 0)).toBe(true);
    // The week the records stop in still shows what was recorded.
    expect(stats.weeklyCounts.find((w) => w.weekStart === "2026-09-28")).toMatchObject({ count: 1 });
  });

  it("once the club records attendance again, there is no no-records span", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
    const tx = fakeTx([], { first: new Date("2026-01-05T18:00:00Z"), lastImported: new Date("2026-10-02T17:00:00Z"), firstAfter: new Date("2026-11-10T18:00:00Z") });
    const { stats } = await computeMemberStats(tx as never, { memberId: "m1", tenantId: "t1" });
    expect(stats.noRecordsSince).toBeNull();
    expect(stats.weeklyCounts.some((w) => w.noRecords)).toBe(false);
  });

  it("computeWeeklyCounts never marks a week with records, or any week without a no-records date", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const weeks = computeWeeklyCounts([{ checkInTime: new Date("2026-11-17T10:00:00Z"), className: "X" }], now, new Date("2026-10-03T00:00:00Z"));
    expect(weeks.at(-1)).toMatchObject({ count: 1 });
    expect(weeks.at(-1)!.noRecords).toBeUndefined();
    expect(computeWeeklyCounts([], now).some((w) => w.noRecords)).toBe(false);
  });
});

describe("F-4: the guardian's recent classes are in the club's time", () => {
  it("the child page formats check-in times with the club zone, not the server's", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/member/family/[childId]/page.tsx", "utf8");
    expect(src).toMatch(/checkInTime\.toLocaleTimeString\("en-GB", \{ hour: "2-digit", minute: "2-digit", timeZone: clubZone \}\)/);
    expect(src).toMatch(/clubZone: usableTimezone\(tenant\?\.timezone\)/);
  });
});
