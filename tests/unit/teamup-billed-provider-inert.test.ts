/**
 * TeamUp bridge, provider-call harness (brief of 2 Oct 2026: "Enumerate
 * hold/resume/cancel/charge/subscribe/parent-subscribe/migrate/webhook/chase
 * paths and prove each refuses or is inert for billedBy teamup before any
 * provider call; mocks must fail tests on unexpected calls").
 *
 * Here: the Stripe client is a Proxy that THROWS on any property access, and
 * sendEmail throws. A route that reaches a provider for a TeamUp-billed member
 * fails this file. Subscribe / parent-subscribe / desk-subscribe / charge /
 * checkout / packs are pinned in billed-elsewhere-guard.test.ts and
 * card-charge-guards.test.ts; the webhook never matches a member by email
 * (findMember keys on stripeCustomerId, which an imported member never has) —
 * pinned by the static scan at the end.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type Stripe from "stripe";
import { previewMigration } from "@/lib/stripe/migrate-memberships";
import { overdueClause, noPaymentYetWhere } from "@/lib/overdue";

const boom = (what: string) => {
  throw new Error(`unexpected provider call: ${what}`);
};
const throwingStripe = () =>
  new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : boom(`stripe.${String(p)}`)) });

const m = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdate: vi.fn(async () => ({})),
  memberUpdateMany: vi.fn(async () => ({ count: 1 })),
  tenantFindUnique: vi.fn(),
  tierFindMany: vi.fn(async (): Promise<unknown[]> => []),
  paymentFindFirst: vi.fn(async () => null),
  audit: vi.fn(async () => {}),
  sendEmail: vi.fn(async () => boom("sendEmail")),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: async () => ({ ok: true, tenantId: "t1", userId: "u1", role: "owner" }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: m.audit }));
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }), getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/env-url", () => ({ getBaseUrl: () => "http://localhost:3000" }));
vi.mock("@/lib/api-error", () => ({ apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }) }));
vi.mock("stripe", () => ({ default: class { constructor() { return throwingStripe(); } } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      member: { findFirst: m.memberFindFirst, findMany: m.memberFindMany, update: m.memberUpdate, updateMany: m.memberUpdateMany },
      tenant: { findUnique: m.tenantFindUnique },
      membershipTier: { findMany: m.tierFindMany },
      payment: { findFirst: m.paymentFindFirst },
    })),
}));

const TEAMUP = {
  id: "mem-1", name: "Sam", email: "sam@example.test", status: "active", paymentStatus: "paid", billedBy: "teamup",
  stripeCustomerId: null, stripeSubscriptionId: null, holdUntil: null, holdPriorStatus: null, membershipTierId: null, nextDueAt: null,
  tenant: { name: "Club" },
};
const params = { params: Promise.resolve({ id: "mem-1" }) };
const post = (url: string, body?: unknown) => new Request(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  m.tenantFindUnique.mockResolvedValue({ id: "t1", stripeAccountId: "acct_gym", stripeConnected: true, acceptsBacs: false, currency: "GBP" });
  m.memberFindFirst.mockResolvedValue(TEAMUP);
});

describe("hold and resume are local-only for a TeamUp-billed member", () => {
  it("hold writes paused locally and touches no provider", async () => {
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    const res = await POST(post("http://localhost/api/members/mem-1/hold", {}), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paymentStatus: "paused", stripePaused: false });
    expect(m.memberUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ paymentStatus: "paused" }) }));
  });

  it("resume restores the prior standing locally and touches no provider", async () => {
    m.memberFindFirst.mockResolvedValue({ ...TEAMUP, paymentStatus: "paused", holdPriorStatus: "paid" });
    const { POST } = await import("@/app/api/members/[id]/resume/route");
    const res = await POST(post("http://localhost/api/members/mem-1/resume"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stripeResumed: false });
  });
});

describe("chase refuses a TeamUp-billed member before any mail", () => {
  it("409 billed_elsewhere, no email, no audit row", async () => {
    const { POST } = await import("@/app/api/payments/chase/route");
    const res = await POST(post("http://localhost/api/payments/chase", { memberId: "mem-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "billed_elsewhere" });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
});

describe("the migration engine skips a TeamUp-billed member unless the run is a cutover", () => {
  const PERIOD_END = Math.floor(new Date("2026-11-01T00:00:00Z").getTime() / 1000);
  const customer = {
    id: "cus_sam", email: "sam@example.test", created: 1_700_000_000,
    subscriptions: { data: [{ id: "sub_live", status: "active", default_payment_method: null, metadata: {}, items: { data: [{ current_period_end: PERIOD_END, price: { id: "price_1", unit_amount: 5500, currency: "gbp", recurring: { interval: "week", interval_count: 4 } } }] } }] },
    invoice_settings: { default_payment_method: { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } } },
  };
  const stripeStub = {
    customers: { list: vi.fn(async () => ({ data: [customer], has_more: false })), listPaymentMethods: vi.fn(async () => ({ data: [] })) },
    paymentMethods: { retrieve: vi.fn(async () => boom("paymentMethods.retrieve")) },
    subscriptions: { list: vi.fn(async () => ({ data: [] })), create: vi.fn(async () => boom("subscriptions.create")) },
    products: { create: vi.fn(async () => boom("products.create")) },
    prices: { create: vi.fn(async () => boom("prices.create")) },
  } as unknown as Stripe;

  beforeEach(() => {
    m.tierFindMany.mockResolvedValue([{ id: "tier_4w", name: "Adults Advanced 2026", pricePence: 5500, currency: "GBP", billingCycle: "four_weekly", stripePriceId: "price_1", stripeProductId: "prod_1", isActive: true }]);
    m.memberFindMany.mockResolvedValue([{ ...TEAMUP, membershipTierId: "tier_4w" }]);
  });

  it("default run: skipped with billed_by_teamup, no Stripe write", async () => {
    const p = await previewMigration(stripeStub, "t1", new Date("2026-10-02T12:00:00Z"));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ action: "skip", reason: "billed_by_teamup" });
    expect(p.summary.skippedByReason).toMatchObject({ billed_by_teamup: 1 });
  });

  it("an explicit cutover run classifies them like anyone else (here: replace at period end)", async () => {
    const p = await previewMigration(stripeStub, "t1", new Date("2026-10-02T12:00:00Z"), { includeTeamUpBilled: true });
    expect(p.rows[0].action).toBe("replace");
    expect(p.rows[0].replacesSubscriptionId).toBe("sub_live");
  });
});

describe("overdue derivation never invents a debt for a TeamUp-billed member", () => {
  it("the date-derived branch and the no-payment-yet rule both exclude billedBy teamup", () => {
    const [, derived] = overdueClause(new Date("2026-10-02T12:00:00Z")) as [unknown, Record<string, unknown>];
    expect(derived.billedBy).toEqual({ not: "teamup" });
    expect(noPaymentYetWhere().billedBy).toEqual({ not: "teamup" });
  });
});

describe("the webhook matches members by Stripe customer id only", () => {
  it("findMember keys on stripeCustomerId and the route never looks a member up by email", () => {
    const src = readFileSync("app/api/stripe/webhook/route.ts", "utf8");
    const fn = src.slice(src.indexOf("async function findMember"), src.indexOf("async function findMember") + 1500);
    expect(fn).toMatch(/stripeCustomerId:\s*customerId/);
    // Every member lookup in the handler goes through findMember or an id; an
    // imported member (no Stripe customer) is therefore never touched by
    // events for TeamUp's own subscriptions on the same Stripe account.
    expect(src).not.toMatch(/member\.find(First|Unique|Many)\(\{\s*where:\s*\{[^}]*\bemail:/);
  });
});
