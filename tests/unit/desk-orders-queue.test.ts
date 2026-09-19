import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * GET /api/payments/desk-orders — the till's queue (lane L-E, round 3, X-6 K13).
 *
 * Three things this pins, each of which was a way the screen could lie:
 *
 * 1. It is owner+manager, and the gate runs before any read.
 * 2. The query is narrowed to `status: "pending"` AND
 *    `paymentMethod: "pay_at_desk"` AND `tenantId`. Widen any one of those and
 *    the desk is offered a Mark-paid button for a card payment that is still in
 *    flight, or for another club's order.
 * 3. `Order.items` is a Json column, so it is whatever is in it. A row the
 *    parser cannot read is dropped, not thrown on — the queue must survive one
 *    bad snapshot, because the amount due lives in a real column.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { findManyMock, gateMock, apiErrorMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  gateMock: vi.fn(),
  apiErrorMock: vi.fn((msg: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: msg }),
  })),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ order: { findMany: findManyMock } }),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: gateMock }));
vi.mock("@/lib/api-error", () => ({ apiError: apiErrorMock }));

import { GET } from "@/app/api/payments/desk-orders/route";

const ALLOW = { ok: true, tenantId: "tenant-A", userId: "user-owner-A", role: "owner" };

function order(over: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    orderRef: "ORD-ABC123",
    memberId: "member-1",
    items: [{ id: "p1", name: "Rash guard", price: 25, quantity: 2 }],
    totalPence: 5000,
    currency: "GBP",
    createdAt: new Date("2026-09-20T09:00:00.000Z"),
    member: { name: "Jordan Example" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue(ALLOW);
});

describe("GET /api/payments/desk-orders — the gate", () => {
  it("hands back the gate's own refusal and never reads a row", async () => {
    const refusal = { status: 403, json: async () => ({ ok: false, error: "nope" }) };
    gateMock.mockResolvedValueOnce({ ok: false, response: refusal });

    const res = await GET();

    expect(res).toBe(refusal);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/payments/desk-orders — what the queue may contain", () => {
  it("asks only for this tenant's PENDING PAY-AT-DESK orders, oldest first", async () => {
    findManyMock.mockResolvedValueOnce([]);

    await GET();

    const arg = findManyMock.mock.calls[0][0];
    expect(arg.where).toEqual({
      tenantId: "tenant-A",
      status: "pending",
      paymentMethod: "pay_at_desk",
    });
    // The person who has been waiting longest is the one at the desk.
    expect(arg.orderBy).toEqual({ createdAt: "asc" });
    expect(arg.take).toBe(200);
  });

  it("shapes a row for the panel and totals the queue", async () => {
    findManyMock.mockResolvedValueOnce([order(), order({ id: "order-2", totalPence: 1500 })]);

    const res = await GET();
    const body = (await res.json()) as {
      orders: Array<Record<string, unknown>>;
      total: number;
      totalPence: number;
      truncated: boolean;
    };

    expect(body.total).toBe(2);
    expect(body.totalPence).toBe(6500);
    expect(body.truncated).toBe(false);
    expect(body.orders[0]).toMatchObject({
      id: "order-1",
      orderRef: "ORD-ABC123",
      memberId: "member-1",
      memberName: "Jordan Example",
      totalPence: 5000,
      currency: "GBP",
    });
    // `items[].price` is POUNDS in the snapshot the checkout route writes — the
    // panel must not multiply it again.
    expect(body.orders[0].items).toEqual([{ name: "Rash guard", quantity: 2, price: 25 }]);
  });

  it("says a member is missing rather than inventing a name", async () => {
    findManyMock.mockResolvedValueOnce([order({ memberId: null, member: null })]);

    const body = (await (await GET()).json()) as { orders: Array<{ memberName: string | null }> };

    expect(body.orders[0].memberName).toBeNull();
  });

  it("survives a snapshot it cannot read — the amount due is a real column", async () => {
    findManyMock.mockResolvedValueOnce([
      order({ items: "not-an-array" }),
      order({ id: "order-2", items: [{ name: "Gi", quantity: "two", price: null }, 42, null] }),
    ]);

    const res = await GET();
    const body = (await res.json()) as { orders: Array<{ items: unknown[]; totalPence: number }> };

    expect(res.status).toBe(200);
    expect(body.orders[0].items).toEqual([]);
    expect(body.orders[0].totalPence).toBe(5000);
    // The unreadable entries are dropped; the one with a name survives with
    // safe defaults rather than NaN reaching the screen.
    expect(body.orders[1].items).toEqual([{ name: "Gi", quantity: 1, price: 0 }]);
  });

  it("answers a database failure with apiError, never an empty queue", async () => {
    findManyMock.mockRejectedValueOnce(new Error("connection lost"));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(apiErrorMock).toHaveBeenCalled();
  });
});
