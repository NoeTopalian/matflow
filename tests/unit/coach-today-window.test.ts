// /api/coach/today must decide "today" in the CLUB's timezone, not the
// process's.
//
// The route used to call `setHours(0,0,0,0)` and compare `toDateString()` in
// whatever zone the server ran in — UTC on Vercel. `ClassInstance.date` is a
// Postgres `timestamp` that Prisma reads back as a UTC wall clock, and two
// writers disagree about what it holds: the cron writes the process's midnight
// (00:00Z on Vercel), the seed writes the seeding laptop's local midnight
// (23:00Z of the previous day, from a BST machine). A London-local day window
// [midnight, next midnight) expressed as instants admits both — 18 Sep 00:00Z
// and 17 Sep 23:00Z are both "Friday 18 September" in London — while the old
// `toDateString()` comparison filed the seeded row on Thursday. X-6 lane A, F4.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { requireApiStaffMock, tenantFindUniqueMock, instanceFindManyMock } = vi.hoisted(() => ({
  requireApiStaffMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  instanceFindManyMock: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: requireApiStaffMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: tenantFindUniqueMock },
      classInstance: { findMany: instanceFindManyMock },
    }),
}));

import { todayWindow } from "@/lib/class-time";
import { GET } from "@/app/api/coach/today/route";

describe("todayWindow — every writer's spelling of the club's calendar day", () => {
  // `ClassInstance.date` is a calendar-day MARKER, not an instant: the cron
  // writes the process's midnight (00:00Z on Vercel), the seed writes the
  // seeding laptop's midnight (23:00Z of the day before, from BST). So the
  // question is "which rows were written for the club's calendar date D",
  // and the answer is a band of half a day either side of D's UTC midnight.
  it("BST: London's 15 June is the band around 15 June 00:00Z", () => {
    const { start, end } = todayWindow(new Date("2026-06-15T12:00:00Z"), "Europe/London");
    expect(start.toISOString()).toBe("2026-06-14T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-15T12:00:00.000Z");
  });

  it("GMT: the same band, unchanged by the season", () => {
    const { start, end } = todayWindow(new Date("2026-01-15T12:00:00Z"), "Europe/London");
    expect(start.toISOString()).toBe("2026-01-14T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("just before London midnight in BST, 'today' is still the earlier date", () => {
    // 22:30Z on 14 June is 23:30 BST on 14 June.
    const { start, end } = todayWindow(new Date("2026-06-14T22:30:00Z"), "Europe/London");
    expect(start.toISOString()).toBe("2026-06-13T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-14T12:00:00.000Z");
  });

  it("a club WEST of UTC gets its own date, and the cron's 00:00Z marker for that date is inside it", () => {
    // 02:00Z on 15 June is 22:00 on 14 June in New York: the club's date is
    // the 14th. The cron on Vercel wrote the 14th as 2026-06-14T00:00Z and the
    // 15th as 2026-06-15T00:00Z; only the former belongs to today. A window of
    // local-day INSTANTS ([04:00Z 14th, 04:00Z 15th)) would exclude today's
    // marker and include tomorrow's — the register would show tomorrow.
    const { start, end } = todayWindow(new Date("2026-06-15T02:00:00Z"), "America/New_York");
    expect(start.toISOString()).toBe("2026-06-13T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-14T12:00:00.000Z");
    const inside = (d: Date) => d >= start && d < end;
    expect(inside(new Date("2026-06-14T00:00:00Z"))).toBe(true);
    expect(inside(new Date("2026-06-15T00:00:00Z"))).toBe(false);
  });

  it("the seeded Friday row (stored 17 Sep 23:00Z from a BST laptop) is inside Friday's window and outside Thursday's", () => {
    const seededFriday = new Date("2026-09-17T23:00:00Z");
    const friday = todayWindow(new Date("2026-09-18T10:30:00Z"), "Europe/London");
    const thursday = todayWindow(new Date("2026-09-17T10:30:00Z"), "Europe/London");
    const inside = (w: { start: Date; end: Date }, d: Date) => d >= w.start && d < w.end;
    expect(inside(friday, seededFriday)).toBe(true);
    expect(inside(thursday, seededFriday)).toBe(false);
    // And the cron-written Friday row (00:00Z) is inside the same window.
    expect(inside(friday, new Date("2026-09-18T00:00:00Z"))).toBe(true);
  });

  it("a club east of UTC gets its own date, not London's", () => {
    // 2026-06-15 23:30Z is already 16 June 07:30 in Bali (UTC+8), so the
    // club's date is the 16th; a Bali-seeded marker (15 June 16:00Z) and a
    // Vercel-cron marker (16 June 00:00Z) for the 16th both fall in the band.
    const { start, end } = todayWindow(new Date("2026-06-15T23:30:00Z"), "Asia/Makassar");
    expect(start.toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-16T12:00:00.000Z");
  });
});

describe("GET /api/coach/today — queries the club's day, never the process's", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiStaffMock.mockResolvedValue({ ok: true, tenantId: "tenant-1", userId: "owner-1", role: "owner" });
    instanceFindManyMock.mockResolvedValue([]);
  });

  it("selects date >= local midnight and < next local midnight in Tenant.timezone", async () => {
    tenantFindUniqueMock.mockResolvedValue({ timezone: "Europe/London" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:30:00Z"));
    try {
      const res = await GET();
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect(instanceFindManyMock).toHaveBeenCalledTimes(1);
    const where = instanceFindManyMock.mock.calls[0][0].where as { date: { gte: Date; lt: Date } };
    expect(where.date.gte.toISOString()).toBe("2026-09-17T12:00:00.000Z");
    expect(where.date.lt.toISOString()).toBe("2026-09-18T12:00:00.000Z");
  });

  it("returns the seeded 23:00Z row on the Friday it belongs to (no toDateString filter)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ timezone: "Europe/London" });
    instanceFindManyMock.mockResolvedValue([
      {
        id: "inst-1",
        date: new Date("2026-09-17T23:00:00Z"),
        startTime: "18:00",
        endTime: "19:00",
        class: { id: "class-1", name: "Beginner BJJ", location: null, coachName: null, instructorId: null, maxCapacity: null, color: null },
        _count: { attendances: 0, waitlists: 0 },
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:30:00Z"));
    let body: { id: string }[];
    try {
      body = await (await GET()).json();
    } finally {
      vi.useRealTimers();
    }
    expect(body.map((i) => i.id)).toEqual(["inst-1"]);
  });

  it("a club east of UTC is asked for ITS day — the discriminator against a process-zone regression on a London machine", async () => {
    tenantFindUniqueMock.mockResolvedValue({ timezone: "Asia/Makassar" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T23:30:00Z")); // 16 June 07:30 in Bali
    try {
      await GET();
    } finally {
      vi.useRealTimers();
    }
    const where = instanceFindManyMock.mock.calls[0][0].where as { date: { gte: Date; lt: Date } };
    expect(where.date.gte.toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(where.date.lt.toISOString()).toBe("2026-06-16T12:00:00.000Z");
  });

  it("falls back to Europe/London when the tenant row has no usable timezone", async () => {
    tenantFindUniqueMock.mockResolvedValue({ timezone: "Not/AZone" });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    try {
      await GET();
    } finally {
      vi.useRealTimers();
    }
    const where = instanceFindManyMock.mock.calls[0][0].where as { date: { gte: Date; lt: Date } };
    expect(where.date.gte.toISOString()).toBe("2026-01-14T12:00:00.000Z");
  });
});
