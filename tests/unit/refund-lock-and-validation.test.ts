import { vi, describe, it, expect, beforeEach } from "vitest";

// Audit money-path P1-2 and P1-3 — POST /api/payments/[id]/refund.
//
// P1-2: the route read refundedAmountPence, validated against it, then wrote.
// Two refunds admitted concurrently each validated against the same stale
// total and the second write overwrote the first, so the pair could exceed the
// payment total with the ledger showing only the last one. The write now
// carries an optimistic lock (updateMany guarded on the value that was read)
// and a zero count is a 409, not a silent clobber.
//
// P1-3: the full-refund validation checked `payment.amountPence` while the
// refund it would actually issue was the remainder, so the two validations in
// this route disagreed about what was refundable. Both now derive from one
// figure. Amounts quoted to a human are money, never raw pence.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));

vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn().mockResolvedValue({ tenantId: "tenant-A", userId: "user-1" }),
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
    payment: { findFirst: vi.fn(), updateMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    member: { findFirst: vi.fn() },
    memberClassPack: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
}));

const refundsCreateMock = vi.fn();
const chargesRetrieveMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    refunds = { create: refundsCreateMock };
    charges = { retrieve: chargesRetrieveMock };
    subscriptions = { cancel: vi.fn(), update: vi.fn() };
  },
}));

import { prisma } from "@/lib/prisma";

const PAYMENT_TOTAL = 5000; // £50.00

function paymentRow(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    tenantId: "tenant-A",
    memberId: null,
    amountPence: PAYMENT_TOTAL,
    currency: "GBP",
    status: "succeeded",
    stripeChargeId: "ch_x",
    stripePaymentIntentId: "pi_x",
    stripeInvoiceId: null,
    refundedAmountPence: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test";
  vi.mocked(prisma.payment.findFirst).mockResolvedValue(paymentRow() as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    stripeAccountId: "acct_test",
    name: "Total BJJ",
  } as never);
  vi.mocked(prisma.payment.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.memberClassPack.findUnique).mockResolvedValue(null as never);
  chargesRetrieveMock.mockResolvedValue({ amount_refunded: 0 });
  refundsCreateMock.mockImplementation((params: { amount?: number }) =>
    Promise.resolve({ id: "re_xyz", amount: params.amount }),
  );
});

async function refund(body: object = {}) {
  const { POST } = await import("@/app/api/payments/[id]/refund/route");
  const req = new Request("http://localhost/api/payments/pay-1/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req as never, { params: Promise.resolve({ id: "pay-1" }) });
}

// ── P1-2: optimistic lock ────────────────────────────────────────────────────

describe("P1-2 — refund race: optimistic lock on the ledger write", () => {
  it("guards the write on the exact refundedAmountPence that was read", async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValueOnce(
      paymentRow({ refundedAmountPence: 2000 }) as never,
    );
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 2000 });

    await refund({ amountPence: 1000 });

    expect(vi.mocked(prisma.payment.updateMany)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.payment.updateMany).mock.calls[0][0] as {
      where: { id: string; tenantId: string; refundedAmountPence: number | null };
      data: { refundedAmountPence: number };
    };
    // The lock value: the cumulative total this request validated against.
    expect(arg.where.refundedAmountPence).toBe(2000);
    // Tenant filter stays on the write (CLAUDE.md — RLS is the backstop, not
    // the primary defence).
    expect(arg.where.tenantId).toBe("tenant-A");
    expect(arg.data.refundedAmountPence).toBe(3000);
  });

  it("guards on NULL for a payment that has never been refunded", async () => {
    await refund({ amountPence: 1000 });
    const arg = vi.mocked(prisma.payment.updateMany).mock.calls[0][0] as {
      where: { refundedAmountPence: number | null };
    };
    expect(arg.where.refundedAmountPence).toBeNull();
  });

  it("count === 0 (a concurrent refund won the write) → 409, never a silent overwrite", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.payment.updateMany).mockResolvedValueOnce({ count: 0 } as never);

    const res = await refund({ amountPence: 1000 });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // The Stripe refund id must survive into the response: if the two racing
    // requests were for different amounts, Stripe issued two refunds and only
    // the winner is in our ledger, so this one needs reconciling by hand.
    expect(body.stripeRefundId).toBe("re_xyz");
    expect(body.error).toMatch(/at the same time/i);

    const logged = errSpy.mock.calls.find((args) =>
      args.some((a) => typeof a === "string" && a.includes("CRITICAL")),
    );
    expect(logged).toBeDefined();
    errSpy.mockRestore();
  });

  it("a lock conflict is a 409, distinct from the 500 a genuine DB fault returns", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.payment.updateMany).mockRejectedValueOnce(new Error("connection reset"));
    const res = await refund({ amountPence: 1000 });
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });

  it("two racing refunds of the same amount share one Stripe idempotency key", async () => {
    await refund({ amountPence: 1000 });
    await refund({ amountPence: 1000 });
    const first = refundsCreateMock.mock.calls[0][1].idempotencyKey;
    const second = refundsCreateMock.mock.calls[1][1].idempotencyKey;
    // Same key ⇒ Stripe returns the same refund object to both ⇒ the loser's
    // 409 costs nothing, because no second refund was ever issued.
    expect(second).toBe(first);
  });
});

