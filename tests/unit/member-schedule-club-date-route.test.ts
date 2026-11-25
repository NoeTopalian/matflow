// GET /api/member/schedule?date=today resolves the CLUB's date in the club's zone, and the reply names that zone
// (X-Club-Zone) so the member's day reads live and next on the club's clock (25 Nov 2026).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/class-horizon", () => ({ ensureClassHorizon: vi.fn(async () => undefined) }));
const db = vi.hoisted(() => ({
  class: { findMany: vi.fn() },
  classInstance: { findMany: vi.fn() },
  tenant: { findUnique: vi.fn() },
  memberRank: { findMany: vi.fn() },
  classRoster: { findMany: vi.fn(), groupBy: vi.fn() },
  member: { findFirst: vi.fn() },
  classSubscription: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
}));

import { auth } from "@/auth";
import { GET } from "@/app/api/member/schedule/route";

beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({ user: { tenantId: "t1", memberId: "m1" } } as never);
  db.class.findMany.mockResolvedValue([]);
  db.classInstance.findMany.mockResolvedValue([]);
  db.memberRank.findMany.mockResolvedValue([]);
  db.classRoster.findMany.mockResolvedValue([]);
  db.classRoster.groupBy.mockResolvedValue([]);
  db.member.findFirst.mockResolvedValue(null);
  db.classSubscription.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function windowAsked(): { gte: string; lte: string } {
  const where = db.classInstance.findMany.mock.calls[0][0].where;
  return { gte: where.date.gte.toISOString(), lte: where.date.lte.toISOString() };
}

describe("date=today", () => {
  it.each([
    ["Europe/London", "2026-11-25T20:30:00Z", "2026-11-25"], // Wed 20:30 GMT (Thu 04:30 in Bali)
    ["Europe/London", "2026-11-26T07:30:00Z", "2026-11-26"], // Thu 07:30 GMT (Wed 21:30 in Honolulu)
    ["Europe/London", "2027-03-29T23:30:00Z", "2027-03-30"], // 00:30 BST Tue: past the club's midnight, not UTC's
    ["Asia/Makassar", "2026-11-25T20:30:00Z", "2026-11-26"], // a Bali club: Thu 04:30
  ])("club in %s at %s asks for %s and names the zone", async (zone, iso, date) => {
    db.tenant.findUnique.mockResolvedValue({ timezone: zone });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    const res = await GET(new Request("http://x/api/member/schedule?date=today"));
    expect(res.headers.get("X-Club-Zone")).toBe(zone);
    expect(windowAsked()).toEqual({ gte: `${date}T00:00:00.000Z`, lte: `${date}T23:59:59.999Z` });
  });

  it("an explicit date is still honoured (a page loaded before this release)", async () => {
    db.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
    await GET(new Request("http://x/api/member/schedule?date=2026-11-24"));
    expect(windowAsked()).toEqual({ gte: "2026-11-24T00:00:00.000Z", lte: "2026-11-24T23:59:59.999Z" });
  });

  it("a malformed date maps no session rather than querying an invalid window", async () => {
    db.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
    const res = await GET(new Request("http://x/api/member/schedule?date=garbage"));
    expect(res.status).toBe(200);
    expect(db.classInstance.findMany).not.toHaveBeenCalled();
  });

  it("an unusable stored zone falls back to London rather than failing", async () => {
    db.tenant.findUnique.mockResolvedValue({ timezone: "Not/AZone" });
    const res = await GET(new Request("http://x/api/member/schedule?date=today"));
    expect(res.headers.get("X-Club-Zone")).toBe("Europe/London");
  });
});
