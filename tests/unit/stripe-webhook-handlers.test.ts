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
const invoicesRetrieveMock = vi.fn();
const paymentIntentsRetrieveMock = vi.fn();
const paymentMethodsRetrieveMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent: constructEventMock };
    invoices = { retrieve: invoicesRetrieveMock };
    paymentIntents = { retrieve: paymentIntentsRetrieveMock };
    paymentMethods = { retrieve: paymentMethodsRetrieveMock };
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
    tenant: { findFirst: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    payment: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    classPack: { findFirst: vi.fn() },
    memberClassPack: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dispute: { upsert: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

const sendEmailMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/email", () => ({
  sendEmail: sendEmailMock,
}));

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

const sentryCaptureMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({ captureException: sentryCaptureMock }));

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
  // Defaults so dispute branches that fan out owner emails don't explode when a
  // test doesn't care about the email path. Individual tests override these.
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ name: "Gym" } as never);
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
  it("keys the upsert on the RESOLVED payment_intent, ignoring the payload field Stripe never sends", async () => {
    // The payload deliberately carries a payment_intent, and it is deliberately
    // the WRONG id. On apiVersion 2026-03-25.dahlia an Invoice has no
    // payment_intent and no charge — both read undefined against a live paid
    // invoice — so any code reading obj.payment_intent is reading a field that
    // does not exist in production. Seeding a poisoned value here means the
    // test fails loudly if anyone reintroduces that read, instead of passing
    // because the fixture happened to agree with the resolver.
    constructEventMock.mockReturnValue({
      id: "evt-inv-conv",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: {
        object: {
          id: "in_x",
          customer: "cus_x",
          payment_intent: "pi_NEVER_SENT_BY_STRIPE",
          amount_paid: 1000,
          currency: "gbp",
        },
      },
    });
    // How the id really arrives: expanded invoice.payments[].payment.
    invoicesRetrieveMock.mockResolvedValue({
      id: "in_x",
      payments: { data: [{ status: "paid", payment: { payment_intent: "pi_x" } }] },
    });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_x", latest_charge: "ch_x" });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripePaymentIntentId: "pi_x" },
      update: expect.objectContaining({ stripeInvoiceId: "in_x", status: "succeeded" }),
    }));
    // The charge id is the second hop and was stored as null for months.
    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ stripeChargeId: "ch_x" }),
    }));
  });

  it("falls back to keying on the invoice id when the resolver finds no payment", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-inv-nopi",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: { object: { id: "in_y", customer: "cus_x", amount_paid: 1000, currency: "gbp" } },
    });
    // An invoice with no payment entries — e.g. a zero-value or credited one.
    invoicesRetrieveMock.mockResolvedValue({ id: "in_y", payments: { data: [] } });
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
    // amountPence matters since the repeat-partials change: status flips to
    // "refunded" only when amount_refunded covers the full charge.
    mockPaymentFindFirst
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "pay-1", status: "succeeded", amountPence: 5000 } as never);

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
    // The flip is a single updateMany guarded on status='pending' — the status
    // filter IS the idempotency guard, so count>0 means this event did the flip.
    const mockOrderUpdateMany = vi.mocked(prisma.order.updateMany);
    mockOrderUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      memberId: "mem-1",
      totalPence: 2500,
      currency: "GBP",
      member: { name: "Alex", email: "alex@example.com", tenant: { name: "Total BJJ" } },
    } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockOrderUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-A", orderRef: "ORD-1", status: "pending" }),
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
    // count 0 = no pending Order matched, so this is a replay of an event that
    // already flipped it. Neither the ledger mirror nor the receipt may fire.
    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.order.update)).not.toHaveBeenCalled();
    expect(mockPaymentUpsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// ── charge.dispute.* handling (Batch 2a) ─────────────────────────────────────

describe("Stripe webhook: charge.dispute.* sync", () => {
  function disputeEvent(object: Record<string, unknown>) {
    return {
      id: "evt-dispute",
      type: "charge.dispute.created",
      account: "acct_test",
      data: { object: { id: "di_x", currency: "gbp", amount: 5000, reason: "fraudulent", ...object } },
    };
  }

  it("B1: links the Payment by payment_intent when the charge id does not match", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_none", payment_intent: "pi_x", customer: "cus_x", status: "needs_response" }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst
      .mockResolvedValueOnce(null as never) // by charge → miss
      .mockResolvedValueOnce({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1", stripePaymentIntentId: "pi_x" } as never); // by PI → hit

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(mockPaymentFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { stripePaymentIntentId: "pi_x" } }));
    expect(mockPaymentUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "pay-1" }, data: { status: "disputed" } }));
  });

  it("B2: flips Member.paymentStatus to overdue on an open dispute", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_x", customer: "cus_x", status: "needs_response" }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockMemberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "mem-1" }, data: expect.objectContaining({ paymentStatus: "overdue" }),
    }));
  });

  it("B2: returns Member.paymentStatus to paid when the dispute is won (no prior refund)", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_x", customer: "cus_x", status: "won" }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1", refundedAmountPence: null } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockMemberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "mem-1" }, data: expect.objectContaining({ paymentStatus: "paid" }),
    }));
    expect(mockPaymentUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "pay-1" }, data: { status: "succeeded" } }));
  });

  it("B5: a dispute won on a previously-refunded charge does NOT resurrect it to succeeded", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_x", customer: "cus_x", status: "won" }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1", refundedAmountPence: 5000 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockPaymentUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ data: { status: "succeeded" } }));
  });

  it("B3: emails the gym owners when a chargeback is first opened", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_x", customer: "cus_x", status: "needs_response", evidence_details: { due_by: 1893456000 } }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1" } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "owner@gym.test" }] as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ name: "Jane" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      templateId: "dispute_opened_owner",
      to: "owner@gym.test",
      vars: expect.objectContaining({ customerName: "Jane" }),
    }));
  });

  it("B3: does NOT email on a dispute UPDATE (only on created)", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-dispute-upd",
      type: "charge.dispute.updated",
      account: "acct_test",
      data: { object: { id: "di_x", currency: "gbp", amount: 5000, reason: "fraudulent", charge: "ch_x", customer: "cus_x", status: "under_review" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1" } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "owner@gym.test" }] as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(sendEmailMock).not.toHaveBeenCalledWith(expect.objectContaining({ templateId: "dispute_opened_owner" }));
  });

  it("B4: persists a dispute audit-log entry for the outcome", async () => {
    constructEventMock.mockReturnValue(
      disputeEvent({ charge: "ch_x", customer: "cus_x", status: "lost", payment_intent: "pi_x" }),
    );
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-1", tenantId: "tenant-A", memberId: "mem-1", stripePaymentIntentId: "pi_x" } as never);
    vi.mocked(prisma.memberClassPack.findUnique).mockResolvedValue(null as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "stripe.dispute.lost",
      metadata: expect.objectContaining({ stripeDisputeId: "di_x", status: "lost" }),
    }));
  });
});