// ── P1-3: reconciled validation ──────────────────────────────────────────────

describe("P1-3 — the two validations agree on what is refundable", () => {
  it("'refund the rest' on a part-refunded charge succeeds (was rejected as an over-refund)", async () => {
    // £20 of £50 already refunded. PaymentsTable sends a full refund by
    // OMITTING amountPence. The old check compared 5000 (the whole payment)
    // against Stripe's 2000-already-refunded and returned 400, while the
    // refund it would have issued was the legitimate 3000.
    vi.mocked(prisma.payment.findFirst).mockResolvedValueOnce(
      paymentRow({ refundedAmountPence: 2000 }) as never,
    );
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 2000 });

    const res = await refund({});

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.amountPence).toBe(3000);
    expect(body.cumulativeRefundedPence).toBe(5000);
    expect(body.remainingPence).toBe(0);
    expect(body.fullyRefunded).toBe(true);
  });

  it("the amount sent to Stripe is the same figure the validation approved", async () => {
    vi.mocked(prisma.payment.findFirst).mockResolvedValueOnce(
      paymentRow({ refundedAmountPence: 2000 }) as never,
    );
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 2000 });

    await refund({});

    const [params] = refundsCreateMock.mock.calls[0];
    // Explicit, not inferred by Stripe — otherwise the amount refunded can
    // drift from the amount validated and recorded.
    expect(params.amount).toBe(3000);
  });

  it("Stripe's amount_refunded overrides a lagging local ledger", async () => {
    // Ledger says nothing refunded; Stripe says £40 was (refunded straight
    // from the Stripe dashboard). Only £10 is genuinely refundable, so a £20
    // request must be rejected even though the DB-only pre-check passes it.
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 4000 });

    const res = await refund({ amountPence: 2000 });

    expect(res.status).toBe(400);
    expect(refundsCreateMock).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("£10.00");
    expect(body.error).toContain("£40.00");
  });

  it("a charge Stripe reports as exhausted → 409, not a zero-value refund", async () => {
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: PAYMENT_TOTAL });
    const res = await refund({});
    expect(res.status).toBe(409);
    expect(refundsCreateMock).not.toHaveBeenCalled();
  });

  it("the cumulative total written is the authoritative one, not the stale local one", async () => {
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 1000 });
    await refund({ amountPence: 1000 });
    const arg = vi.mocked(prisma.payment.updateMany).mock.calls[0][0] as {
      data: { refundedAmountPence: number; status?: string };
    };
    expect(arg.data.refundedAmountPence).toBe(2000);
    // Not exhausted, so the status must stay refundable.
    expect(arg.data.status).toBeUndefined();
  });
});

// ── P1-3: money formatting ───────────────────────────────────────────────────

describe("P1-3 — amounts shown to a human are money, not pence", () => {
  it("the pre-Stripe over-refund error quotes pounds, not a raw integer", async () => {
    const res = await refund({ amountPence: 6000 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("£50.00");
    expect(body.error).not.toMatch(/\b\d{3,}\s*pence\b/);
  });

  it("the authoritative over-refund error quotes pounds, not a raw integer", async () => {
    chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 4500 });
    const res = await refund({ amountPence: 1000 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("£5.00");
    expect(body.error).not.toMatch(/\b\d{3,}\s*pence\b/);
  });

  it("the refund email renders the amount as money in the payment's currency", async () => {
    const { sendEmail } = await import("@/lib/email");
    vi.mocked(prisma.payment.findFirst).mockResolvedValueOnce(
      paymentRow({ memberId: "mem-1", currency: "EUR" }) as never,
    );
    vi.mocked(prisma.member.findFirst).mockResolvedValueOnce({
      id: "mem-1",
      name: "Aoife Byrne",
      email: "aoife@example.com",
      stripeSubscriptionId: null,
    } as never);

    await refund({ amountPence: 2500 });

    expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(sendEmail).mock.calls[0][0];
    expect(arg.vars.amount).toBe("€25.00");
  });
});
