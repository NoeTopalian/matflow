import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-005 (audit M4): /api/revenue/summary returns the shape the Settings
// Revenue tab needs, derived from real Payment + Member rows.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { paymentFindMany, memberCount, memberGroupBy, tierFindMany } = vi.hoisted(() => ({
  paymentFindMany: vi.fn(),
  memberCount: vi.fn(),
  memberGroupBy: vi.fn(),
  tierFindMany: vi.fn(),
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
    payment: { findMany: paymentFindMany },
    member: { count: memberCount, groupBy: memberGroupBy },
    membershipTier: { findMany: tierFindMany },
  },
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u-1", role: "owner" })),
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u-1", role: "owner" })),
}));

vi.mock("@/lib/authz", () => ({
  // Route is owner-only (requireOwner); keep the manager alias mocked too so the
  // test stays robust if the authz helper used here changes again.
  requireOwner: vi.fn(async () => ({ tenantId: "t-A", userId: "u-1", role: "owner" })),
  requireOwnerOrManager: vi.fn(async () => ({ tenantId: "t-A", userId: "u-1", role: "owner" })),
}));

import { GET } from "@/app/api/revenue/summary/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/revenue/summary", () => {
  it("returns the full empty shape when the tenant has no payments or members", async () => {
    paymentFindMany.mockResolvedValue([]);
    memberCount.mockResolvedValue(0);
    memberGroupBy.mockResolvedValue([]);
    tierFindMany.mockResolvedValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.mrr).toBe(0);
    expect(body.arr).toBe(0);
    expect(body.activeMembers).toBe(0);
    expect(body.avgPerMember).toBe(0);
    expect(body.growth).toBe(0);
    expect(body.history).toHaveLength(6); // always 6 months even when empty
    expect(body.history.every((h: { revenue: number }) => h.revenue === 0)).toBe(true);
    expect(body.memberships).toEqual([]);
    expect(body.recent).toEqual([]);
  });

  it("computes MRR from succeeded payments in the current month only", async () => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthDay = new Date(startOfMonth.getTime() - 86_400_000);

    // Promise.all order: monthPayments, lastMonthPayments, sixMonthPayments, ...
    paymentFindMany
      .mockResolvedValueOnce([{ amountPence: 5000 }, { amountPence: 7500 }]) // monthPayments → £125
      .mockResolvedValueOnce([{ amountPence: 10000 }])                       // lastMonthPayments → £100
      .mockResolvedValueOnce([                                               // sixMonthPayments
        { amountPence: 5000, paidAt: new Date(now.getFullYear(), now.getMonth(), 5) },
        { amountPence: 7500, paidAt: new Date(now.getFullYear(), now.getMonth(), 12) },
        { amountPence: 10000, paidAt: lastMonthDay },
      ])
      .mockResolvedValueOnce([]);                                            // recentPayments
    memberCount.mockResolvedValue(5);
    memberGroupBy.mockResolvedValue([]);
    tierFindMany.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();

    expect(body.mrr).toBe(125);
    expect(body.arr).toBe(125 * 12);
    expect(body.avgPerMember).toBe(25); // 125 / 5
    expect(body.growth).toBe(25);       // (125 - 100) / 100 = 25%
    expect(body.history).toHaveLength(6);
    // Last bucket = current month = £125
    expect(body.history[5].revenue).toBe(125);
  });

  // Round 1 (9 Nov 2026): `recent` rows carry the payment's own `status` so the
  // client can label them Paid / Failed / Refunded. `action` is kept unchanged
  // for older consumers: "cancelled" only for failed or refunded, else "joined".
  it("returns each recent payment's status alongside the unchanged action", async () => {
    const now = new Date();
    paymentFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { amountPence: 5000, status: "succeeded", createdAt: now, paidAt: now, member: { name: "A", membershipType: "Adult" } },
        { amountPence: 5000, status: "pending", createdAt: now, paidAt: null, member: { name: "B", membershipType: "Adult" } },
        { amountPence: 5000, status: "failed", createdAt: now, paidAt: null, member: { name: "C", membershipType: "Kids" } },
        { amountPence: 5000, status: "refunded", createdAt: now, paidAt: now, member: { name: "D", membershipType: "Kids" } },
        { amountPence: 5000, status: "disputed", createdAt: now, paidAt: now, member: null },
      ]);
    memberCount.mockResolvedValue(0);
    memberGroupBy.mockResolvedValue([]);
    tierFindMany.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();
    expect(body.recent.map((r: { status: string; action: string }) => [r.status, r.action])).toEqual([
      ["succeeded", "joined"],
      ["pending", "joined"],
      ["failed", "cancelled"],
      ["refunded", "cancelled"],
      ["disputed", "joined"],
    ]);
    expect(body.recent[4].name).toBe("—");
    // Only the five known fields plus status: no new personal data in the row.
    expect(Object.keys(body.recent[0]).sort()).toEqual(["action", "date", "name", "status", "tier"]);
  });
});
