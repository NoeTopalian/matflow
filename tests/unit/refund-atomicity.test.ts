import { vi, describe, it, expect, beforeEach } from "vitest";

// L3 — POST /api/payments/[id]/refund must keep Stripe + DB ledger consistent.
// If Stripe refund succeeds but the post-refund DB write fails, the response
// must:
//   - return 500 (NOT 200)
//   - include the stripeRefundId so the operator can reconcile manually
//   - emit a CRITICAL log including the same stripeRefundId
// The webhook charge.refunded handler is the eventual-consistency backstop.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn().mockResolvedValue({ tenantId: "tenant-A", userId: "user-1" }),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findFirst: vi.fn(), update: vi.fn() },
    tenant: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const refundsCreateMock = vi.fn();
const chargesRetrieveMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    refunds = { create: refundsCreateMock };
    charges = { retrieve: chargesRetrieveMock };
  },
}));

import { prisma } from "@/lib/prisma";

const mockPaymentFindFirst = vi.mocked(prisma.payment.findFirst);
const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockTx = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test";
  mockPaymentFindFirst.mockResolvedValue({
    id: "pay-1",
    tenantId: "tenant-A",
    amountPence: 5000,
    status: "succeeded",
    stripeChargeId: "ch_x",
    stripePaymentIntentId: "pi_x",
  } as never);
  mockTenantFindUnique.mockResolvedValue({ stripeAccountId: "acct_test" } as never);
  chargesRetrieveMock.mockResolvedValue({ amount_refunded: 0 });
  refundsCreateMock.mockResolvedValue({ id: "re_xyz", amount: 5000 });
});

function makeReq(body: object = {}) {
  return new Request("http://localhost/api/payments/pay-1/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("L3 — refund atomicity (Stripe + DB drift prevention)", () => {
  it("happy path: Stripe + DB both succeed → 200 with stripeRefundId", async () => {
    mockTx.mockResolvedValueOnce([{}] as never);
    const { POST } = await import("@/app/api/payments/[id]/refund/route");
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stripeRefundId).toBe("re_xyz");
    expect(mockTx).toHaveBeenCalledTimes(1); // payment.update wrapped in $transaction
  });

  it("when Stripe succeeds but DB transaction fails → 500 carrying stripeRefundId, NOT 200", async () => {
    mockTx.mockRejectedValueOnce(new Error("db sync down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/payments/[id]/refund/route");
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: "pay-1" }) });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // The refund ID MUST be in the response so the operator can reconcile.
    expect(body.stripeRefundId).toBe("re_xyz");

    // CRITICAL log MUST include stripeRefundId for manual reconciliation.
    const calls = errSpy.mock.calls;
    const matched = calls.find((args) =>
      args.some((arg) =>
        typeof arg === "object" && arg !== null && (arg as { stripeRefundId?: string }).stripeRefundId === "re_xyz",
      ),
    );
    expect(matched).toBeDefined();

    errSpy.mockRestore();
  });

  it("rejects refund amount that exceeds original charge → 400, no Stripe call", async () => {
    const { POST } = await import("@/app/api/payments/[id]/refund/route");
    const res = await POST(
      makeReq({ amountPence: 6000 }) as never,
      { params: Promise.resolve({ id: "pay-1" }) },
    );
    expect(res.status).toBe(400);
    expect(refundsCreateMock).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("rejects already-refunded payment → 409, no Stripe call", async () => {
    mockPaymentFindFirst.mockResolvedValueOnce({
      id: "pay-1",
      tenantId: "tenant-A",
      amountPence: 5000,
      status: "refunded",
      stripeChargeId: "ch_x",
      stripePaymentIntentId: "pi_x",
    } as never);

    const { POST } = await import("@/app/api/payments/[id]/refund/route");
    const res = await POST(makeReq() as never, { params: Promise.resolve({ id: "pay-1" }) });
    expect(res.status).toBe(409);
    expect(refundsCreateMock).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });
});
