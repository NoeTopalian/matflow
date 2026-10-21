// T7: the member portal's "N of M classes used this period — resets <date>"
// (plan card on the profile, line on the schedule). Counted by the same
// statement the check-in uses, for the period containing now in the club's clock.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  queryRaw: vi.fn(),
  fail: false,
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (h.fail) throw new Error("db down");
    return fn({ $queryRaw: h.queryRaw, tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) } });
  },
}));

import { GET } from "@/app/api/member/me/allowance/route";
import { memberAllowanceUsage } from "@/lib/class-allowance-count";

const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();
const tx = () => ({ $queryRaw: h.queryRaw, tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) } });
// 4 every 4 weeks, periods from Monday 21 September: 21 Sep–18 Oct, 19 Oct–15 Nov, …
const FOUR_IN_FOUR = { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: new Date("2026-09-21T00:00:00.000Z"), maxClassesPerWeek: null };
const USAGE = {
  used: 2, limit: 4, basis: "weeks", weeks: 4,
  period: { start: "2026-09-21", end: "2026-10-19" }, resetsOn: "2026-10-19",
  text: "2 of 4 classes used this 4-week period — resets Monday 19 October",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fail = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  h.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "m-1" } });
  h.queryRaw.mockResolvedValue([{
    ...FOUR_IN_FOUR, alreadyIn: false,
    visits: [
      { d: DAY("2026-09-01"), s: "18:00" }, // previous period
      { d: DAY("2026-10-05"), s: "18:00" },
      { d: DAY("2026-10-14"), s: "18:00" },
      { d: DAY("2026-10-19"), s: "18:00" }, // next period (a booking already attended early? no — a later session)
    ],
  }]);
});
afterEach(() => vi.useRealTimers());

describe("memberAllowanceUsage", () => {
  it("counts the period containing now and words it with the reset date", async () => {
    expect(await memberAllowanceUsage(tx() as never, { tenantId: "t1", memberId: "m-1" })).toEqual(USAGE);
  });

  it("a weekly plan counts Monday to Sunday and a monthly plan the calendar month", async () => {
    h.queryRaw.mockResolvedValue([{ classLimit: 3, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: 3, alreadyIn: false, visits: [{ d: DAY("2026-10-12"), s: "18:00" }, { d: DAY("2026-10-14"), s: "18:00" }] }]);
    // Monday 12 and Wednesday 14 October are both in the week of Saturday 17 October.
    expect(await memberAllowanceUsage(tx() as never, { tenantId: "t1", memberId: "m-1" })).toMatchObject({ used: 2, limit: 3, basis: "week", resetsOn: "2026-10-19", text: "2 of 3 classes used this week — resets Monday 19 October" });
    h.queryRaw.mockResolvedValue([{ classLimit: 8, classLimitBasis: "month", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null, alreadyIn: false, visits: [{ d: DAY("2026-10-01"), s: "18:00" }, { d: DAY("2026-09-30"), s: "18:00" }] }]);
    expect(await memberAllowanceUsage(tx() as never, { tenantId: "t1", memberId: "m-1" })).toMatchObject({ used: 1, limit: 8, basis: "month", resetsOn: "2026-11-01", text: "1 of 8 classes used this month — resets Sunday 1 November" });
  });

  it("a legacy maxClassesPerWeek with no basis reads as each calendar week", async () => {
    h.queryRaw.mockResolvedValue([{ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: 2, alreadyIn: false, visits: [] }]);
    expect(await memberAllowanceUsage(tx() as never, { tenantId: "t1", memberId: "m-1" })).toMatchObject({ used: 0, limit: 2, basis: "week" });
  });

  it("is null for an Unlimited plan", async () => {
    h.queryRaw.mockResolvedValue([{ classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null, alreadyIn: false, visits: [] }]);
    expect(await memberAllowanceUsage(tx() as never, { tenantId: "t1", memberId: "m-1" })).toBeNull();
  });
});

describe("GET /api/member/me/allowance (the schedule line)", () => {
  it("returns the usage", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowance: USAGE });
  });

  it("a failure is a 500, never a null the page would show as nothing", async () => {
    h.fail = true;
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it("is signed-in only", async () => {
    h.auth.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });
});