// ── Audit keying + tenant-scoping (Batch 3a) ─────────────────────────────────

describe("Stripe webhook: audit + tenant-scoping", () => {
  it("D2: cancellation audit is keyed to Member.id, not the Stripe customer id", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-subdel",
      type: "customer.subscription.deleted",
      account: "acct_test",
      data: { object: { id: "sub_x", customer: "cus_x" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockMemberUpdateMany.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.subscription.cancelled_by_stripe",
      entityType: "Member",
      entityId: "mem-1",
    }));
  });

  it("D1: stamps cancelledAt when a subscription is deleted", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-subdel-ca",
      type: "customer.subscription.deleted",
      account: "acct_test",
      data: { object: { id: "sub_x", customer: "cus_x" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    mockMemberUpdateMany.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockMemberUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "cancelled", cancelledAt: expect.any(Date) }),
    }));
  });

  it("D3: audits a failed payment even when the member has no email on file", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-fail-noemail",
      type: "invoice.payment_failed",
      account: "acct_test",
      data: { object: { id: "in_x", customer: "cus_x", amount_due: 1000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ name: "No Email", email: null, tenant: { name: "Gym" } } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.payment.failed",
      entityId: "mem-1",
    }));
  });

  it("C2: class_pack ignores a memberId that is not a member of the tenant", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-pack-foreign",
      type: "checkout.session.completed",
      account: "acct_test",
      data: {
        object: {
          id: "cs_x", payment_intent: "pi_x", currency: "gbp", amount_total: 5000,
          metadata: { matflowKind: "class_pack", packId: "pack-1", memberId: "mem-foreign", tenantId: "tenant-A" },
        },
      },
    });
    vi.mocked(prisma.classPack.findFirst).mockResolvedValue({
      id: "pack-1", validityDays: 30, totalCredits: 10, pricePence: 5000, currency: "gbp", name: "10pk",
    } as never);
    mockMemberFindFirst.mockResolvedValue(null as never); // member not in tenant

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.memberClassPack.create)).not.toHaveBeenCalled();
  });

  it("C2: class_pack mints the pack when the member belongs to the tenant", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-pack-ok",
      type: "checkout.session.completed",
      account: "acct_test",
      data: {
        object: {
          id: "cs_y", payment_intent: "pi_y", currency: "gbp", amount_total: 5000,
          metadata: { matflowKind: "class_pack", packId: "pack-1", memberId: "mem-1", tenantId: "tenant-A" },
        },
      },
    });
    vi.mocked(prisma.classPack.findFirst).mockResolvedValue({
      id: "pack-1", validityDays: 30, totalCredits: 10, pricePence: 5000, currency: "gbp", name: "10pk",
    } as never);
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(vi.mocked(prisma.memberClassPack.create)).toHaveBeenCalled();
  });
});

