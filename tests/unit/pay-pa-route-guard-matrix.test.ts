// Lane PA (payments defect 1, 11 Oct 2026) — the wrong-account checkout path.
//
// Audit docs/payments/STRIPE-CONNECT-AUDIT-2026-10-11.md §4 / F2: the member
// shop passed `{ stripeAccount }` only when `stripeConnected` was true, and
// after a deauthorisation (id kept, flag cleared) plus 24 h of cache age the
// account-status refresh failed OPEN on a permission error — so the Checkout
// Session was created on MatFlow's own platform account. Other routes checked
// a different subset of the same three fields.
//
// Required behaviour (Noe): "Missing, stale, disconnected or unverifiable club
// authorisation must refuse checkout. Never fall back to the platform account.
// Cover every payment-creation route."
//
// This file drives EVERY Stripe-calling route in lane PA through the real
// route handler, the real club-account guard and the real account-status
// refresh. Only the edges are faked: the database transaction (a fixture
// tx), the session, and the Stripe SDK (a class whose methods record their
// arguments). For each route it checks the same matrix:
//   - account id missing                         -> refused, no Stripe call
//   - id present, stripeConnected false          -> refused, no Stripe call
//   - connected, stale status, permission error  -> refused, no Stripe call
//   - connected, stale status, refresh timeout   -> refused, no Stripe call
//   - connected, fresh, chargesEnabled false     -> money-in routes refused;
//                                                   money-out / manage routes
//                                                   proceed ON THE CLUB ACCOUNT
//   - disabledReason "deauthorized" < 24 h       -> refused, no Stripe call
//   - TeamUp-billed member (where the route has
//     the bridge guard)                          -> refused by
//                                                   refuseIfBilledElsewhere
//                                                   before the account is read
//   - healthy                                    -> succeeds, and EVERY Stripe
//                                                   call carries stripeAccount
//                                                   equal to the tenant's id

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const CLUB_ACCOUNT = "acct_club_pa_1";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  tenantRow: {} as Record<string, unknown>,
  memberRow: {} as Record<string, unknown>,
  tierRow: null as Record<string, unknown> | null,
  paymentRow: null as Record<string, unknown> | null,
  tenantUpdates: [] as unknown[],
  calls: [] as { method: string; args: unknown[] }[],
  retrieve: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
    headers: new Headers(),
  }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, tenantId: "t1", userId: "u1", session: { user: { id: "u1", tenantId: "t1", role: "owner" } } }),
  requireApiOwnerOrManager: async () => ({ ok: true, tenantId: "t1", userId: "u1", session: { user: { id: "u1", tenantId: "t1", role: "owner" } } }),
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/env-url", () => ({ getBaseUrl: () => "https://club.test" }));

vi.mock("@/lib/prisma-tenant", () => {
  const ok = <T,>(v: T) => vi.fn(async () => v);
  const tx = () => ({
    $executeRaw: ok(0),
    // Lane PC writes a MemberSubscription mapping inside the create transaction (11 Oct 2026).
    memberSubscription: {
      upsert: vi.fn(async (a: { create: { tenantId: string; memberId: string } }) => ({
        id: "ms_1",
        tenantId: a.create.tenantId,
        memberId: a.create.memberId,
      })),
    },
    tenant: {
      findUnique: vi.fn(async () => ({ ...m.tenantRow })),
      findFirst: vi.fn(async () => ({ ...m.tenantRow })),
      update: vi.fn(async (a: unknown) => { m.tenantUpdates.push(a); return {}; }),
      updateMany: vi.fn(async (a: unknown) => { m.tenantUpdates.push(a); return { count: 1 }; }),
    },
    member: {
      findFirst: vi.fn(async () => ({ ...m.memberRow })),
      findUnique: vi.fn(async () => ({ ...m.memberRow })),
      update: ok({}),
      updateMany: ok({ count: 1 }),
    },
    classPack: {
      findFirst: ok({ id: "pack_1", name: "10 classes", stripePriceId: "price_pack_1", isActive: true }),
      create: ok({ id: "cp_new" }),
    },
    product: { findMany: ok([{ id: "prod_1", pricePence: 1000 }]) },
    order: { create: ok({}), updateMany: ok({ count: 1 }) },
    payment: {
      findFirst: vi.fn(async () => (m.paymentRow ? { ...m.paymentRow } : null)),
      upsert: ok({}),
      create: ok({}),
      updateMany: ok({ count: 1 }),
    },
    membershipTier: { findFirst: vi.fn(async () => (m.tierRow ? { ...m.tierRow } : null)) },
    memberClassPack: { findUnique: ok(null) },
    classPackRedemption: { count: ok(0) },
  });
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
  };
});

