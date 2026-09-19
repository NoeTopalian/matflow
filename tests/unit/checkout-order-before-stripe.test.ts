// Money must never move before there is a row to account for it.
//
// The shop checkout used to create the Stripe Checkout session FIRST, then wrap
// the `Order` write in a try/catch that logged, swallowed, and returned the
// checkout URL anyway. A member could pay with no Order row, no Payment row and
// no receipt: money at Stripe, nothing anywhere in MatFlow.
//
// The swallow justified itself by claiming the webhook could reconstruct from
// metadata. It cannot — the shop branch is
// `order.updateMany({ where: { orderRef, status: "pending" } })` and mirrors a
// Payment only when `flipped.count > 0`. With no row to flip, the payment is
// invisible for ever.
//
// Writing the order first is free, because the webhook reconciles on `orderRef`
// (generated before the Stripe call and carried in the session metadata), not
// on the session id.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-error", () => ({
  apiError: (_req: unknown, status: number, message: string) => ({
    status,
    json: async () => ({ error: message }),
  }),
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        json: async () => body,
      }),
    },
  };
});

const { mockAuth, mockTenant, mockProducts, mockOrderCreate, mockOrderUpdate, mockSessionCreate, calls } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockTenant: vi.fn(),
    mockProducts: vi.fn(),
    mockOrderCreate: vi.fn(),
    mockOrderUpdate: vi.fn(),
    mockSessionCreate: vi.fn(),
    // Ordered log of what happened, so "before" can be asserted rather than assumed.
    calls: { value: [] as string[] },
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: async () => ({ ok: true }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: mockTenant },
      product: { findMany: mockProducts },
      order: { create: mockOrderCreate, updateMany: mockOrderUpdate },
    }),
}));
vi.mock("stripe", () => ({
  default: class {
    checkout = { sessions: { create: mockSessionCreate } };
  },
}));

type Route = typeof import("@/app/api/member/checkout/route");
let POST: Route["POST"];

beforeAll(async () => {
  ({ POST } = await import("@/app/api/member/checkout/route"));
});

function req() {
  return {
    json: async () => ({ items: [{ id: "prod_1", name: "Gi", price: 80, quantity: 1 }] }),
    headers: new Headers(),
    nextUrl: { origin: "https://matflow.studio" },
  } as unknown as Parameters<Route["POST"]>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.value = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_not_real";
  mockAuth.mockResolvedValue({ user: { tenantId: TENANT, memberId: "mem_1" } });
  mockTenant.mockResolvedValue({
    paymentRail: "stripe",
    // The online card rail is refused unless the owner lets members start card
    // payments themselves (the column defaults to false).
    memberSelfBilling: true,
    stripeAccountId: "acct_1",
    stripeConnected: true,
    stripeAccountStatus: null,
    currency: "GBP",
  });
  mockProducts.mockResolvedValue([{ id: "prod_1", pricePence: 8000, deletedAt: null }]);
  mockOrderCreate.mockImplementation(async () => {
    calls.value.push("order.create");
    return { id: "ord_1" };
  });
  mockOrderUpdate.mockImplementation(async () => {
    calls.value.push("order.update");
    return { count: 1 };
  });
  mockSessionCreate.mockImplementation(async () => {
    calls.value.push("stripe.session");
    return { id: "cs_test", url: "https://checkout.stripe.com/x" };
  });
});

describe("shop checkout — ordering", () => {
  it("writes the Order BEFORE calling Stripe", async () => {
    await POST(req());
    expect(calls.value.indexOf("order.create")).toBeGreaterThanOrEqual(0);
    expect(calls.value.indexOf("order.create")).toBeLessThan(calls.value.indexOf("stripe.session"));
  });

  it("REFUSES and never calls Stripe when the Order cannot be written", async () => {
    // The defect this whole file exists for: money used to move here anyway.
    mockOrderCreate.mockRejectedValue(new Error("db down"));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(mockSessionCreate).not.toHaveBeenCalled();
    expect(body.url).toBeUndefined();
  });

  it("does not depend on the session id for reconciliation", async () => {
    // The webhook matches on orderRef, so attaching the session id afterwards
    // is a convenience. A failure there must not fail the checkout.
    mockOrderUpdate.mockRejectedValue(new Error("update failed"));

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.com/x");
  });

  it("carries orderRef in the Stripe metadata, matching the row it wrote", async () => {
    await POST(req());

    const written = mockOrderCreate.mock.calls[0][0].data.orderRef;
    const metadata = mockSessionCreate.mock.calls[0][0].metadata;
    expect(metadata.orderRef).toBe(written);
    expect(metadata.matflowKind).toBe("shop_order");
    expect(metadata.tenantId).toBe(TENANT);
  });

  it("writes the order as pending so the webhook has something to flip", async () => {
    await POST(req());
    expect(mockOrderCreate.mock.calls[0][0].data.status).toBe("pending");
  });
});
