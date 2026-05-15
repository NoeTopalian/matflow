// F2 — member self-subscribe stub-Stripe integration tests.
//
// Promotes app/api/member/subscriptions/start and /cancel from Tier B
// (shipped but unverified) to Tier A by exercising the gate logic + happy
// path against a mocked Stripe SDK. The real-money walk (test-mode Stripe
// account + SCA flow) is a separate manual verification.
//
// Stubs:
//   - `stripe` SDK: customers.create returns a fake cus_, subscriptions
//     .create returns a fake sub_ with a payment_intent client_secret
//   - lib/stripe-account-status: ensureCanAcceptCharges always { ok: true }
//   - @/auth: vi.mocked so we can swap session.user.memberId per case
//
// Skips when TEST_DATABASE_URL is unset, matching every other integration
// test in the suite.

import { vi, describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: vi.fn(async () => ({ ok: true })),
}));

// Stripe SDK stub. The route imports Stripe via `await import("stripe")`,
// so the default export must be a constructable class returning the
// faked methods. vi.mock hoists to top so the dynamic import sees this
// shape every time.
vi.mock("stripe", () => {
  const create = vi.fn(async () => ({ id: "cus_test_self_123" }));
  const subscriptionsCreate = vi.fn(async () => ({
    id: "sub_test_self_456",
    latest_invoice: { payment_intent: { client_secret: "pi_test_self_secret_789" } },
  }));
  const subscriptionsUpdate = vi.fn(async () => ({
    id: "sub_test_self_456",
    cancel_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  }));
  return {
    default: vi.fn().mockImplementation(() => ({
      customers: { create },
      subscriptions: { create: subscriptionsCreate, update: subscriptionsUpdate },
    })),
  };
});

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as startSub } from "@/app/api/member/subscriptions/start/route";
import { POST as cancelSub } from "@/app/api/member/subscriptions/cancel/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const STRIPE_PRICE_ID = "price_test_adult_monthly";

function jsonReq(url: string, body: unknown): Request {
  return new Request(`https://test.local${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("F2 member self-subscribe", () => {
  let tenantWithBilling: string;
  let tenantWithoutBilling: string;
  let tenantBillingNoStripe: string;
  let memberId: string;
  let kidId: string;

  // Fresh ENV before the route reads it.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_stub";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      // Tenant A — Stripe connected + memberSelfBilling on (happy-path host)
      const tA = await tx.tenant.create({
        data: {
          name: "F2-billing-on",
          slug: `f2-on-${STAMP}`,
          stripeConnected: true,
          stripeAccountId: "acct_test_f2",
          stripeAccountStatus: "active",
          acceptsBacs: false,
          memberSelfBilling: true,
        },
      });
      tenantWithBilling = tA.id;

      // Tenant B — Stripe connected + memberSelfBilling off (the 403 case)
      const tB = await tx.tenant.create({
        data: {
          name: "F2-billing-off",
          slug: `f2-off-${STAMP}`,
          stripeConnected: true,
          stripeAccountId: "acct_test_f2_off",
          stripeAccountStatus: "active",
          memberSelfBilling: false,
        },
      });
      tenantWithoutBilling = tB.id;

      // Tenant C — Stripe NOT connected + flag on (the 503 case)
      const tC = await tx.tenant.create({
        data: {
          name: "F2-no-stripe",
          slug: `f2-nostr-${STAMP}`,
          stripeConnected: false,
          memberSelfBilling: true,
        },
      });
      tenantBillingNoStripe = tC.id;

      // One adult member + one kid (used for the sub-account 403 case)
      const adult = await tx.member.create({
        data: { tenantId: tA.id, name: "Adult Self", email: `adult-self-${STAMP}@f2.test` },
      });
      memberId = adult.id;
      const kid = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Kid Self",
          email: `kid-self-${STAMP}@no-login.matflow.local`,
          accountType: "kids",
          parentMemberId: adult.id,
          passwordHash: null,
        },
      });
      kidId = kid.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId: tenantWithBilling } }));
    await withRlsBypass((tx) =>
      tx.tenant.deleteMany({
        where: { id: { in: [tenantWithBilling, tenantWithoutBilling, tenantBillingNoStripe] } },
      }),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when tenant.memberSelfBilling is off", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-x", memberId, tenantId: tenantWithoutBilling, role: "member", email: "x" },
    } as never);
    const res = await startSub(jsonReq("/api/member/subscriptions/start", { priceId: STRIPE_PRICE_ID }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/manages payments centrally/i);
  });

  it("returns 503 when Stripe is not connected", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-x", memberId, tenantId: tenantBillingNoStripe, role: "member", email: "x" },
    } as never);
    const res = await startSub(jsonReq("/api/member/subscriptions/start", { priceId: STRIPE_PRICE_ID }));
    expect(res.status).toBe(503);
  });

  it("returns 403 for a sub-account trying to self-subscribe", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-kid", memberId: kidId, tenantId: tenantWithBilling, role: "member", email: "k" },
    } as never);
    const res = await startSub(jsonReq("/api/member/subscriptions/start", { priceId: STRIPE_PRICE_ID }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/sub-accounts can't self-subscribe/i);
  });

  it("returns 400 on an invalid priceId shape", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-x", memberId, tenantId: tenantWithBilling, role: "member", email: "x" },
    } as never);
    const res = await startSub(jsonReq("/api/member/subscriptions/start", { priceId: "wrong_prefix_123" }));
    expect(res.status).toBe(400);
  });

  it("happy path returns 201 + clientSecret + persists stripeSubscriptionId", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-x", memberId, tenantId: tenantWithBilling, role: "member", email: "x" },
    } as never);
    const res = await startSub(jsonReq("/api/member/subscriptions/start", { priceId: STRIPE_PRICE_ID }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { subscriptionId: string; clientSecret: string };
    expect(body.subscriptionId).toBe("sub_test_self_456");
    expect(body.clientSecret).toBe("pi_test_self_secret_789");

    const fresh = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: memberId },
        select: { stripeCustomerId: true, stripeSubscriptionId: true },
      }),
    );
    expect(fresh?.stripeCustomerId).toBe("cus_test_self_123");
    expect(fresh?.stripeSubscriptionId).toBe("sub_test_self_456");
  });

  it("cancel returns 200 + cancelAt when called against an active subscription", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-x", memberId, tenantId: tenantWithBilling, role: "member", email: "x" },
    } as never);
    const res = await cancelSub(
      new Request("https://test.local/api/member/subscriptions/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.cancelAt).toBe("number");
  });
});
