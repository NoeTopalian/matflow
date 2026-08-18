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
    tenant: { findFirst: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    payment: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    classPack: { findFirst: vi.fn() },
    memberClassPack: { create: vi.fn() },
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
