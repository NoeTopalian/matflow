// F3 — parent-pays-for-kid stub-Stripe integration tests.
//
// Mirror of F2 self-pay tests, scoped to the parent → kid endpoints
// (/start-for-kid, /cancel-for-kid, /api/member/family/[id]/billing).
// Verifies the composite-predicate scoping (invariant I4) — a parent
// cannot subscribe another parent's kid — plus the gating, end-of-cycle
// cancel, and billing-read shape.
//
// Same Stripe SDK stub strategy as member-self-pay.test.ts.

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

vi.mock("stripe", () => {
  const create = vi.fn(async () => ({ id: "cus_test_kid_123" }));
  const subscriptionsCreate = vi.fn(async () => ({
    id: "sub_test_kid_456",
    latest_invoice: { payment_intent: { client_secret: "pi_test_kid_secret_789" } },
  }));
  const subscriptionsUpdate = vi.fn(async () => ({
    id: "sub_test_kid_456",
    cancel_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
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
import { POST as startForKid } from "@/app/api/member/subscriptions/start-for-kid/route";
import { POST as cancelForKid } from "@/app/api/member/subscriptions/cancel-for-kid/route";
import { GET as readBilling } from "@/app/api/member/family/[id]/billing/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const KID_PRICE_ID = "price_test_kid_monthly";

function jsonReq(url: string, body: unknown): Request {
  return new Request(`https://test.local${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

function getReq(url: string): Request {
  return new Request(`https://test.local${url}`, {
    method: "GET",
    headers: { origin: "https://test.local", host: "test.local" },
  });
}

describe.skipIf(!HAS_DB)("F3 parent pays for kid", () => {
  let tenantId: string;
  let parentAId: string;
  let kidAId: string;
  let parentBId: string;
  let kidBId: string;

  process.env.STRIPE_SECRET_KEY = "sk_test_fake_for_stub_kid";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: "F3-billing-on",
          slug: `f3-${STAMP}`,
          stripeConnected: true,
          stripeAccountId: "acct_test_f3",
          stripeAccountStatus: "active",
          acceptsBacs: false,
          memberSelfBilling: true,
        },
      });
      tenantId = t.id;

      const pA = await tx.member.create({
        data: { tenantId, name: "Parent A", email: `parent-a-f3-${STAMP}@f3.test`, accountType: "parent" },
      });
      parentAId = pA.id;
      const kA = await tx.member.create({
        data: {
          tenantId,
          name: "Kid A",
          email: `kid-a-${STAMP}@no-login.matflow.local`,
          accountType: "kids",
          parentMemberId: pA.id,
          passwordHash: null,
        },
      });
      kidAId = kA.id;

      const pB = await tx.member.create({
        data: { tenantId, name: "Parent B", email: `parent-b-f3-${STAMP}@f3.test`, accountType: "parent" },
      });
      parentBId = pB.id;
      const kB = await tx.member.create({
        data: {
          tenantId,
          name: "Kid B",
          email: `kid-b-${STAMP}@no-login.matflow.local`,
          accountType: "kids",
          parentMemberId: pB.id,
          passwordHash: null,
        },
      });
      kidBId = kB.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("composite-predicate: parent A cannot subscribe parent B's kid (404)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await startForKid(
      jsonReq("/api/member/subscriptions/start-for-kid", {
        kidMemberId: kidBId,
        priceId: KID_PRICE_ID,
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found in your family/i);
  });

  it("parent A subscribing own kid returns 201 + clientSecret", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await startForKid(
      jsonReq("/api/member/subscriptions/start-for-kid", {
        kidMemberId: kidAId,
        priceId: KID_PRICE_ID,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { subscriptionId: string; clientSecret: string };
    expect(body.subscriptionId).toBe("sub_test_kid_456");
    expect(body.clientSecret).toBe("pi_test_kid_secret_789");

    // The Stripe subscription should attach to the KID's row, not the parent's.
    const kid = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: kidAId },
        select: { stripeCustomerId: true, stripeSubscriptionId: true },
      }),
    );
    expect(kid?.stripeCustomerId).toBe("cus_test_kid_123");
    expect(kid?.stripeSubscriptionId).toBe("sub_test_kid_456");

    // And the parent's billing fields stay untouched.
    const parent = await withRlsBypass((tx) =>
      tx.member.findUnique({
        where: { id: parentAId },
        select: { stripeSubscriptionId: true },
      }),
    );
    expect(parent?.stripeSubscriptionId).toBeNull();
  });

  it("billing GET on own kid returns plans + payments shape", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await readBilling(getReq(`/api/member/family/${kidAId}/billing`), {
      params: Promise.resolve({ id: kidAId }),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant: { selfBillingEnabled: boolean; stripeConnected: boolean; currency: string };
      kid: { id: string; hasActiveSubscription: boolean };
      plans: unknown[];
      payments: unknown[];
    };
    expect(body.tenant.selfBillingEnabled).toBe(true);
    expect(body.tenant.stripeConnected).toBe(true);
    expect(body.kid.id).toBe(kidAId);
    expect(body.kid.hasActiveSubscription).toBe(true);
    expect(Array.isArray(body.plans)).toBe(true);
    expect(Array.isArray(body.payments)).toBe(true);
  });

  it("billing GET on cross-parent kid returns 404 (existence not disclosed)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await readBilling(getReq(`/api/member/family/${kidBId}/billing`), {
      params: Promise.resolve({ id: kidBId }),
    } as never);
    expect(res.status).toBe(404);
  });

  it("cancel-for-kid returns 200 + cancelAt for parent's own kid", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await cancelForKid(
      jsonReq("/api/member/subscriptions/cancel-for-kid", { kidMemberId: kidAId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.cancelAt).toBe("number");
  });

  it("cancel-for-kid on cross-parent kid returns 404", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId, role: "member", email: "pa" },
    } as never);
    const res = await cancelForKid(
      jsonReq("/api/member/subscriptions/cancel-for-kid", { kidMemberId: kidBId }),
    );
    expect(res.status).toBe(404);
  });
});
