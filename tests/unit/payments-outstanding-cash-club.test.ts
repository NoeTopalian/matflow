// GET /api/payments/outstanding — "who owes me?" for a club that never touches
// Stripe.
//
// This is the test the feature exists for. `Member.paymentStatus` reaches
// "overdue" at exactly two lines in the codebase, both inside the Stripe
// webhook, so a club collecting cash or by standing order generated no events,
// every member stayed on the column's shipped default of "paid", and this list
// was permanently empty. The club could record that somebody HAD paid and never
// learn that somebody had not.
//
// The first test asserts the precise thing that was impossible: zero Stripe
// rows in, a non-empty outstanding list out.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockGate, mockMemberFindMany, mockPaymentFindMany } = vi.hoisted(() => ({
  mockGate: vi.fn(),
  mockMemberFindMany: vi.fn(),
  mockPaymentFindMany: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: mockGate }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findMany: mockMemberFindMany },
      payment: { findMany: mockPaymentFindMany },
    }),
}));

type Route = typeof import("@/app/api/payments/outstanding/route");
let GET: Route["GET"];

beforeAll(async () => {
  ({ GET } = await import("@/app/api/payments/outstanding/route"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGate.mockResolvedValue({ ok: true, tenantId: TENANT, userId: "u1", role: "owner" });
  mockMemberFindMany.mockResolvedValue([]);
  // A cash club has NO Stripe payments at all — not even failed ones.
  mockPaymentFindMany.mockResolvedValue([]);
});

describe("outstanding — a club that has never used Stripe", () => {
  it("asks for members who are behind by EITHER source, not just the Stripe flag", async () => {
    await GET();

    const where = mockMemberFindMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
    // The old query was `paymentStatus: "overdue"` flat, which no cash club
    // could ever satisfy. It must now be an OR with a due-date arm.
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toContainEqual({ paymentStatus: "overdue" });
    expect(where.OR.some((arm: Record<string, unknown>) => "nextDueAt" in arm)).toBe(true);
  });

  it("returns a NON-EMPTY list from a due date alone, with zero Stripe rows", async () => {
    // Exactly the case that was impossible: the member is "paid" as far as the
    // column is concerned, and has no Stripe history whatsoever.
    mockMemberFindMany.mockResolvedValue([
      { id: "mem_1", name: "Sam Green", membershipType: "Monthly Unlimited" },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].memberName).toBe("Sam Green");
  });

  it("never chases comped, paused or cancelled members", async () => {
    const [, dueDateArm] = mockOrArms(await captureWhere());
    expect(dueDateArm.paymentStatus).toEqual({ notIn: ["free", "paused", "cancelled"] });
  });
});

describe("outstanding — who may look", () => {
  it("refuses a coach with a 403 rather than a redirect to HTML", async () => {
    // The page helper used here before REDIRECTED, so a browser fetch followed
    // the 307 to /login and res.json() threw on "<!DOCTYPE" — a parse error
    // that reads like a server fault.
    mockGate.mockResolvedValue({
      ok: false,
      response: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });

    const res = await GET();

    expect(res.status).toBe(403);
    expect(mockMemberFindMany).not.toHaveBeenCalled();
  });

  it("lets a manager look, because a manager may already record a payment", async () => {
    mockGate.mockResolvedValue({ ok: true, tenantId: TENANT, userId: "u2", role: "manager" });
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

async function captureWhere() {
  await GET();
  return mockMemberFindMany.mock.calls[0][0].where;
}

function mockOrArms(where: { OR: Record<string, never>[] }) {
  return where.OR;
}