vi.mock("stripe", () => {
  const rec = (method: string, result: unknown) =>
    (...args: unknown[]) => { m.calls.push({ method, args }); return Promise.resolve(result); };
  class MockStripe {
    accounts = { retrieve: (...a: unknown[]) => m.retrieve(...a) };
    checkout = { sessions: { create: rec("checkout.sessions.create", { id: "cs_1", url: "https://checkout.test/cs_1" }) } };
    customers = { create: rec("customers.create", { id: "cus_new" }) };
    paymentIntents = { create: rec("paymentIntents.create", { id: "pi_new", status: "succeeded" }) };
    refunds = { create: rec("refunds.create", { id: "re_1", amount: 1000, charge: "ch_1", status: "succeeded" }) };
    charges = { retrieve: rec("charges.retrieve", { id: "ch_1", amount_refunded: 1000 }) };
    subscriptions = {
      create: rec("subscriptions.create", {
        id: "sub_new",
        latest_invoice: { id: "in_1", confirmation_secret: { client_secret: "pi_x_secret_y", type: "payment_intent" } },
      }),
      update: rec("subscriptions.update", { id: "sub_1", cancel_at: Math.floor(Date.now() / 1000) + 86400 }),
      cancel: rec("subscriptions.cancel", { id: "sub_1" }),
    };
    billingPortal = { sessions: { create: rec("billingPortal.sessions.create", { id: "bps_1", url: "https://portal.test/bps_1" }) } };
    products = { create: rec("products.create", { id: "prod_new", name: "Adult" }) };
    prices = {
      create: rec("prices.create", { id: "price_new" }),
      list: rec("prices.list", { data: [] }),
    };
    oauth = { deauthorize: rec("oauth.deauthorize", {}) };
  }
  return { default: MockStripe };
});

type Handler = (req: Request, ctx?: unknown) => Promise<{ status: number; json: () => Promise<unknown> }>;

type RouteSpec = {
  name: string;
  load: () => Promise<Handler>;
  body?: unknown;
  ctx?: unknown;
  role: "member" | "owner";
  memberOverrides?: Record<string, unknown>;
  tier?: Record<string, unknown> | null;
  payment?: Record<string, unknown> | null;
  /** True when this route starts or restarts a collection: a club account that cannot take charges must refuse. */
  moneyIn: boolean;
  /** Routes that carry the TeamUp bridge guard. */
  billedElsewhereGuard: boolean;
  successStatus: number;
  /** The Stripe calls a healthy request must make. */
  moneyCalls: string[];
  /** GET plans answers an empty list instead of an error code. */
  refusalIsEmptyList?: boolean;
};

