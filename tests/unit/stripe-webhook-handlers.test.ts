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
