// Pre-Resend adversarial pass (W6, 28 Oct 2026): forged or unconfirmed payment
// evidence on the class-pack money path.
//
//  - POST /api/stripe/webhook, checkout.session.completed with
//    metadata.matflowKind "class_pack": credits are minted only for a session
//    Stripe reports as PAID, for a pack and a member of the club the
//    connected account belongs to, and only with a valid signature.
//  - Delayed methods stay available (the club's own Stripe methods; the
//    payment policy is unchanged): an unpaid completion records nothing,
//    checkout.session.async_payment_succeeded mints the credits once, and
//    async_payment_failed mints nothing.
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
const auditLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/audit-log", () => ({ logAudit: auditLog }));
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

function packSession(over: Record<string, unknown> = {}, metadata: Record<string, string> = {}, type = "checkout.session.completed") {
  return {
    id: `evt-w6-${Math.random().toString(36).slice(2)}`,
    type,
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
  // A stateful pack table keyed on the @unique payment intent, so a second
  // mint for the same payment is visible (and a duplicate insert is a P2002).
  minted.clear();
  db.payment.findFirst.mockResolvedValue(null);
  db.memberClassPack.findUnique.mockImplementation(async ({ where }: { where: { stripePaymentIntentId?: string } }) =>
    where.stripePaymentIntentId && minted.has(where.stripePaymentIntentId) ? { id: `mcp-${where.stripePaymentIntentId}` } : null,
  );
  db.memberClassPack.create.mockImplementation(async ({ data }: { data: { stripePaymentIntentId: string | null } }) => {
    if (data.stripePaymentIntentId && minted.has(data.stripePaymentIntentId)) throw Object.assign(new Error("unique"), { code: "P2002" });
    if (data.stripePaymentIntentId) minted.add(data.stripePaymentIntentId);
    return { id: `mcp-${data.stripePaymentIntentId}` };
  });
});
const minted = new Set<string>();

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

  it("an unpaid completion followed by async_payment_succeeded mints the pack exactly once, with a succeeded Payment", async () => {
    await deliver(packSession({ payment_status: "unpaid" }));
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    expect(db.payment.upsert).not.toHaveBeenCalled();
    const res = await deliver(packSession({ payment_status: "paid" }, {}, "checkout.session.async_payment_succeeded"));
    expect(res.status).toBe(200);
    expect(db.memberClassPack.create).toHaveBeenCalledTimes(1);
    expect(db.memberClassPack.create.mock.calls[0][0].data).toMatchObject({ tenantId: "tenant-A", memberId: "mem-a", packId: "pack-a", creditsRemaining: 5, stripePaymentIntentId: "pi_w6", status: "active" });
    expect(db.payment.upsert).toHaveBeenCalledTimes(1);
    expect(db.payment.upsert.mock.calls[0][0].create).toMatchObject({ status: "succeeded", stripePaymentIntentId: "pi_w6" });
  });

  it("a duplicate async_payment_succeeded (or a paid completion plus an async success) mints once", async () => {
    await deliver(packSession({ payment_status: "paid" }, {}, "checkout.session.async_payment_succeeded"));
    await deliver(packSession({ payment_status: "paid" }, {}, "checkout.session.async_payment_succeeded"));
    await deliver(packSession({ payment_status: "paid" }));
    expect(minted.size).toBe(1);
    expect(db.memberClassPack.create).toHaveBeenCalledTimes(1);
    expect(db.payment.upsert).toHaveBeenCalledTimes(1);
  });

  it("async_payment_failed mints nothing and is logged to the club's audit", async () => {
    await deliver(packSession({ payment_status: "unpaid" }));
    const res = await deliver(packSession({ payment_status: "unpaid" }, {}, "checkout.session.async_payment_failed"));
    expect(res.status).toBe(200);
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    expect(db.payment.upsert).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-A", action: "stripe.checkout.class_pack_payment_failed" }));
  });

  it("async events naming another club, or a paid session with no payment intent, mint nothing", async () => {
    await deliver(packSession({ payment_status: "paid" }, { tenantId: "tenant-B" }, "checkout.session.async_payment_succeeded"));
    await deliver(packSession({ payment_status: "paid", payment_intent: null }, {}, "checkout.session.async_payment_succeeded"));
    await deliver(packSession({ payment_status: "unpaid" }, { tenantId: "tenant-B" }, "checkout.session.async_payment_failed"));
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalledWith(expect.objectContaining({ action: "stripe.checkout.class_pack_payment_failed" }));
  });

  it("a delayed payment fully refunded before its async success mints nothing and stays refunded", async () => {
    db.payment.findFirst.mockResolvedValue({ status: "refunded", amountPence: 5000, refundedAmountPence: 5000 });
    await deliver(packSession({ payment_status: "paid" }, {}, "checkout.session.async_payment_succeeded"));
    expect(db.memberClassPack.create).not.toHaveBeenCalled();
    expect(db.payment.upsert).not.toHaveBeenCalled();
  });

  it("a delayed payment partly refunded before its async success mints the pack net of the refund, and the Payment is not re-marked", async () => {
    // £25 back of £50 on a five-class pack: two whole classes (lib/pack-refund.ts).
    db.payment.findFirst.mockResolvedValue({ status: "succeeded", amountPence: 5000, refundedAmountPence: 2500 });
    await deliver(packSession({ payment_status: "paid" }, {}, "checkout.session.async_payment_succeeded"));
    expect(db.memberClassPack.create).toHaveBeenCalledTimes(1);
    expect(db.memberClassPack.create.mock.calls[0][0].data.creditsRemaining).toBe(3);
    expect(db.payment.upsert.mock.calls[0][0].update).not.toHaveProperty("status");
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

// Owner instruction, 28 Oct 2026: the MVP release must not depend on the live
// webhook being subscribed to the async checkout events. A card completes the
// session paid, so pack checkout is card-only (wallets included) until those
// events are subscribed and verified; the async handlers above stay, dormant.
describe("buy route: card only, so credits never wait on an async event; the session names the club's pack and the session's member", () => {
  it("restricts pack checkout to card (no delayed methods), and the metadata ignores forged body fields", async () => {
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
