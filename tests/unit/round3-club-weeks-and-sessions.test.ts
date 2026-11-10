// Round 3 (10 Nov 2026): statistics integrity.
//
// 1. Weeks are the club's. Reports' weekly chart, its "this week so far"
//    comparison and the dashboard home used the server process's clock (UTC
//    on Vercel), so a club's Monday started an hour late in BST and a whole
//    day off for far-away zones. clubWeekStartKey / clubWeekStart resolve
//    the Monday in Tenant.timezone, on day keys, so a clock change never
//    moves a boundary.
// 2. Every session counts. The per-session groupBy behind Top classes, their
//    averages and fill rates and the club-wide fill rate kept only the 200
//    busiest sessions (`take: 200`), so over a long period quieter classes
//    vanished and fill rates were the busiest sessions' only. The fake
//    groupBy below honours `take` and `orderBy`, so putting the cap back
//    fails these tests.

import { describe, it, expect, vi, afterEach } from "vitest";
import { fakeTx } from "./support/prisma-where-eval";

type CountArgs = { where: { checkInTime?: { gte?: Date; lt?: Date } } };
type GroupArgs = { by: string[]; take?: number };

let clubZone = "Europe/London";
let sessionGroups: { classInstanceId: string; _count: number }[] = [];
let sessionInstances: { id: string; class: { name: string; maxCapacity: number | null } }[] = [];
const countCalls: CountArgs[] = [];

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const tx = fakeTx([], { timezone: clubZone }) as Record<string, Record<string, unknown>>;
    tx.attendanceRecord = {
      ...tx.attendanceRecord,
      count: async (args: CountArgs) => {
        countCalls.push(args);
        return 0;
      },
      groupBy: async (args: GroupArgs) => {
        if (args.by[0] !== "classInstanceId") return [];
        const sorted = [...sessionGroups].sort((a, b) => b._count - a._count);
        return args.take === undefined ? sorted : sorted.slice(0, args.take);
      },
    };
    tx.classInstance = {
      findMany: async (args: { where: { id: { in?: string[] } | string } }) => {
        const ids = typeof args.where.id === "object" && args.where.id.in ? new Set(args.where.id.in) : new Set<string>();
        return sessionInstances.filter((i) => ids.has(i.id));
      },
    };
    return fn(tx);
  },
}));

import { clubWeekStart, clubWeekStartKey } from "@/lib/club-month";
import { getReportsData } from "@/lib/reports";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
  countCalls.length = 0;
  sessionGroups = [];
  sessionInstances = [];
});

describe("clubWeekStartKey / clubWeekStart: the club's Monday", () => {
  it("London in BST: 00:30 on Monday 19 October is 23:30 UTC on the Sunday, and is already the new week", () => {
    const at = new Date("2026-10-18T23:30:00Z");
    expect(clubWeekStartKey(at, "Europe/London")).toBe("2026-10-19");
    expect(clubWeekStart(at, "Europe/London").toISOString()).toBe("2026-10-18T23:00:00.000Z");
    // The same instant on a UTC club is still the week before.
    expect(clubWeekStartKey(at, "UTC")).toBe("2026-10-12");
  });

  it("across the clocks going back (Sunday 25 October 2026): that week starts in BST, the next in GMT", () => {
    expect(clubWeekStart(new Date("2026-10-25T12:00:00Z"), "Europe/London").toISOString()).toBe("2026-10-18T23:00:00.000Z");
    expect(clubWeekStart(new Date("2026-10-26T00:30:00Z"), "Europe/London").toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("is half-open: Monday midnight is the new week, one millisecond before is the old one", () => {
    expect(clubWeekStartKey(new Date("2026-11-09T00:00:00Z"), "Europe/London")).toBe("2026-11-09");
    expect(clubWeekStartKey(new Date("2026-11-08T23:59:59.999Z"), "Europe/London")).toBe("2026-11-02");
  });

  it("far zones: Auckland is already Monday while UTC is Sunday; Los Angeles is still Sunday while UTC is Monday", () => {
    expect(clubWeekStartKey(new Date("2026-11-08T12:00:00Z"), "Pacific/Auckland")).toBe("2026-11-09");
    expect(clubWeekStart(new Date("2026-11-08T12:00:00Z"), "Pacific/Auckland").toISOString()).toBe("2026-11-08T11:00:00.000Z");
    expect(clubWeekStartKey(new Date("2026-11-09T05:00:00Z"), "America/Los_Angeles")).toBe("2026-11-02");
  });
});

describe("Reports weeks use the club's zone, not the server's", () => {
  it("Auckland club, UTC server, 2026-11-08T12:00Z (Monday 01:00 in Auckland): this week is 9 Nov, from 11:00 UTC on the 8th", async () => {
    clubZone = "Pacific/Auckland";
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));

    const data = await getReportsData("club");

    const current = data.weeklyAttendance.filter((w) => w.isCurrentWeek);
    expect(current).toHaveLength(1);
    expect(current[0].week).toBe("9 Nov");
    expect(data.weeklyAttendance.at(-1)?.week).toBe("9 Nov");

    // The "this week so far" count and the week before it.
    const weekSoFar = countCalls.find((c) => c.where.checkInTime?.gte && !c.where.checkInTime.lt && c.where.checkInTime.gte.toISOString() === "2026-11-08T11:00:00.000Z");
    expect(weekSoFar).toBeDefined();
    const lastWeek = countCalls.find((c) => c.where.checkInTime?.gte?.toISOString() === "2026-11-01T11:00:00.000Z" && c.where.checkInTime.lt?.toISOString() === "2026-11-08T11:00:00.000Z");
    expect(lastWeek).toBeDefined();
  });

  it("London club across the clock change: each chart week is Monday midnight London time, BST then GMT", async () => {
    clubZone = "Europe/London";
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));

    const data = await getReportsData("club");
    const labels = data.weeklyAttendance.map((w) => w.week);
    expect(labels).toContain("19 Oct");
    expect(labels).toContain("26 Oct");
    expect(labels.at(-1)).toBe("2 Nov");
    // The bars' own windows: 19 Oct starts in BST (23:00 UTC the day before), 26 Oct in GMT.
    const starts = countCalls.map((c) => c.where.checkInTime?.gte?.toISOString());
    expect(starts).toContain("2026-10-18T23:00:00.000Z");
    expect(starts).toContain("2026-10-26T00:00:00.000Z");
  });
});

describe("Top classes and fill rate count every session in the period", () => {
  it("300 sessions: a quiet class outside the 200 busiest still appears, and the busy class's sessions and fill rate cover all 250", async () => {
    clubZone = "Europe/London";
    for (let i = 0; i < 250; i++) {
      sessionGroups.push({ classInstanceId: `busy-${i}`, _count: 10 });
      sessionInstances.push({ id: `busy-${i}`, class: { name: "Busy Class", maxCapacity: 20 } });
    }
    for (let i = 0; i < 50; i++) {
      sessionGroups.push({ classInstanceId: `quiet-${i}`, _count: 1 });
      sessionInstances.push({ id: `quiet-${i}`, class: { name: "Quiet Class", maxCapacity: 20 } });
    }

    const data = await getReportsData("club");

    const busy = data.topClasses.find((c) => c.name === "Busy Class");
    const quiet = data.topClasses.find((c) => c.name === "Quiet Class");
    expect(busy).toMatchObject({ count: 2500, sessions: 250, averageAttendance: 10, capacityTotal: 5000, fillRate: 50 });
    expect(quiet).toMatchObject({ count: 50, sessions: 50, averageAttendance: 1, capacityTotal: 1000, fillRate: 5 });
  });
});
