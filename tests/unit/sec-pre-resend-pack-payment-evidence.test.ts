// Pre-Resend adversarial pass (W6, 28 Oct 2026): forged or unconfirmed payment
// evidence on the class-pack money path.
//
//  - POST /api/stripe/webhook, checkout.session.completed with
//    metadata.matflowKind "class_pack": credits are minted only for a session
//    Stripe reports as PAID, for a pack and a member of the club the
//    connected account belongs to, and only with a valid signature.
//  - POST /api/member/class-packs/buy: the Checkout Session it creates only
//    offers a payment method that settles before completion (card), as the
//    shop checkout already does, so "completed" can never mean "not yet paid".
//
// Synthetic only: Stripe's constructor and every database call are replaced;
// nothing reaches a provider.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }),
}));

const m = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  checkoutCreate: vi.fn(),
  customersCreate: vi.fn(),
  auth: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent: m.constructEvent };
    checkout = { sessions: { create: m.checkoutCreate } };
    customers = { create: m.customersCreate };
    invoices = { retrieve: vi.fn() };
    paymentIntents = { retrieve: vi.fn() };
    paymentMethods = { retrieve: vi.fn() };
  },
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: async () => ({ ok: true }),
  refreshStripeAccountStatus: vi.fn(async () => {}),
}));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/billing-source-server", () => ({ refuseIfBilledElsewhere: async () => null }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const db = vi.hoisted(() => ({
  stripeEvent: { create: vi.fn(), delete: vi.fn() },
  tenant: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  user: { findMany: vi.fn() },
  member: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  memberStatusEvent: { create: vi.fn(), createMany: vi.fn() },
  payment: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  classPack: { findFirst: vi.fn() },
  memberClassPack: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  classPackRedemption: { count: vi.fn() },
  order: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  dispute: { upsert: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
}));

function webhookReq() {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=synthetic", "content-type": "application/json" },
    body: "{}",
  });
}

function packSession(over: Record<string, unknown> = {}, metadata: Record<string, string> = {}) {
  return {
    id: `evt-w6-${Math.random().toString(36).slice(2)}`,
    type: "checkout.session.completed",
    account: "acct_club_a",
    data: {
      object: {
        id: "cs_w6", mode: "payment", payment_intent: "pi_w6", currency: "gbp", amount_total: 5000,
        metadata: { matflowKind: "class_pack", packId: "pack-a", memberId: "mem-a", tenantId: "tenant-A", ...metadata },
        ...over,
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_w6_synthetic";
  process.env.STRIPE_SECRET_KEY = "sk_test_w6_synthetic_never_used";
  db.stripeEvent.create.mockResolvedValue({ id: "evt-row" });
  db.tenant.findFirst.mockResolvedValue({ id: "tenant-A" });
  db.user.findMany.mockResolvedValue([]);
  db.tenant.findUnique.mockResolvedValue({ name: "Club A" });
  db.classPack.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
    where.id === "pack-a" && where.tenantId === "tenant-A"
      ? { id: "pack-a", validityDays: 30, totalCredits: 5, pricePence: 5000, currency: "GBP", name: "Five" }
      : null,
  );
  db.member.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
    where.id === "mem-a" && where.tenantId === "tenant-A" ? { id: "mem-a", name: "A", email: "a@example.test", tenant: { name: "Club A" } } : null,
  );
});

async function deliver(event: unknown) {
  m.constructEvent.mockReturnValue(event);
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return (await POST(webhookReq() as never)) as unknown as { status: number };
}