const ROUTES: RouteSpec[] = [
  {
    name: "member shop checkout (app/api/member/checkout)",
    load: async () => (await import("@/app/api/member/checkout/route")).POST as unknown as Handler,
    body: { items: [{ id: "prod_1", name: "Tee", price: 10, quantity: 1 }] },
    role: "member", moneyIn: true, billedElsewhereGuard: true, successStatus: 200,
    moneyCalls: ["checkout.sessions.create"],
  },
  {
    name: "class-pack purchase (app/api/member/class-packs/buy)",
    load: async () => (await import("@/app/api/member/class-packs/buy/route")).POST as unknown as Handler,
    body: { packId: "pack_1" },
    role: "member", moneyIn: true, billedElsewhereGuard: true, successStatus: 200,
    moneyCalls: ["checkout.sessions.create"],
  },
  {
    name: "ad-hoc card charge (app/api/members/[id]/charge)",
    load: async () => (await import("@/app/api/members/[id]/charge/route")).POST as unknown as Handler,
    body: { amountPence: 1000, description: "Mat fee", requestId: "req_12345678" },
    ctx: { params: Promise.resolve({ id: "mem_1" }) },
    role: "owner", moneyIn: true, billedElsewhereGuard: true, successStatus: 200,
    moneyCalls: ["paymentIntents.create"],
  },
  {
    name: "refund (app/api/payments/[id]/refund)",
    load: async () => (await import("@/app/api/payments/[id]/refund/route")).POST as unknown as Handler,
    body: {},
    ctx: { params: Promise.resolve({ id: "pay_1" }) },
    payment: {
      id: "pay_1", tenantId: "t1", memberId: "mem_1", amountPence: 1000, currency: "GBP", status: "succeeded",
      refundedAmountPence: null, stripeChargeId: null, stripePaymentIntentId: "pi_1", stripeInvoiceId: null,
    },
    role: "owner", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["refunds.create"],
  },
  {
    name: "member billing portal (app/api/stripe/portal)",
    load: async () => (await import("@/app/api/stripe/portal/route")).POST as unknown as Handler,
    role: "member", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["billingPortal.sessions.create"],
  },
  {
    name: "guardian billing portal (app/api/member/family/[id]/billing/portal)",
    load: async () => (await import("@/app/api/member/family/[id]/billing/portal/route")).POST as unknown as Handler,
    ctx: { params: Promise.resolve({ id: "mem_1" }) },
    role: "member", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["billingPortal.sessions.create"],
  },
  {
    name: "staff subscribe (app/api/stripe/create-subscription)",
    load: async () => (await import("@/app/api/stripe/create-subscription/route")).POST as unknown as Handler,
    body: { memberId: "mem_1", priceId: "price_1", requestId: "req_12345678" },
    memberOverrides: { stripeSubscriptionId: null },
    // Round 2 (RP-2): the staff route now resolves the price's active tier.
    tier: { id: "tier_1", isKids: false, name: "Adult", stripePriceId: "price_1" },
    role: "owner", moneyIn: true, billedElsewhereGuard: true, successStatus: 200,
    moneyCalls: ["subscriptions.create"],
  },
  {
    name: "member self-subscribe (app/api/member/subscriptions/start)",
    load: async () => (await import("@/app/api/member/subscriptions/start/route")).POST as unknown as Handler,
    body: { priceId: "price_1", requestId: "req_12345678" },
    memberOverrides: { stripeSubscriptionId: null },
    tier: { id: "tier_1", isKids: false, name: "Adult" },
    role: "member", moneyIn: true, billedElsewhereGuard: true, successStatus: 201,
    moneyCalls: ["subscriptions.create"],
  },
  {
    name: "guardian subscribes a child (app/api/member/subscriptions/start-for-kid)",
    load: async () => (await import("@/app/api/member/subscriptions/start-for-kid/route")).POST as unknown as Handler,
    body: { kidMemberId: "mem_1", priceId: "price_1", requestId: "req_12345678" },
    memberOverrides: { stripeSubscriptionId: null },
    tier: { id: "tier_k", isKids: true, name: "Kids" },
    role: "member", moneyIn: true, billedElsewhereGuard: true, successStatus: 201,
    moneyCalls: ["subscriptions.create"],
  },
  {
    name: "owner creates a plan price (app/api/stripe/subscription-plans POST)",
    load: async () => (await import("@/app/api/stripe/subscription-plans/route")).POST as unknown as Handler,
    body: { name: "Adult", amount: 50, interval: "month" },
    role: "owner", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["products.create", "prices.create"],
  },
  {
    name: "owner lists plan prices (app/api/stripe/subscription-plans GET)",
    load: async () => {
      const get = (await import("@/app/api/stripe/subscription-plans/route")).GET;
      return (() => get()) as unknown as Handler;
    },
    role: "owner", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["prices.list"], refusalIsEmptyList: true,
  },
  {
    name: "owner creates a class pack (app/api/class-packs POST)",
    load: async () => (await import("@/app/api/class-packs/route")).POST as unknown as Handler,
    body: { name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 5000 },
    role: "owner", moneyIn: false, billedElsewhereGuard: false, successStatus: 201,
    moneyCalls: ["products.create", "prices.create"],
  },
  {
    name: "hold (app/api/members/[id]/hold)",
    load: async () => (await import("@/app/api/members/[id]/hold/route")).POST as unknown as Handler,
    body: {},
    ctx: { params: Promise.resolve({ id: "mem_1" }) },
    memberOverrides: { stripeSubscriptionId: "sub_1", paymentStatus: "paid", status: "active" },
    role: "owner", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["subscriptions.update"],
  },
  {
    name: "resume (app/api/members/[id]/resume)",
    load: async () => (await import("@/app/api/members/[id]/resume/route")).POST as unknown as Handler,
    ctx: { params: Promise.resolve({ id: "mem_1" }) },
    memberOverrides: { stripeSubscriptionId: "sub_1", paymentStatus: "paused" },
    role: "owner", moneyIn: true, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["subscriptions.update"],
  },
  {
    name: "member self-cancel (app/api/member/subscriptions/cancel)",
    load: async () => (await import("@/app/api/member/subscriptions/cancel/route")).POST as unknown as Handler,
    memberOverrides: { stripeSubscriptionId: "sub_1" },
    role: "member", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["subscriptions.update"],
  },
  {
    name: "guardian cancels a child (app/api/member/subscriptions/cancel-for-kid)",
    load: async () => (await import("@/app/api/member/subscriptions/cancel-for-kid/route")).POST as unknown as Handler,
    body: { kidMemberId: "mem_1" },
    memberOverrides: { stripeSubscriptionId: "sub_1" },
    role: "member", moneyIn: false, billedElsewhereGuard: false, successStatus: 200,
    moneyCalls: ["subscriptions.update"],
  },
];

