// G6 (owner decision, 27 Oct 2026): "It should be till it runs out".
// GET /api/member/class-packs lists a pack with NULL expiry as active and never
// marks it expired. A non-NULL past date (which the migration made impossible
// on an active pack) is still honoured as written: hidden and marked expired.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { authMock, packFindMany, templateFindMany, packUpdateMany } = vi.hoisted(() => ({
  authMock: vi.fn(),
  packFindMany: vi.fn(),
  templateFindMany: vi.fn(),
  packUpdateMany: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      memberClassPack: { findMany: packFindMany, updateMany: packUpdateMany },
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
  templateFindMany.mockResolvedValue([{ id: "p1", name: "Ten", description: null, totalCredits: 10, validityDays: 90, pricePence: 8000, currency: "GBP" }]);
  packUpdateMany.mockResolvedValue({ count: 0 });
});

describe("GET /api/member/class-packs", () => {
  it("a pack with no expiry is listed, with expiresAt null, and nothing is marked expired", async () => {
    packFindMany.mockResolvedValue([row("mp1", null)]);
    const res = await GET();
    const body = (await res.json()) as { owned: Array<Record<string, unknown>>; available: Array<Record<string, unknown>> };
    expect(body.owned).toEqual([expect.objectContaining({ id: "mp1", creditsRemaining: 6, expiresAt: null })]);
    expect(packUpdateMany).not.toHaveBeenCalled();
    // The validity period is no longer part of what a member is shown.
    expect(body.available[0]).not.toHaveProperty("validityDays");
  });

  it("lists packs in the order their credits are spent: oldest purchase first", async () => {
    packFindMany.mockResolvedValue([]);
    await GET();
    expect(packFindMany.mock.calls[0][0]).toMatchObject({
      where: { memberId: "m1", tenantId: "t1", status: "active" },
      orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
    });
  });

  it("a stray active pack with a past expiry is still honoured as expired: hidden and marked, NULL packs untouched", async () => {
    const past = new Date(Date.now() - 86_400_000);
    packFindMany.mockResolvedValue([row("mp-old", past), row("mp-new", null)]);
    const res = await GET();
    const body = (await res.json()) as { owned: Array<{ id: string }> };
    expect(body.owned.map((p) => p.id)).toEqual(["mp-new"]);
    expect(packUpdateMany).toHaveBeenCalledTimes(1);
    const arg = packUpdateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: unknown };
    expect(arg.data).toEqual({ status: "expired" });
    expect(arg.where).toMatchObject({ id: { in: ["mp-old"] }, tenantId: "t1" });
    // The write itself refuses a NULL-expiry row, matching the database CHECK.
    expect(arg.where.expiresAt).toMatchObject({ not: null });
  });

  it("a pack with a future date stays listed", async () => {
    const future = new Date(Date.now() + 86_400_000);
    packFindMany.mockResolvedValue([row("mp-dated", future)]);
    const body = (await (await GET()).json()) as { owned: Array<{ id: string; expiresAt: string }> };
    expect(body.owned).toHaveLength(1);
    expect(body.owned[0].expiresAt).toBe(future.toISOString());
    expect(packUpdateMany).not.toHaveBeenCalled();
  });
});
