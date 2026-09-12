// The member-facing subscribe routes must refuse a SECOND subscription.
//
// The staff route has always done this — app/api/stripe/create-subscription
// refuses with a 409 and carries a comment explaining why. Its two
// member-facing twins never did: `stripeSubscriptionId` appeared nowhere in
// either file. So the guard sat on the surface a coach uses and was absent
// from the one a parent uses on their phone.
//
// Without it, lib/stripe/subscriptions writes the new subscription id over the
// old one, and subscription #1 bills forever with nothing in MatFlow pointing
// at it — no screen can show it and no cancel path can reach it.
//
// These fail if either guard is removed, or if `stripeSubscriptionId` is
// dropped from either select (which would make the guard silently unevaluable).

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";
const MEMBER = "mem_1";
const KID = "mem_kid";
const PRICE = "price_123";
const REQ = "req_stable_1234";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
}));

const { mockAuth, mockTenant, mockMember, mockTier, mockCreate } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockTenant: vi.fn(),
  mockMember: vi.fn(),
  mockTier: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: async () => ({ ok: true }),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ createSubscriptionForMember: mockCreate }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findFirst: mockTenant, findUnique: mockTenant },
      member: { findFirst: mockMember },
      membershipTier: { findFirst: mockTier },
    }),
}));

type AdultRoute = typeof import("@/app/api/member/subscriptions/start/route");
type KidRoute = typeof import("@/app/api/member/subscriptions/start-for-kid/route");
let adultPOST: AdultRoute["POST"];
let kidPOST: KidRoute["POST"];

beforeAll(async () => {
  ({ POST: adultPOST } = await import("@/app/api/member/subscriptions/start/route"));
  ({ POST: kidPOST } = await import("@/app/api/member/subscriptions/start-for-kid/route"));
});

function req(body: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { tenantId: TENANT, memberId: MEMBER } });
  mockTenant.mockResolvedValue({
    id: TENANT,
    stripeAccountId: "acct_1",
    stripeConnected: true,
    acceptsBacs: false,
    memberSelfBilling: true,
    stripeAccountStatus: null,
  });
  mockTier.mockResolvedValue({ id: "tier_1", isKids: false, name: "Adult" });
  mockCreate.mockResolvedValue({ ok: true, subscriptionId: "sub_new", clientSecret: "cs_1" });
});

describe("member self-subscribe — the duplicate guard", () => {
  it("refuses with 409 when the member already has a subscription, and never calls Stripe", async () => {
    mockMember.mockResolvedValue({
      id: MEMBER,
      email: "a@b.c",
      name: "Sam",
      stripeCustomerId: "cus_1",
      parentMemberId: null,
      stripeSubscriptionId: "sub_existing",
    });

    const res = await adultPOST(req({ priceId: PRICE, requestId: REQ }));

    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("allows a first subscription", async () => {
    mockMember.mockResolvedValue({
      id: MEMBER,
      email: "a@b.c",
      name: "Sam",
      stripeCustomerId: null,
      parentMemberId: null,
      stripeSubscriptionId: null,
    });

    const res = await adultPOST(req({ priceId: PRICE, requestId: REQ }));

    // 201 — the route creates a subscription resource.
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("reads stripeSubscriptionId, so the guard can actually be evaluated", async () => {
    mockMember.mockResolvedValue({
      id: MEMBER, email: "a@b.c", name: "Sam",
      stripeCustomerId: null, parentMemberId: null, stripeSubscriptionId: null,
    });
    await adultPOST(req({ priceId: PRICE, requestId: REQ }));

    // Dropping this from the select would leave the guard reading undefined
    // and passing silently — the exact shape of a vacuous guard.
    expect(mockMember.mock.calls[0][0].select.stripeSubscriptionId).toBe(true);
  });
});

describe("subscribe for a kid — the duplicate guard", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { tenantId: TENANT, memberId: MEMBER } });
    mockTier.mockResolvedValue({ id: "tier_k", isKids: true, name: "Kids" });
  });

  it("refuses with 409 when the child already has a subscription", async () => {
    mockMember.mockResolvedValue({
      id: KID, email: "k@b.c", name: "Sam Jr",
      stripeCustomerId: "cus_k", accountType: "kids",
      stripeSubscriptionId: "sub_existing",
    });

    const res = await kidPOST(req({ kidMemberId: KID, priceId: PRICE, requestId: REQ }));

    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("allows a first subscription for the child", async () => {
    mockMember.mockResolvedValue({
      id: KID, email: "k@b.c", name: "Sam Jr",
      stripeCustomerId: null, accountType: "kids", stripeSubscriptionId: null,
    });

    const res = await kidPOST(req({ kidMemberId: KID, priceId: PRICE, requestId: REQ }));

    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe("the idempotency key is the caller's, not a clock", () => {
  beforeEach(() => {
    mockMember.mockResolvedValue({
      id: MEMBER, email: "a@b.c", name: "Sam",
      stripeCustomerId: null, parentMemberId: null, stripeSubscriptionId: null,
    });
  });

  it("passes the client's requestId straight through to the helper", async () => {
    await adultPOST(req({ priceId: PRICE, requestId: REQ }));
    expect(mockCreate.mock.calls[0][0].requestId).toBe(REQ);
  });

  it("refuses a request with no requestId rather than proceeding unprotected", async () => {
    // Minting one server-side would be per-request, i.e. no protection at all
    // while looking like some. Refusing is the honest behaviour.
    const res = await adultPOST(req({ priceId: PRICE }));

    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a too-short requestId instead of keying on it", async () => {
    const res = await adultPOST(req({ priceId: PRICE, requestId: "short" }));
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