const HOUR = 60 * 60 * 1000;
const status = (over: Record<string, unknown>, ageMs = HOUR) => ({
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsPastDue: [],
  disabledReason: null,
  refreshedAt: new Date(Date.now() - ageMs).toISOString(),
  ...over,
});

const permissionError = () =>
  Object.assign(new Error("The provided key does not have the required permissions for this endpoint on account 'acct_club_pa_1'."), {
    type: "StripePermissionError",
    statusCode: 403,
  });
// What the Stripe SDK throws when its own request timeout fires.
const timeoutError = () =>
  Object.assign(new Error("Request aborted due to timeout being reached (5000ms)"), { type: "StripeConnectionError" });

function makeReq(body: unknown): Request {
  return {
    method: "POST",
    url: "https://club.test/api/x",
    nextUrl: { origin: "https://club.test" },
    headers: new Headers({ origin: "https://club.test", host: "club.test" }),
    json: async () => (body === undefined ? {} : body),
  } as unknown as Request;
}

function baseTenant(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Club",
    stripeAccountId: CLUB_ACCOUNT,
    stripeConnected: true,
    stripeAccountStatus: status({}),
    memberSelfBilling: true,
    paymentRail: null,
    currency: "GBP",
    acceptsBacs: false,
    ...over,
  };
}

const nonRetrieveCalls = () => m.calls.filter((c) => c.method !== "oauth.deauthorize");

