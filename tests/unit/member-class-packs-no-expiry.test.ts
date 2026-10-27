// G6 (owner decision, 27 Oct 2026): "It should be till it runs out".
// GET /api/member/class-packs lists every pack the member can still use: an
// active one whatever its old expiry date says, and a legacy "expired" one
// with credits left. It never reads expiresAt and never writes "expired".
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const row = (id: string, expiresAt: Date | null, status = "active", creditsRemaining = 6) => ({
  id, packId: "p1", pack: PACK, creditsRemaining, purchasedAt: new Date("2026-09-01T10:00:00Z"), expiresAt, status,
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u", tenantId: "t1", memberId: "m1", role: "member" } });
  templateFindMany.mockResolvedValue([{ id: "p1", name: "Ten", description: null, totalCredits: 10, validityDays: 90, pricePence: 8000, currency: "GBP" }]);
});

describe("GET /api/member/class-packs", () => {
  it("asks for active packs and legacy expired packs that still have credits, oldest purchase first", async () => {
    packFindMany.mockResolvedValue([]);
    await GET();
    expect(packFindMany.mock.calls[0][0]).toMatchObject({
      where: {
        memberId: "m1",
        tenantId: "t1",
        OR: [{ status: "active" }, { status: "expired", creditsRemaining: { gt: 0 } }],
      },
      orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],
    });
    // Refunded packs are not asked for.
    expect(JSON.stringify(packFindMany.mock.calls[0][0].where)).not.toContain("refunded");
  });

  it("lists a pack with a past expiry date and a legacy expired pack with credits, and writes nothing", async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    packFindMany.mockResolvedValue([row("mp-past", past), row("mp-legacy", past, "expired", 4), row("mp-null", null)]);
    const res = await GET();
    const body = (await res.json()) as { owned: Array<Record<string, unknown>>; available: Array<Record<string, unknown>> };
    expect(body.owned.map((p) => p.id)).toEqual(["mp-past", "mp-legacy", "mp-null"]);
    expect(body.owned.find((p) => p.id === "mp-legacy")).toMatchObject({ creditsRemaining: 4 });
    // No expiry is shown to the member, and nothing is marked expired.
    for (const p of body.owned) expect(p).not.toHaveProperty("expiresAt");
    expect(packUpdateMany).not.toHaveBeenCalled();
    // The validity period is no longer part of what a member is shown.
    expect(body.available[0]).not.toHaveProperty("validityDays");
  });

  it("the route source neither reads expiresAt nor writes the status expired", () => {
    const src = readFileSync(join(process.cwd(), "app/api/member/class-packs/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/expiresAt/);
    expect(src).not.toMatch(/updateMany|update\(/);
  });
});
