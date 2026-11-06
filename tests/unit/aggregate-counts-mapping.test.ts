// S3 (6 Nov 2026): the mapping half of lib/aggregate-counts.ts — raw rows to the figures the pages read, and the
// At-Risk gate rule over its probes. The SQL half is held equal to the Prisma reads it replaced by
// tests/integration/s3-aggregate-parity-db.test.ts, on a real database.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  atRiskProbesFromRow,
  attendanceSummaryFromRow,
  countAttendanceInWindows,
  dashboardCountsFromRow,
  windowCountsInOrder,
  type AtRiskGateProbes,
} from "@/lib/aggregate-counts";
import { AT_RISK_DAYS, atRiskGateFromProbes, atRiskGateWindows, atRiskWindowStart } from "@/lib/dashboard-action-items";

const none: AtRiskGateProbes = { before: null, first: null, earlier: null, firstHalf: null, secondHalf: null };
const d = (iso: string) => new Date(iso);

describe("windowCountsInOrder", () => {
  it("puts each count at its window's position, 1-based rows, and reads a missing window as 0", () => {
    expect(windowCountsInOrder([{ i: 3, n: 7 }, { i: 1, n: 2 }], 4)).toEqual([2, 0, 7, 0]);
  });
  it("accepts bigint and numeric-string values from the driver", () => {
    expect(windowCountsInOrder([{ i: BigInt(1), n: BigInt(5) }, { i: "2", n: "11" }], 2)).toEqual([5, 11]);
  });
  it("is empty for no windows", () => {
    expect(windowCountsInOrder([], 0)).toEqual([]);
  });
});

describe("countAttendanceInWindows", () => {
  it("sends no statement for no windows", async () => {
    const $queryRaw = vi.fn();
    expect(await countAttendanceInWindows({ $queryRaw } as never, "t1", [])).toEqual([]);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it("passes the windows as ISO strings, the tenant, and null for an absent filter", async () => {
    const $queryRaw = vi.fn(async () => [{ i: 1, n: 4 }, { i: 2, n: 0 }]);
    const windows = [
      { start: d("2026-10-26T00:00:00.000Z"), end: d("2026-11-01T00:00:00.000Z") },
      { start: d("2026-11-01T00:00:00.000Z"), end: d("2026-11-02T00:00:00.000Z") },
    ];
    expect(await countAttendanceInWindows({ $queryRaw } as never, "t1", windows)).toEqual([4, 0]);
    const values = ($queryRaw.mock.calls[0] as unknown[]).slice(1);
    expect(values).toContainEqual(["2026-10-26T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(values).toContainEqual(["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"]);
    expect(values).toContain("t1");
    expect(values.filter((v) => v === null)).toHaveLength(4); // classId twice, accountTypes twice
  });
});

describe("row mappers", () => {
  it("read every dashboard figure, defaulting a missing row to zeros", () => {
    const row = { totalActive: 5, newThisMonth: 1, attendanceThisWeek: 9, attendanceThisMonth: 30, waiverMissing: 2, missingPhone: 3, memberCount: 8, liveClassCount: 4, tierCount: 2 };
    expect(dashboardCountsFromRow(row)).toEqual(row);
    expect(Object.values(dashboardCountsFromRow(undefined))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("read the attendance summary", () => {
    expect(attendanceSummaryFromRow({ totalThisMonth: BigInt(12), totalThisWeek: 3, uniqueMembersThisMonth: "7" })).toEqual({
      totalThisMonth: 12,
      totalThisWeek: 3,
      uniqueMembersThisMonth: 7,
    });
  });

  it("read probe epochs as Dates rounded to the millisecond, and nulls as null", () => {
    const ms = Date.UTC(2026, 9, 20, 18, 5, 0, 123);
    const p = atRiskProbesFromRow({ before: ms - 0.0001, first: ms, earlier: null, firstHalf: undefined, secondHalf: ms + 1000 });
    expect(p.before?.getTime()).toBe(ms);
    expect(p.first?.getTime()).toBe(ms);
    expect(p.earlier).toBeNull();
    expect(p.firstHalf).toBeNull();
    expect(p.secondHalf?.getTime()).toBe(ms + 1000);
  });
});

describe("atRiskGateFromProbes: the gate rule", () => {
  it("none: no MatFlow check-in at all", () => {
    expect(atRiskGateFromProbes(none)).toEqual({ open: false, reason: "none" });
  });
  it("paused: check-ins once, none since the week before the window", () => {
    expect(atRiskGateFromProbes({ ...none, earlier: d("2026-09-01T10:00:00Z") })).toEqual({ open: false, reason: "paused" });
  });
  it("warming up: starts 14 calendar days after the first check-in in the window", () => {
    const first = d("2026-10-20T18:00:00Z");
    const startsAt = new Date(first);
    startsAt.setDate(startsAt.getDate() + AT_RISK_DAYS);
    expect(atRiskGateFromProbes({ ...none, first })).toEqual({ open: false, reason: "warming_up", startsAt });
  });
  it("paused: a half of the window has no MatFlow check-in", () => {
    const before = d("2026-10-05T10:00:00Z");
    expect(atRiskGateFromProbes({ ...none, before, firstHalf: d("2026-10-12T10:00:00Z") })).toEqual({ open: false, reason: "paused" });
    expect(atRiskGateFromProbes({ ...none, before, secondHalf: d("2026-10-20T10:00:00Z") })).toEqual({ open: false, reason: "paused" });
  });
  it("open: a check-in in the week before and in each half", () => {
    expect(
      atRiskGateFromProbes({ ...none, before: d("2026-10-05T10:00:00Z"), firstHalf: d("2026-10-12T10:00:00Z"), secondHalf: d("2026-10-20T10:00:00Z") }),
    ).toEqual({ open: true });
  });
});

describe("atRiskGateWindows", () => {
  it("is the week before the window, the window start, and the middle, by calendar days", () => {
    const now = new Date("2026-10-24T12:00:00Z");
    const w = atRiskGateWindows(now);
    expect(w.since).toEqual(atRiskWindowStart(now));
    const weekBefore = new Date(w.since);
    weekBefore.setDate(w.since.getDate() - 7);
    const mid = new Date(w.since);
    mid.setDate(w.since.getDate() + 7);
    expect(w.weekBefore).toEqual(weekBefore);
    expect(w.mid).toEqual(mid);
  });
});

describe("the SQL follows the rules", () => {
  const src = readFileSync(path.join(process.cwd(), "lib/aggregate-counts.ts"), "utf8");
  it("uses tagged templates only, never the Unsafe entry points", () => {
    expect(src).not.toMatch(/\.\$(query|execute)RawUnsafe\b|Prisma\.raw\(/);
    expect(src.match(/\$queryRaw</g)?.length).toBe(4);
  });
  it("filters the tenant in every FROM of every statement", () => {
    for (const table of ['"AttendanceRecord"', '"Member"', '"Class"', '"MembershipTier"']) {
      const re = new RegExp(`FROM ${table}(?: [a-z]+)?\\s+WHERE ([^\\n]+)`, "g");
      for (const m of src.matchAll(re)) {
        // A sub-select joined to an already tenant-filtered row (the windows' EXISTS) filters by that row's id.
        expect(m[1]).toMatch(/"tenantId" = \$\{tenantId\}|m\."id" = a\."memberId"|ci\."id" = a\."classInstanceId"/);
      }
    }
  });
});