describe("W6 webhook: forged or unconfirmed class-pack payment evidence", () => {
  it("control: a PAID completed checkout for the club's own pack and member mints the pack", async () => {
    const res = await deliver(packSession({ payment_status: "paid" }));
    expect(res.status).toBe(200);
    expect(db.memberClassPack.create).toHaveBeenCalledTimes(1);
  });

  it("an UNPAID completed checkout (a delayed payment method still clearing) mints no credits and records no succeeded payment", async () => {
    // Stripe sends checkout.session.completed with payment_status "unpaid"
    // for a delayed method (Bacs Direct Debit, SEPA, bank transfer); the
    // money may never arrive. Credits minted here are spendable at once.
    const res = await deliver(packSession({ payment_status: "unpaid" }));
    expect(res.status).toBeLessThan(500);
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    expect(db.payment.upsert).not.toHaveBeenCalled();
  });

  it("a completed checkout with no payment_status at all mints nothing", async () => {
    const res = await deliver(packSession());
    expect(res.status).toBeLessThan(500);
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
  });

  it("metadata naming another club than the connected account's is ignored", async () => {
    const res = await deliver(packSession({ payment_status: "paid" }, { tenantId: "tenant-B" }));
    expect(res.status).toBe(200);
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
  });

  it("another club's pack id, or another club's member id, mints nothing", async () => {
    await deliver(packSession({ payment_status: "paid" }, { packId: "pack-b" }));
    await deliver(packSession({ payment_status: "paid" }, { memberId: "mem-b" }));
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    // The lookups were scoped to the account's club, never to the metadata alone.
    for (const call of db.classPack.findFirst.mock.calls) expect(call[0].where.tenantId).toBe("tenant-A");
  });

  it("a bad signature is 400 and nothing is claimed or written", async () => {
    m.constructEvent.mockImplementation(() => { throw new Error("No signatures found matching the expected signature"); });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = (await POST(webhookReq() as never)) as unknown as { status: number };
    expect(res.status).toBe(400);
    expect(db.stripeEvent.create).not.toHaveBeenCalled();
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
  });

  it("an event with no connected account is not attributed to any club (retryable, nothing minted)", async () => {
    const ev = packSession({ payment_status: "paid" });
    delete (ev as { account?: string }).account;
    const res = await deliver(ev);
    expect(res.status).toBe(409);
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
  });
});

describe("W6 buy route: the pack checkout only offers a method that settles before completion", () => {
  it("creates a card-only Checkout Session (no delayed methods), with the club's pack and the session's member", async () => {
    m.auth.mockResolvedValue({ user: { tenantId: "tenant-A", memberId: "mem-a", role: "member" } });
    db.tenant.findUnique.mockResolvedValue({ stripeAccountId: "acct_club_a", stripeConnected: true, stripeAccountStatus: null, memberSelfBilling: true });
    db.member.findFirst.mockResolvedValue({ id: "mem-a", email: "a@example.test", name: "A", stripeCustomerId: "cus_a" });
    db.classPack.findFirst.mockResolvedValue({ id: "pack-a", stripePriceId: "price_a", isActive: true });
    m.checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.test/c" });
    const { POST } = await import("@/app/api/member/class-packs/buy/route");
    const res = (await POST(new Request("http://localhost/api/member/class-packs/buy", {
      method: "POST", body: JSON.stringify({ packId: "pack-a", memberId: "mem-b", tenantId: "tenant-B", price: 1 }),
    }))) as unknown as { status: number };
    expect(res.status).toBe(200);
    const [params] = m.checkoutCreate.mock.calls[0] as [Record<string, unknown>];
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.metadata).toMatchObject({ matflowKind: "class_pack", tenantId: "tenant-A", memberId: "mem-a", packId: "pack-a" });
    expect(params.line_items).toEqual([{ price: "price_a", quantity: 1 }]);
  });

  it("another club's pack id is 404 before any provider call", async () => {
    m.auth.mockResolvedValue({ user: { tenantId: "tenant-A", memberId: "mem-a", role: "member" } });
    db.tenant.findUnique.mockResolvedValue({ stripeAccountId: "acct_club_a", stripeConnected: true, stripeAccountStatus: null, memberSelfBilling: true });
    db.member.findFirst.mockResolvedValue({ id: "mem-a", email: "a@example.test", name: "A", stripeCustomerId: "cus_a" });
    db.classPack.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) =>
      where.tenantId === "tenant-A" && where.id === "pack-a" ? { id: "pack-a", stripePriceId: "price_a" } : null,
    );
    const { POST } = await import("@/app/api/member/class-packs/buy/route");
    const res = (await POST(new Request("http://localhost/api/member/class-packs/buy", {
      method: "POST", body: JSON.stringify({ packId: "pack-b" }),
    }))) as unknown as { status: number };
    expect(res.status).toBe(404);
    expect(m.checkoutCreate).not.toHaveBeenCalled();
    expect(m.customersCreate).not.toHaveBeenCalled();
  });
});
