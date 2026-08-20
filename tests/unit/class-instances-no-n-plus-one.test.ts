import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Lane 1 iter-1 CSRF-sweep follow-up: short-circuit the guard so test
// Requests (which carry no browser-set Origin header) don't 403.
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

// LB-006 (audit H5): POST /api/classes/[id]/instances must not loop with a
// findFirst per candidate date. The original fix batched them into ONE
// findMany, and this file pinned that count at 1.
//
// REWRITTEN, task 3a/3b — deliberately STRENGTHENED, not relaxed. That single
// findMany was a read-then-filter running inside a READ COMMITTED transaction:
// it was the ONLY dedup, because `skipDuplicates` had no unique constraint to
// conflict against (ClassInstance carried only two plain indexes). Two clicks
// both read "not present" and both inserted. Migration 20260819090000 added
// @@unique([classId, date, startTime]), so the database now deduplicates
// atomically and the pre-read is gone entirely.
//
// The N+1 property this file exists to defend is therefore stricter than
// before, and that is what it now asserts: the route issues ZERO instance
// reads and exactly ONE write, at any window size. The dedup guarantee itself
// moved to the database and is proven against real Postgres in
// tests/integration/class-instance-uniqueness.test.ts — including the
// concurrent case a JS-side Set could never have covered.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { classFindFirst, instanceFindMany, instanceCreateMany } = vi.hoisted(() => ({
  classFindFirst: vi.fn(),
  instanceFindMany: vi.fn(),
  instanceCreateMany: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findFirst: classFindFirst },
    classInstance: { findMany: instanceFindMany, createMany: instanceCreateMany },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", tenantId: "tenant-A", role: "owner" } as unknown,
  })),
}));

import { POST } from "@/app/api/classes/[id]/instances/route";

// A FIXED clock. This file used to run against the real `new Date()` while
// asserting hardcoded candidate counts, so it was date-dependent: the route
// had an off-by-one at the end of its window that added an extra occurrence
// whenever "today" fell on one of the fixture's own weekdays, and the suite
// went red the morning the calendar reached a Thursday. The route is fixed
// (lib/class-instances.ts now takes a day COUNT, not an end date) and the
// counts below are invariant to the start weekday — proven for all seven in
// tests/unit/build-instance-rows.test.ts. The clock is pinned anyway, because
// a test whose result depends on when it runs is not a test (RULES §6).
const NOW = new Date(2026, 7, 20, 9, 0, 0); // a Thursday — the day it broke

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  classFindFirst.mockResolvedValue({
    id: "class-1",
    schedules: [
      { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" }, // Mondays
      { dayOfWeek: 4, startTime: "18:00", endTime: "19:00" }, // Thursdays
    ],
  });
  instanceFindMany.mockResolvedValue([]);
  instanceCreateMany.mockResolvedValue({ count: 8 });
});

afterEach(() => {
  vi.useRealTimers();
});

const params = Promise.resolve({ id: "class-1" });

function makeReq(weeks = 4) {
  return new Request("http://localhost/api/classes/class-1/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weeks }),
  });
}

describe("POST /api/classes/[id]/instances — N+1 elimination", () => {
  it("reads no instances at all: one class lookup, one write, whatever the window", async () => {
    // 4 weeks x 2 schedules = 8 candidate dates. The pre-LB-006 code issued 8
    // findFirst calls; the LB-006 code issued 1 findMany; this issues none.
    const res = await POST(makeReq(4), { params });
    expect(res.status).toBe(200);
    expect(instanceFindMany).not.toHaveBeenCalled();
    expect(classFindFirst).toHaveBeenCalledTimes(1);
    expect(instanceCreateMany).toHaveBeenCalledTimes(1);
  });

  it("scales to many weeks without scaling DB calls", async () => {
    // 26 weeks x 2 schedules = 52 candidate dates, and 52 is now a property of
    // the window rather than an accident of today's date: a span of 26*7 days
    // contains exactly 26 of every weekday.
    const res = await POST(makeReq(26), { params });
    expect(res.status).toBe(200);
    expect(instanceFindMany).not.toHaveBeenCalled();
    expect(instanceCreateMany).toHaveBeenCalledTimes(1);
    const args = instanceCreateMany.mock.calls[0][0] as { data: unknown[] };
    expect(args.data).toHaveLength(52);
  });

  it("hands every candidate to the database with skipDuplicates", async () => {
    // Dedup is the constraint's job now, so the route must NOT pre-filter —
    // filtering in JS is what reintroduced the TOCTOU. It must also keep
    // skipDuplicates, or a re-press throws P2002 instead of being a no-op.
    await POST(makeReq(4), { params });
    const args = instanceCreateMany.mock.calls[0][0] as {
      data: Array<{ classId: string; date: Date; startTime: string }>;
      skipDuplicates: boolean;
    };
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toHaveLength(8);
    expect(args.data.every((d) => d.classId === "class-1")).toBe(true);
  });

  it("asks for exactly the window it was given, no matter what day it is", async () => {
    // The defect this file caught: "the next N weeks" used to mean N*7 + 1
    // days, so a schedule falling on today's weekday got an N+1th occurrence.
    // Thursday is one of the fixture's two weekdays, so NOW is the worst case.
    await POST(makeReq(1), { params });
    const args = instanceCreateMany.mock.calls[0][0] as { data: Array<{ date: Date }> };

    // One week, two schedules — one Monday and one Thursday, not two Thursdays.
    expect(args.data).toHaveLength(2);
    expect(args.data.filter((d) => d.date.getDay() === 1)).toHaveLength(1);
    expect(args.data.filter((d) => d.date.getDay() === 4)).toHaveLength(1);

    // And nothing lands on or past the seventh day after today.
    const sevenDaysOut = new Date(2026, 7, 20);
    sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);
    for (const d of args.data) {
      expect(d.date.getTime()).toBeLessThan(sevenDaysOut.getTime());
    }
  });

  it("reports the number of rows the database actually inserted", async () => {
    // RULES §2 — "Generated N class instances" has to be N. The old code
    // returned its optimistic pre-count, so two staff pressing together were
    // each told they had created a full set.
    instanceCreateMany.mockResolvedValue({ count: 3 });
    const res = await POST(makeReq(4), { params });
    expect(await res.json()).toEqual({ created: 3 });
  });
});