const handlers: Record<string, Handler> = {};
beforeAll(async () => {
  for (const r of ROUTES) handlers[r.name] = await r.load();
});

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.tenantUpdates.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_lane_pa_fixture";
  m.retrieve.mockReset();
  m.retrieve.mockImplementation(async () => ({
    id: CLUB_ACCOUNT, charges_enabled: true, payouts_enabled: true, requirements: { past_due: [], disabled_reason: null },
  }));
});

function arrange(r: RouteSpec, tenantOver: Record<string, unknown>, memberOver: Record<string, unknown> = {}) {
  m.tenantRow = baseTenant(tenantOver);
  m.memberRow = {
    id: "mem_1", tenantId: "t1", name: "Sam", email: "sam@example.test", stripeCustomerId: "cus_1",
    stripeSubscriptionId: null, parentMemberId: null,
    billedBy: "matflow", status: "active", paymentStatus: "paid", holdUntil: null, holdPriorStatus: null,
    accountType: "junior",
    ...(r.memberOverrides ?? {}),
    ...memberOver,
  };
  m.tierRow = r.tier ?? null;
  m.paymentRow = r.payment ?? null;
  m.auth.mockResolvedValue({
    user: { id: "u1", tenantId: "t1", memberId: "mem_1", role: r.role },
  });
}