// ── Out-of-order + void contingencies (Tier 2.6 / 3.12 / 3.13) ───────────────

describe("Stripe webhook: out-of-order + void contingencies", () => {
  it("3.13: invoice.voided voids the funded class-pack and stamps refundedAmountPence", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-void", type: "invoice.voided", account: "acct_test",
      data: { object: { id: "in_void" } },
    });
    mockPaymentFindFirst.mockResolvedValue({ id: "pay-v", status: "succeeded", amountPence: 4000, stripePaymentIntentId: "pi_v" } as never);
    vi.mocked(prisma.memberClassPack.findUnique).mockResolvedValue({ id: "pack-v", status: "active" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockPaymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pay-v" }, data: expect.objectContaining({ status: "refunded", refundedAmountPence: 4000 }),
    }));
    expect(vi.mocked(prisma.memberClassPack.update)).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "pack-v" }, data: expect.objectContaining({ status: "refunded", creditsRemaining: 0 }),
    }));
  });

  it("2.6: payment_intent.succeeded does NOT mirror a Payment for an invoice-backed PI", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-pi-inv", type: "payment_intent.succeeded", account: "acct_test",
      data: { object: { id: "pi_inv", customer: "cus_x", invoice: "in_x", amount_received: 5000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A", status: "active" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockPaymentUpsert).not.toHaveBeenCalled(); // invoice leg owns it
    expect(mockMemberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: "paid" } }));
  });

  it("3.12: payment_intent.succeeded does NOT resurrect a cancelled member", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-pi-canc", type: "payment_intent.succeeded", account: "acct_test",
      data: { object: { id: "pi_c", customer: "cus_x", amount_received: 5000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A", status: "cancelled" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockPaymentUpsert).toHaveBeenCalled(); // standalone PI still recorded
    expect(mockMemberUpdate).not.toHaveBeenCalled(); // but not flipped back to paid
  });

  it("3.12: subscription.updated 'active' does NOT resurrect a cancelled member", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-sub-res", type: "customer.subscription.updated", account: "acct_test",
      data: { object: { id: "sub_x", customer: "cus_x", status: "active" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A", status: "cancelled" } as never);

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);
    expect(mockMemberUpdate).not.toHaveBeenCalled();
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

  it("asks Stripe to retry (409) when the connected account maps to no club — no cross-tenant write", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-mc-2",
      type: "payment_intent.succeeded",
      account: "acct_unknown",
      data: { object: { id: "pi_x", customer: "cus_x", amount_received: 5000, currency: "gbp" } },
    });
    mockTenantFindFirst.mockResolvedValue(null as never); // no tenant owns acct_unknown

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    // Tier 2.4: an unresolved tenant rolls the claim back and returns 409 so
    // Stripe retries (the connect-callback write may not have landed yet) —
    // never 200, which would drop the event with money taken, nothing delivered.
    expect(res.status).toBe(409);

    // The throw happens before any handler branch — nothing mutated cross-club.
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

  it("returns 500 (claim rolled back with the tx) and reports to Sentry when a handler throws", async () => {
    // Tier 1.1: the claim is created INSIDE the processing tx, so a handler throw
    // rolls the claim back atomically (no compensating delete). Stripe retries on
    // the 500, and the failure is surfaced to Sentry so an outage isn't silent.
    mockStripeEventCreate.mockResolvedValue({ id: "evt-row-rollback" } as never);

    constructEventMock.mockReturnValue({
      id: "evt-rollback",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: { object: { id: "in_x", customer: "cus_x", amount_paid: 1000, currency: "gbp" } },
    });
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    // Force the upsert to throw — simulates a DB hiccup mid-handler.
    mockPaymentUpsert.mockRejectedValueOnce(new Error("db blew up"));

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(500);
    expect(sentryCaptureMock).toHaveBeenCalled();
  });

  it("acks 200 alreadyProcessed when the claim hits the unique constraint (duplicate delivery)", async () => {
    // Tier 1.1: the P2002 now surfaces from stripeEvent.create INSIDE the tx and
    // is caught at the bottom — a genuine duplicate is acked, not reprocessed.
    mockStripeEventCreate.mockRejectedValueOnce({ code: "P2002" } as never);
    constructEventMock.mockReturnValue({
      id: "evt-dup",
      type: "invoice.payment_succeeded",
      account: "acct_test",
      data: { object: { id: "in_x", customer: "cus_x", amount_paid: 1000, currency: "gbp" } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyProcessed).toBe(true);
    expect(mockMemberFindFirst).not.toHaveBeenCalled();
  });
});

// ── P0-1: invoice → PaymentIntent/Charge resolution ───────────────────────────
//
// On apiVersion 2026-03-25.dahlia an Invoice has NO `charge` and NO
// `payment_intent` field. Verified live against a PAID invoice: both read
// `undefined` while invoice.payments[].payment.payment_intent carried the id.
// The handler used to read the two missing fields through
// `Record<string, unknown>` casts, so it compiled and stored nulls forever.

describe("Stripe webhook: invoice payment ids (P0-1)", () => {
  const invoiceObject = {
    id: "in_p01",
    customer: "cus_p01",
    amount_paid: 3300,
    currency: "gbp",
    status_transitions: { paid_at: 1_700_000_000 },
    // Neither field exists on a real Invoice for this API version. They are
    // planted so a regression to reading them is caught: if the handler ever
    // reads obj.charge / obj.payment_intent again, these values surface in the
    // upsert and the assertions below fail.
    charge: "ch_MUST_NOT_BE_USED",
    payment_intent: "pi_MUST_NOT_BE_USED",
  };

  beforeEach(() => {
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
    invoicesRetrieveMock.mockResolvedValue({
      id: "in_p01",
      payments: { data: [{ payment: { type: "payment_intent", payment_intent: "pi_real" } }] },
    });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_real", latest_charge: "ch_real" });
  });

  it("stores ids resolved from invoice.payments, never the non-existent invoice fields", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-p01a", type: "invoice.payment_succeeded", account: "acct_test",
      data: { object: invoiceObject },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        stripePaymentIntentId: "pi_real",
        stripeChargeId: "ch_real",
      }),
    }));
  });

  it("expands payments and scopes the call to the connected account", async () => {
    constructEventMock.mockReturnValue({
      id: "evt-p01b", type: "invoice.payment_succeeded", account: "acct_test",
      data: { object: invoiceObject },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);

    // stripeAccount is the THIRD argument (request options), not the second.
    expect(invoicesRetrieveMock).toHaveBeenCalledWith(
      "in_p01",
      { expand: ["payments"] },
      { stripeAccount: "acct_test" },
    );
  });

  it("prefers the PAID entry — invoice.payments is newest-first and can hold cancelled attempts", async () => {
    // Proven live: entries are ordered newest-first and a `canceled` attempt
    // still carries a payment_intent. Taking [0] blindly records a cancelled or
    // superseded attempt against a paid invoice, and a later full refund is then
    // rejected by Stripe because the stored intent is worth less than amount_paid.
    invoicesRetrieveMock.mockResolvedValue({
      id: "in_p01",
      payments: {
        data: [
          { status: "canceled", payment: { type: "payment_intent", payment_intent: "pi_cancelled" } },
          { status: "paid", payment: { type: "payment_intent", payment_intent: "pi_the_real_one" } },
        ],
      },
    });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_the_real_one", latest_charge: "ch_real" });
    constructEventMock.mockReturnValue({
      id: "evt-p01e", type: "invoice.payment_succeeded", account: "acct_test",
      data: { object: invoiceObject },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    await POST(makeReq("{}") as never);

    expect(paymentIntentsRetrieveMock).toHaveBeenCalledWith("pi_the_real_one", {}, { stripeAccount: "acct_test" });
    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ stripePaymentIntentId: "pi_the_real_one" }),
    }));
  });

  it("resolves the ids on invoice.payment_failed as well", async () => {
    // The failed branch has its own pair of read sites. Without this the
    // mutation test showed it was completely uncovered.
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      name: "Aoife Byrne", email: null, tenant: { name: "Total BJJ" },
    } as never);
    constructEventMock.mockReturnValue({
      id: "evt-p01d", type: "invoice.payment_failed", account: "acct_test",
      data: { object: { ...invoiceObject, amount_due: 3300 } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        stripePaymentIntentId: "pi_real",
        stripeChargeId: "ch_real",
      }),
    }));
  });

  it("still records the payment when Stripe cannot resolve the ids", async () => {
    invoicesRetrieveMock.mockRejectedValue(new Error("Stripe unavailable"));
    constructEventMock.mockReturnValue({
      id: "evt-p01c", type: "invoice.payment_succeeded", account: "acct_test",
      data: { object: invoiceObject },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);

    // Must still ack, or Stripe retries forever — but with honest nulls, not
    // the planted values.
    expect(res.status).toBe(200);
    expect(mockPaymentUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        stripePaymentIntentId: null,
        stripeChargeId: null,
      }),
    }));
  });
});

