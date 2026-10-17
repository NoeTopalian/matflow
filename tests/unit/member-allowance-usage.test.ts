// T7: the member portal's "N of M classes used in the last W weeks" (plan card
// on the profile, line on the schedule). Counted by the same statement the
// check-in uses, over the window ending now in the club's clock.
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

beforeEach(() => {
  vi.clearAllMocks();
  h.fail = false;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
  h.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "m-1" } });
  h.queryRaw.mockResolvedValue([{
    classLimit: 4, classLimitWeeks: 4, maxClassesPerWeek: null, alreadyIn: false,
    visits: [
      { d: DAY("2026-09-01"), s: "18:00" },
      { d: DAY("2026-10-05"), s: "18:00" },
      { d: DAY("2026-10-14"), s: "18:00" },
      { d: DAY("2026-10-19"), s: "18:00" },
    ],
  }]);
});
afterEach(() => vi.useRealTimers());

describe("memberAllowanceUsage", () => {
  it("counts the window ending now and words it", async () => {
    const tx = { $queryRaw: h.queryRaw, tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) } };
    const usage = await memberAllowanceUsage(tx as never, { tenantId: "t1", memberId: "m-1" });
    expect(usage).toEqual({ used: 2, limit: 4, weeks: 4, text: "2 of 4 classes used in the last 4 weeks" });
  });

  it("is null for an Unlimited plan", async () => {
    h.queryRaw.mockResolvedValue([{ classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null, alreadyIn: false, visits: [] }]);
    const tx = { $queryRaw: h.queryRaw, tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) } };
    expect(await memberAllowanceUsage(tx as never, { tenantId: "t1", memberId: "m-1" })).toBeNull();
  });
});

describe("GET /api/member/me/allowance (the schedule line)", () => {
  it("returns the usage", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowance: { used: 2, limit: 4, weeks: 4, text: "2 of 4 classes used in the last 4 weeks" } });
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
