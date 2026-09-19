// "Today" on the kiosk is the CLUB's day, not the server's.
//
// `/api/coach/today` was moved onto `todayWindow` + `Tenant.timezone` when the
// register listed Thursday's classes on a Friday. The kiosk — the surface a
// member actually taps — was left on `new Date(); setHours(0,0,0,0)` and a
// `date: { gte: today, lt: tomorrow }` band of PROCESS-local instants. Two
// consequences, both silent: a club west of the host sees tomorrow's timetable
// all day, and the day markers every writer actually stores (the cron's 00:00Z,
// a BST laptop's 23:00Z of the previous day) fall outside a band built from
// local midnight, so the class is simply missing.
//
// These tests pin the kiosk to the same window helper as the register.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { todayWindow } from "@/lib/class-time";

const TENANT = "tenant_a";
const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockTenantFindFirst, mockInstanceFindMany, mockRateLimit } = vi.hoisted(() => ({
  mockTenantFindFirst: vi.fn(),
  mockInstanceFindMany: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: mockTenantFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ classInstance: { findMany: mockInstanceFindMany } }),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "203.0.113.7" }));

let GET: typeof import("@/app/api/kiosk/[token]/classes/route")["GET"];
beforeAll(async () => {
  ({ GET } = await import("@/app/api/kiosk/[token]/classes/route"));
});

const req = () => new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/classes`);
const params = Promise.resolve({ token: KIOSK_TOKEN });

function tenant(timezone: string | null) {
  return {
    id: TENANT,
    name: "Total BJJ",
    primaryColor: "#000",
    secondaryColor: "#111",
    textColor: "#fff",
    bgColor: "#000",
    logoUrl: null,
    fontFamily: null,
    subscriptionStatus: "active",
    deletedAt: null,
    timezone,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockInstanceFindMany.mockResolvedValue([]);
  mockTenantFindFirst.mockResolvedValue(tenant("Europe/London"));
});

/** The `date` predicate the route handed Prisma. */
function dateFilter() {
  return mockInstanceFindMany.mock.calls[0][0].where.date as { gte: Date; lt: Date };
}

describe("GET /api/kiosk/[token]/classes — the club's day", () => {
  it("reads the club's timezone", async () => {
    await GET(req(), { params });
    const select = mockTenantFindFirst.mock.calls[0][0].select;
    expect(select.timezone).toBe(true);
  });

  it("queries the same band as todayWindow for the club's zone", async () => {
    await GET(req(), { params });

    const expected = todayWindow(new Date(), "Europe/London");
    const actual = dateFilter();
    // Within a second: the route builds its own `new Date()`.
    expect(Math.abs(actual.gte.getTime() - expected.start.getTime())).toBeLessThan(1000);
    expect(Math.abs(actual.lt.getTime() - expected.end.getTime())).toBeLessThan(1000);
  });

  it("a club in New York gets New York's day, not the server's", async () => {
    mockTenantFindFirst.mockResolvedValue(tenant("America/New_York"));
    await GET(req(), { params });

    const expected = todayWindow(new Date(), "America/New_York");
    const actual = dateFilter();
    expect(Math.abs(actual.gte.getTime() - expected.start.getTime())).toBeLessThan(1000);
  });

  it("the band is wide enough to admit every writer's spelling of the day", async () => {
    // The cron writes 00:00Z; a BST laptop writes 23:00Z of the previous day.
    // Both mean the same calendar date and both must be inside the band.
    await GET(req(), { params });
    const { gte, lt } = dateFilter();
    expect(lt.getTime() - gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("falls back to the default zone rather than throwing on a bad one", async () => {
    mockTenantFindFirst.mockResolvedValue(tenant("Not/AZone"));
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
  });

  it("still filters out cancelled sessions and scopes to the club", async () => {
    await GET(req(), { params });
    const where = mockInstanceFindMany.mock.calls[0][0].where;
    expect(where.isCancelled).toBe(false);
    expect(where.class).toEqual({ tenantId: TENANT });
  });
});
