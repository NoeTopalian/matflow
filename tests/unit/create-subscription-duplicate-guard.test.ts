import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * C1 review, H2 — the duplicate-subscription guard must live on the server.
 *
 * The drawer also hides the button for a member who already has a
 * subscription, but that check reads an SSR snapshot taken when the page
 * rendered. Two staff at the desk, or one owner with two tabs, both see
 * "no subscription". Each picks a different tier, so the price differs, so
 * Stripe's idempotency key differs, and two live subscriptions are created.
 * `Member.stripeSubscriptionId` keeps whichever wrote last, leaving the other
 * billing on with nothing in MatFlow pointing at it — uncancellable from any
 * screen in the product.
 *
 * These fail if the guard is removed, or moved back to the client, or if the
 * member select stops loading `stripeSubscriptionId` (which would make the
 * guard silently unevaluable).
 */

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { mockTenantFindUnique, mockMemberFindFirst, mockCreateSubscription } = vi.hoisted(() => ({
  mockTenantFindUnique: vi.fn(),
  mockMemberFindFirst: vi.fn(),
  mockCreateSubscription: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: mockTenantFindUnique },
    member: { findFirst: mockMemberFindFirst },
  },
}));

vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: async () => ({ ok: true }),
}));

vi.mock("@/lib/stripe/subscriptions", () => ({
  createSubscriptionForMember: mockCreateSubscription,
}));

import { auth } from "@/auth";
import { POST } from "@/app/api/stripe/create-subscription/route";

const mockAuth = vi.mocked(auth);

function makeReq() {
  return new Request("http://localhost/api/stripe/create-subscription", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `requestId` is now required: it becomes the Stripe idempotency key, and
    // the route refuses without one rather than proceeding unprotected.
    body: JSON.stringify({
      memberId: "mem_1",
      priceId: "price_adult",
      requestId: "req_test_fixture_1",
    }),
  });
}

describe("POST /api/stripe/create-subscription — duplicate guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "t_1" } } as any);
    mockTenantFindUnique.mockResolvedValue({
      stripeAccountId: "acct_1",
      stripeConnected: true,
      acceptsBacs: false,
      stripeAccountStatus: null,
    });
    mockCreateSubscription.mockResolvedValue({ ok: true, subscriptionId: "sub_new", clientSecret: "pi_x" });
  });

  it("refuses a second subscription for a member who already has one", async () => {
    mockMemberFindFirst.mockResolvedValue({
      id: "mem_1",
      email: "sam@example.com",
      name: "Sam Carter",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_existing",
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(409);
    // The decisive assertion: Stripe was never asked to create anything.
    expect(mockCreateSubscription).not.toHaveBeenCalled();
  });

  it("proceeds when the member has no subscription", async () => {
    mockMemberFindFirst.mockResolvedValue({
      id: "mem_1",
      email: "sam@example.com",
      name: "Sam Carter",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
    });

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(mockCreateSubscription).toHaveBeenCalledTimes(1);
  });

  it("loads stripeSubscriptionId, so the guard can never be silently unevaluable", async () => {
    mockMemberFindFirst.mockResolvedValue({
      id: "mem_1",
      email: "sam@example.com",
      name: "Sam Carter",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
    });

    await POST(makeReq());

    const select = mockMemberFindFirst.mock.calls[0][0].select;
    expect(select.stripeSubscriptionId).toBe(true);
  });
});
