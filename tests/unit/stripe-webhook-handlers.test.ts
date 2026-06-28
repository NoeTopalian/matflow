import { vi, describe, it, expect, beforeEach } from "vitest";

// Sprint 5 US-503: 5 new Stripe webhook handlers — exercise the dispatch
// branches by mocking constructEvent + Prisma. We don't assert the entire
// payload model — just that each event type lands in the right write.

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const constructEventMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent: constructEventMock };
  },
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
    stripeEvent: { create: vi.fn(), delete: vi.fn() },
    tenant: { findFirst: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    payment: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    classPack: { findFirst: vi.fn() },
    memberClassPack: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dispute: { upsert: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue({ ok: true }),
}));

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

import { prisma } from "@/lib/prisma";

const mockStripeEventCreate = vi.mocked(prisma.stripeEvent.create);
const mockTenantFindFirst = vi.mocked(prisma.tenant.findFirst);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockMemberUpdate = vi.mocked(prisma.member.update);
const mockMemberUpdateMany = vi.mocked(prisma.member.updateMany);
const mockPaymentFindFirst = vi.mocked(prisma.payment.findFirst);
const mockPaymentUpdate = vi.mocked(prisma.payment.update);
const mockPaymentUpsert = vi.mocked(prisma.payment.upsert);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test";
  mockStripeEventCreate.mockResolvedValue({ id: "evt-row-1" } as never);
  mockTenantFindFirst.mockResolvedValue({ id: "tenant-A" } as never);
  logAuditMock.mockClear();
});

function makeReq(rawBody: string) {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "sig", "content-type": "application/json" },
    body: rawBody,
  });
}

// ── customer.subscription.updated ─────────────────────────────────────────────

describe("Stripe webhook: customer.subscription.updated", () => {
  it("flips Member.paymentStatus to overdue when status=past_due", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-1",
      type: "customer.subscription.updated",
      account: "acct_test",
      data: {
        object: { id: "sub_x", customer: "cus_x", status: "past_due" },
      },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockMemberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "mem-1" },
      data: expect.objectContaining({ paymentStatus: "overdue" }),
    }));
  });
});

// ── invoice.voided ────────────────────────────────────────────────────────────

describe("Stripe webhook: invoice.voided", () => {
  it("flips matching Payment.status to refunded", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-2",
      type: "invoice.voided",
      account: "acct_test",
      data: { object: { id: "in_x" } },
    });
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pay-1" },
      data: expect.objectContaining({ status: "refunded" }),
    }));
  });
});

// ── payment_intent.succeeded ──────────────────────────────────────────────────

describe("Stripe webhook: payment_intent.succeeded", () => {
  it("upserts a Payment row keyed on stripePaymentIntentId", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-3",
      type: "payment_intent.succeeded",
      account: "acct_test",
      data: {
        object: {
          id: "pi_x",
          customer: "cus_x",
          amount_received: 5000,
          currency: "gbp",
        },
      },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripePaymentIntentId: "pi_x" },
    }));
  });
});

// ── invoice.payment_succeeded ↔ payment_intent.succeeded convergence ─────────
// A1: a subscription charge fires BOTH events. The invoice leg must key its
// Payment upsert on the payment_intent (when present) so it converges on the
// SAME row the payment_intent.succeeded leg writes — otherwise two 'succeeded'
// rows (or a P2002 collision) and revenue double-counts.

describe("Stripe webhook: invoice.payment_succeeded convergence", () => {
  it("keys the upsert on the payment_intent (not the invoice) when present, and stamps the invoice id", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-inv-conv",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: {
        object: { id: "in_x", customer: "cus_x", payment_intent: "pi_x", amount_paid: 1000, currency: "gbp" },
      },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripePaymentIntentId: "pi_x" },
      update: expect.objectContaining({ stripeInvoiceId: "in_x", status: "succeeded" }),
    }));
  });

  it("falls back to keying on the invoice id when no payment_intent is present", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-inv-nopi",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: { object: { id: "in_y", customer: "cus_x", amount_paid: 1000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripeInvoiceId: "in_y" },
    }));
  });
});

// ── customer.deleted ──────────────────────────────────────────────────────────

describe("Stripe webhook: customer.deleted", () => {
  it("nulls Member.stripeCustomerId for matching members", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-4",
      type: "customer.deleted",
      account: "acct_test",
      data: { object: { id: "cus_x" } },
    });
    mockMemberUpdateMany.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockMemberUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { stripeCustomerId: null },
    }));
  });
});