// ── P1-5b: events whose object does not carry the customer ────────────────────

describe("Stripe webhook: customer resolution on mandate/detached (P1-5b)", () => {
  beforeEach(() => {
    mockMemberFindFirst.mockResolvedValue({ id: "mem-1", tenantId: "tenant-A" } as never);
  });

  it("mandate.updated resolves the customer via payment_method, not the absent obj.customer", async () => {
    // Stripe.Mandate has NO `customer` property — asserting it is a compile
    // error against the pinned SDK. The old handler read obj.customer, always
    // got undefined, and never found a member, so this path never ran.
    paymentMethodsRetrieveMock.mockResolvedValue({ id: "pm_1", customer: "cus_mandate" });
    constructEventMock.mockReturnValue({
      id: "evt-m1", type: "mandate.updated", account: "acct_test",
      data: { object: { id: "mandate_1", status: "inactive", payment_method: "pm_1" } },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(paymentMethodsRetrieveMock).toHaveBeenCalledWith("pm_1", {}, { stripeAccount: "acct_test" });
    expect(mockMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stripeCustomerId: "cus_mandate" }) }),
    );
    expect(mockMemberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "mem-1" },
      data: expect.objectContaining({ paymentStatus: "overdue", preferredPaymentMethod: "card" }),
    }));
  });

  it("payment_method.detached takes the customer from previous_attributes", async () => {
    // Verified against a real Stripe event: data.object.customer is null (being
    // detached is what the event reports) while previous_attributes.customer
    // holds the id. Reading only obj.customer meant the audit row was never
    // written.
    constructEventMock.mockReturnValue({
      id: "evt-d1", type: "payment_method.detached", account: "acct_test",
      data: {
        object: { id: "pm_2", type: "card", customer: null },
        previous_attributes: { customer: "cus_detached" },
      },
    });

    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(makeReq("{}") as never);
    expect(res.status).toBe(200);

    expect(mockMemberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stripeCustomerId: "cus_detached" }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "stripe.payment_method.detached",
      entityId: "mem-1",
    }));
  });
});