async function call(r: RouteSpec) {
  const res = await handlers[r.name](makeReq(r.body), r.ctx);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function expectRefused(r: RouteSpec, expectedStatus: 409 | 503, reason: string) {
  const { status: s, body } = await call(r);
  if (r.refusalIsEmptyList) {
    expect(s).toBe(200);
    expect(body.plans).toEqual([]);
    expect(body.reason).toBe(reason);
  } else {
    expect(s).toBe(expectedStatus);
    expect(body.reason).toBe(reason);
    expect(typeof body.error).toBe("string");
  }
  // Nothing reached Stripe on any account — above all, nothing on the platform.
  expect(nonRetrieveCalls()).toEqual([]);
}

async function expectSucceededOnClubAccount(r: RouteSpec) {
  const { status: s, body } = await call(r);
  expect(s, JSON.stringify(body)).toBe(r.successStatus);
  const made = nonRetrieveCalls();
  for (const name of r.moneyCalls) {
    expect(made.map((c) => c.method)).toContain(name);
  }
  // Every call — money calls and the reads around them — carries the club's
  // account id in its request options. The options object is the LAST argument
  // of every stripe-node method.
  for (const c of made) {
    const opts = c.args[c.args.length - 1] as { stripeAccount?: unknown } | undefined;
    expect(opts, `${c.method} was called without request options`).toBeTypeOf("object");
    expect(opts?.stripeAccount, `${c.method} stripeAccount`).toBe(CLUB_ACCOUNT);
  }
}

describe.each(ROUTES)("$name", (r) => {
  it("refuses when the club has no Stripe account id", async () => {
    arrange(r, { stripeAccountId: null, stripeConnected: false, stripeAccountStatus: null });
    await expectRefused(r, 409, "no_account");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("refuses when the id is kept but stripeConnected is false (disconnected)", async () => {
    arrange(r, { stripeConnected: false, stripeAccountStatus: status({}, 30 * HOUR) });
    await expectRefused(r, 409, "not_connected");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("refuses when the status is stale and the refresh is refused for permissions (no fail-open)", async () => {
    arrange(r, { stripeAccountStatus: status({}, 25 * HOUR) });
    m.retrieve.mockRejectedValue(permissionError());
    await expectRefused(r, 503, "status_unreadable");
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });

  it("refuses when the status is stale and the refresh times out", async () => {
    arrange(r, { stripeAccountStatus: status({}, 25 * HOUR) });
    m.retrieve.mockRejectedValue(timeoutError());
    await expectRefused(r, 503, "status_unreadable");
  });

  if (r.moneyIn) {
    it("refuses when the fresh status says charges are disabled", async () => {
      arrange(r, { stripeAccountStatus: status({ chargesEnabled: false, disabledReason: "requirements.past_due" }) });
      await expectRefused(r, 503, "charges_disabled");
      expect(m.retrieve).not.toHaveBeenCalled();
    });
  } else {
    it("still acts ON THE CLUB ACCOUNT when charges are disabled (refund / cancel / pause / manage must not be blocked)", async () => {
      arrange(r, { stripeAccountStatus: status({ chargesEnabled: false, disabledReason: "requirements.past_due" }) });
      await expectSucceededOnClubAccount(r);
    });
  }

  it("refuses when the cached status records a deauthorisation within 24 h, even if the flag reads connected", async () => {
    arrange(r, { stripeConnected: true, stripeAccountStatus: status({ chargesEnabled: false, payoutsEnabled: false, disabledReason: "deauthorized" }) });
    await expectRefused(r, 409, "deauthorized");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("refuses the webhook-deauthorised shape (flag false, id kept, status deauthorized)", async () => {
    arrange(r, { stripeConnected: false, stripeAccountStatus: status({ chargesEnabled: false, disabledReason: "deauthorized" }, 30 * HOUR) });
    await expectRefused(r, 409, "deauthorized");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("re-verifies a cached status_unreadable instead of trusting or refusing it blindly", async () => {
    arrange(r, { stripeAccountStatus: status({ chargesEnabled: false, payoutsEnabled: false, disabledReason: "status_unreadable" }) });
    m.retrieve.mockRejectedValue(permissionError());
    await expectRefused(r, 503, "status_unreadable");
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });

  if (r.billedElsewhereGuard) {
    it("a TeamUp-billed member is refused by refuseIfBilledElsewhere first (unchanged)", async () => {
      // The account is ALSO unverifiable here: if the club-account guard ran
      // first the answer would be 503 status_unreadable, not the bridge 409.
      arrange(r, { stripeAccountStatus: status({}, 25 * HOUR) }, { billedBy: "teamup" });
      m.retrieve.mockRejectedValue(permissionError());
      const { status: s, body } = await call(r);
      expect(s).toBe(409);
      expect(body.reason).toBe("billed_elsewhere");
      expect(m.retrieve).not.toHaveBeenCalled();
      expect(nonRetrieveCalls()).toEqual([]);
    });
  }

  it("succeeds on a healthy club and every Stripe call carries stripeAccount = the club's id", async () => {
    arrange(r, {});
    await expectSucceededOnClubAccount(r);
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("succeeds after a stale status is refreshed successfully, still on the club's id", async () => {
    arrange(r, { stripeAccountStatus: status({}, 25 * HOUR) });
    await expectSucceededOnClubAccount(r);
    expect(m.retrieve).toHaveBeenCalledWith(CLUB_ACCOUNT);
  });
});

// The audit's exact sequence (§4 / F2), asserted on the Stripe call itself: a
// club deauthorised more than 24 h ago (webhook kept the id, cleared the flag)
// whose refresh is refused for permissions. Whatever the route answers, no
// Checkout Session may be created without the club's account in its options —
// a missing stripeAccount is a session on MatFlow's own platform account.
describe("F2 regression: deauthorised club, cache expired, permission error on refresh", () => {
  it("never creates a Checkout Session on the platform account", async () => {
    const r = ROUTES[0];
    arrange(r, {
      stripeConnected: false,
      stripeAccountStatus: status({ chargesEnabled: false, payoutsEnabled: false, disabledReason: "deauthorized" }, 25 * HOUR),
    });
    m.retrieve.mockRejectedValue(permissionError());
    const { status: s } = await call(r);
    const sessions = m.calls.filter((c) => c.method === "checkout.sessions.create");
    for (const c of sessions) {
      const opts = c.args[1] as { stripeAccount?: string } | undefined;
      expect(opts?.stripeAccount, "checkout session created without stripeAccount = platform account").toBe(CLUB_ACCOUNT);
    }
    expect(sessions).toHaveLength(0);
    expect(s).toBe(409);
  });
});
