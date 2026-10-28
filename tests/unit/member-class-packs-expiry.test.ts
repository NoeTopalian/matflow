// Packs per product (owner decision, 27 Oct 2026): "the club chooses an expiry
// or no expiry per new pack product". GET /api/member/class-packs lists the
// member's active packs that are still usable: no expiry, or an expiry still
// ahead. A dated pack past its date is expired and not listed (the behaviour
// before 27 Oct). The rule is applied when reading; the route writes nothing,
// so it can never mark a no-expiry pack expired (the old `null < now` bug).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { authMock, packFindMany, templateFindMany, packUpdateMany, packUpdate } = vi.hoisted(() => ({
  authMock: vi.fn(),
  packFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  packUpdateMany: vi.fn(),
  packUpdate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      memberClassPack: { findMany: packFindMany, updateMany: packUpdateMany, update: packUpdate },
      classPack: { findMany: templateFindMany },
    }),
}));

import { GET } from "@/app/api/member/class-packs/route";

const PACK = { name: "Ten", totalCredits: 10 };
const row = (id: string, expiresAt: Date | null, creditsRemaining = 6) => ({
  id, packId: "p1", pack: PACK, creditsRemaining, purchasedAt: new Date("2026-09-01T10:00:00Z"), expiresAt, status: "active",
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u", tenantId: "t1", memberId: "m1", role: "member" } });
  templateFindMany.mockResolvedValue([
    { id: "p1", name: "Ten", description: null, totalCredits: 10, validityDays: 90, pricePence: 8000, currency: "GBP" },
    { id: "p2", name: "Five", description: null, totalCredits: 5, validityDays: null, pricePence: 4500, currency: "GBP" },
  ]);
});

type Body = { owned: Array<Record<string, unknown>>; available: Array<Record<string, unknown>> };

describe("GET /api/member/class-packs", () => {
  it("asks for the member's active packs only, in the order credits are spent", async () => {
    packFindMany.mockResolvedValue([]);
    await GET();
    expect(packFindMany.mock.calls[0][0]).toMatchObject({
      where: { memberId: "m1", tenantId: "t1", status: "active" },
      orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { purchasedAt: "asc" }, { id: "asc" }],
    });
    // A legacy "expired" or a refunded pack is never asked for.
    expect(JSON.stringify(packFindMany.mock.calls[0][0].where)).not.toMatch(/expired|refunded/);
  });

  it("lists a no-expiry pack and a dated pack still in date; a dated pack past its date is not listed; nothing is written", async () => {
    const past = new Date(Date.now() - 86_400_000);
    const future = new Date(Date.now() + 30 * 86_400_000);
    packFindMany.mockResolvedValue([row("mp-future", future), row("mp-null", null), row("mp-past", past, 4)]);
    const body = (await (await GET()).json()) as Body;
    expect(body.owned.map((p) => p.id)).toEqual(["mp-future", "mp-null"]);
    expect(body.owned.find((p) => p.id === "mp-future")).toMatchObject({ expiresAt: future.toISOString(), creditsRemaining: 6 });
    expect(body.owned.find((p) => p.id === "mp-null")).toMatchObject({ expiresAt: null });
    expect(packUpdateMany).not.toHaveBeenCalled();
    expect(packUpdate).not.toHaveBeenCalled();
  });

  it("a no-expiry pack is never treated as expired (null is not a date in the past)", async () => {
    packFindMany.mockResolvedValue([row("mp-null", null)]);
    const body = (await (await GET()).json()) as Body;
    expect(body.owned).toHaveLength(1);
    expect(packUpdateMany).not.toHaveBeenCalled();
  });

  it("packs on sale carry their validity: a number of days, or null for never", async () => {
    packFindMany.mockResolvedValue([]);
    const body = (await (await GET()).json()) as Body;
    expect(body.available.map((p) => p.validityDays)).toEqual([90, null]);
  });
});