// ── payment_method.detached ───────────────────────────────────────────────────

describe("Stripe webhook: payment_method.detached", () => {
  it("logs an AuditLog entry with the payment method ID", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-5",
      type: "payment_method.detached",
      account: "acct_test",
      data: { object: { id: "pm_x", customer: "cus_x", type: "card" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "stripe.payment_method.detached",
      entityType: "Member",
      entityId: "mem-1",
      metadata: expect.objectContaining({ paymentMethodId: "pm_x", type: "card" }),
    }));
  });
});

// ── charge.refunded reconciliation (B3) ──────────────────────────────────────

describe("Stripe webhook: charge.refunded", () => {
  it("reconciles a paymentIntent-only payment when there's no stripeChargeId match", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-refund-1",
      type: "charge.refunded",
      account: "acct_test",
      data: { object: { id: "ch_new", payment_intent: "pi_x", amount_refunded: 5000 } },
    });
    // First lookup (by stripeChargeId) misses; second (by payment_intent) hits.
    mockPaymentFindFirst
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "pay-1", status: "succeeded" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { stripePaymentIntentId: "pi_x" } }),
    );
    expect(mockPaymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pay-1" },
      data: expect.objectContaining({ status: "refunded", refundedAmountPence: 5000 }),
    }));
  });

  it("is idempotent — skips the update when the payment is already refunded", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-refund-2",
      type: "charge.refunded",
      account: "acct_test",
      data: { object: { id: "ch_x", payment_intent: "pi_x", amount_refunded: 5000 } },
    });
    mockPaymentFindFirst.mockResolvedValueOnce({ id: "pay-1", status: "refunded" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(mockPaymentUpdate).not.toHaveBeenCalled();
  });

  // ULT-022: dashboard-initiated refund only fires charge.refunded (no owner-API
  // void path runs). The handler must void the funded class-pack itself, mirroring
  // the dispute-lost branch — otherwise the member keeps spendable credits.
  it("voids the funded class-pack when the refunded payment funded one", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-refund-pack",
      type: "charge.refunded",
      account: "acct_test",
      data: { object: { id: "ch_pack", payment_intent: "pi_pack", amount_refunded: 5000 } },
    });
    mockPaymentFindFirst.mockResolvedValueOnce({
      id: "pay-pack",
      status: "succeeded",
      stripePaymentIntentId: "pi_pack",
    } as never);
    const mockPackFindUnique = vi.mocked(prisma.memberClassPack.findUnique);
    const mockPackUpdate = vi.mocked(prisma.memberClassPack.update);
    mockPackFindUnique.mockResolvedValue({ id: "pack-1", memberId: "mem-1", status: "active" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPackFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripePaymentIntentId: "pi_pack" } }),
    );
    expect(mockPackUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pack-1" },
      data: expect.objectContaining({ status: "refunded", creditsRemaining: 0 }),
    }));
  });

  it("does NOT touch a class-pack that is not active (idempotent on replay)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-refund-pack-2",
      type: "charge.refunded",
      account: "acct_test",
      data: { object: { id: "ch_pack2", payment_intent: "pi_pack2", amount_refunded: 5000 } },
    });
    mockPaymentFindFirst.mockResolvedValueOnce({
      id: "pay-pack2",
      status: "succeeded",
      stripePaymentIntentId: "pi_pack2",
    } as never);
    const mockPackFindUnique = vi.mocked(prisma.memberClassPack.findUnique);
    const mockPackUpdate = vi.mocked(prisma.memberClassPack.update);
    mockPackFindUnique.mockResolvedValue({ id: "pack-2", memberId: "mem-1", status: "refunded" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(mockPackUpdate).not.toHaveBeenCalled();
  });
});

// ── checkout.session.completed (shop_order) → Payment mirror ─────────────────
// A2: Stripe-paid shop orders flip Order→paid but must ALSO mirror a Payment row
// (like the class_pack branch) so the sale is visible to revenue/ledger/CSV.

describe("Stripe webhook: checkout.session.completed (shop_order)", () => {
  it("flips the Order to paid AND mirrors a succeeded Payment for the order total", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-shop-1",
      type: "checkout.session.completed",
      account: "acct_test",
      data: {
        object: {
          id: "cs_x",
          payment_intent: "pi_shop",
          currency: "gbp",
          metadata: { matflowKind: "shop_order", tenantId: "tenant-A", orderRef: "ORD-1" },
        },
      },
    });
    const mockOrderFindFirst = vi.mocked(prisma.order.findFirst);
    const mockOrderUpdate = vi.mocked(prisma.order.update);
    mockOrderFindFirst.mockResolvedValue({ id: "order-1", memberId: "mem-1", totalPence: 2500 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockOrderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "order-1" },
      data: expect.objectContaining({ status: "paid" }),
    }));
    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripePaymentIntentId: "pi_shop" },
      create: expect.objectContaining({
        tenantId: "tenant-A",
        memberId: "mem-1",
        amountPence: 2500,
        status: "succeeded",
        stripePaymentIntentId: "pi_shop",
      }),
    }));
  });

  it("is a no-op when no pending Order matches (idempotent replay)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-shop-2",
      type: "checkout.session.completed",
      account: "acct_test",
      data: {
        object: {
          id: "cs_y",
          payment_intent: "pi_shop2",
          metadata: { matflowKind: "shop_order", tenantId: "tenant-A", orderRef: "ORD-2" },
        },
      },
    });
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.order.update)).not.toHaveBeenCalled();
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
  });
});

// ── Multi-club routing isolation ─────────────────────────────────────────────
// One Connect webhook serves every club; events must route to the club that
// owns the connected account (event.account → tenant.stripeAccountId), and must
// NOT touch another club's data when the account can't be resolved.

describe("Stripe webhook: multi-club routing", () => {
  it("routes a connected-account event to the correct club + scopes the member lookup to it", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-mc-1",
      type: "payment_intent.succeeded",
      account: "acct_B",
      data: { object: { id: "pi_B", customer: "cus_B", amount_received: 5000, currency: "gbp" } },
    });
    mockTenantFindFirst.mockResolvedValue({ id: "tenant-B" } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-B", tenantId: "tenant-B" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    // Tenant resolved by THIS club's connected account.
    expect(mockTenantFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeAccountId: "acct_B" } }),
    );
    // Member lookup carries the resolved tenantId — can't grab another club's member.
    expect(mockMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stripeCustomerId: "cus_B", tenantId: "tenant-B" }) }),
    );
    expect(mockPaymentUpsert).toHaveBeenCalled();
  });

  it("refuses to act when the connected account maps to no club (no cross-tenant write)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-mc-2",
      type: "payment_intent.succeeded",
      account: "acct_unknown",
      data: { object: { id: "pi_x", customer: "cus_x", amount_received: 5000, currency: "gbp" } },
    });
    mockTenantFindFirst.mockResolvedValue(null as never); // no tenant owns acct_unknown

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    // findMember short-circuits on a null tenantId (audit guard A8I1-S-4):
    // no member lookup, no payment write — nothing mutated cross-club.
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
  });
});

// ── Idempotency claim semantics (post-code-review fixes) ─────────────────────

describe("Stripe webhook: idempotency claim", () => {
  it("does NOT claim StripeEvent for unhandled event types", async () => {
    // If we claimed for unknown types, future deploys that add a handler for
    // them would skip Stripe's replays — a real bug. The route ignores them
    // with 200 + ignored:true and never touches stripeEvent.create.
    constructEventMock.mockReturnValue({
      id: "evt-unknown",
      type: "some.future.event.we.dont.handle.yet",
      account: "acct_test",
      data: { object: {} },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(mockStripeEventCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.ignored).toBe(true);
  });

  it("rolls back the StripeEvent claim when a handler throws", async () => {
    // If the handler throws after the claim, Stripe must be allowed to retry,
    // so the claim row must be deleted before the 500 response.
    const mockStripeEventDelete = vi.mocked(prisma.stripeEvent.delete);
    mockStripeEventCreate.mockResolvedValue({ id: "evt-row-rollback" } as never);
    mockStripeEventDelete.mockResolvedValue({} as never);

    constructEventMock.mockReturnValue({
      id: "evt-rollback",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: { object: { id: "in_x", customer: "cus_x", amount_paid: 1000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    // Force the upsert to throw — simulates DB hiccup mid-handler.
    mockPaymentUpsert.mockRejectedValueOnce(new Error("db blew up"));

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(500);
    expect(mockStripeEventDelete).toHaveBeenCalledWith({ where: { id: "evt-row-rollback" } });
  });
});
