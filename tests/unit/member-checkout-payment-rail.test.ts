// POST /api/member/checkout — the club decides the rail, not the platform.
//
// The branch used to be `if (!process.env.STRIPE_SECRET_KEY)`, so how a gym
// took money was a property of MatFlow's deployment. A club that chose "Pay at
// desk only — members pay cash or card at reception, no online charges" in the
// onboarding wizard still got a Stripe checkout, because that choice persisted
// one unrelated BACS flag and nothing anywhere read a payment rail. It is also
// precisely the option a standing-order club picks.
//
// The first test is the one that matters: a pay-at-desk tenant must not reach
// Stripe EVEN WITH a secret key configured. The second guards the other half —
// a club that never answered must behave exactly as it did before, or this
// change would silently alter every existing gym.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";
const MEMBER = "mem_1";

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

const { mockAuth, mockTenantFindUnique, mockProductFindMany, mockOrderCreate, mockStripeCtor } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockTenantFindUnique: vi.fn(),
    mockProductFindMany: vi.fn(),
    mockOrderCreate: vi.fn(),
    mockStripeCtor: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: async () => ({ ok: true }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: mockTenantFindUnique },
      product: { findMany: mockProductFindMany },
      order: { create: mockOrderCreate },
    }),
}));

// A Stripe constructor that records any attempt to use it. The assertion this
// file exists for is that a pay-at-desk club NEVER gets here.
vi.mock("stripe", () => ({
  default: class {
    constructor(...args: unknown[]) {
      mockStripeCtor(...args);
    }
    checkout = {
      sessions: {
        create: async () => ({ id: "cs_test", url: "https://checkout.stripe.com/test" }),
      },
    };
  },
}));

type Route = typeof import("@/app/api/member/checkout/route");
let POST: Route["POST"];

beforeAll(async () => {
  ({ POST } = await import("@/app/api/member/checkout/route"));
});

function req(body: unknown) {
  return {
    json: async () => body,
    headers: new Headers(),
    nextUrl: { origin: "https://matflow.studio" },
  } as unknown as Parameters<Route["POST"]>[0];
}

const CART = {
  items: [{ id: "prod_1", name: "Gi", price: 80, quantity: 1 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
  mockAuth.mockResolvedValue({ user: { tenantId: TENANT, memberId: MEMBER } });
  mockProductFindMany.mockResolvedValue([{ id: "prod_1", pricePence: 8000, deletedAt: null }]);
  mockOrderCreate.mockResolvedValue({ id: "ord_1" });
});

describe("member checkout — the club's chosen rail decides", () => {
  it("a pay_at_desk club never reaches Stripe, even with a secret key configured", async () => {
    mockTenantFindUnique.mockResolvedValue({
      paymentRail: "pay_at_desk",
      stripeAccountId: "acct_live",
      stripeConnected: true,
      stripeAccountStatus: null,
      currency: "GBP",
    });

    const res = await POST(req(CART));
    const body = await res.json();

    expect(body.mode).toBe("pay_at_desk");
    // The whole point: a configured key and a connected account are NOT enough
    // to override the club's answer.
    expect(mockStripeCtor).not.toHaveBeenCalled();
    expect(mockOrderCreate).toHaveBeenCalledTimes(1);
  });

  it("a stripe-rail club with a key still goes to Stripe", async () => {
    mockTenantFindUnique.mockResolvedValue({
      paymentRail: "stripe",
      stripeAccountId: "acct_live",
      stripeConnected: true,
      stripeAccountStatus: null,
      currency: "GBP",
    });

    await POST(req(CART));
    expect(mockStripeCtor).toHaveBeenCalled();
  });

  it("a club that never chose behaves exactly as before — key present means Stripe", async () => {
    mockTenantFindUnique.mockResolvedValue({
      paymentRail: null,
      stripeAccountId: "acct_live",
      stripeConnected: true,
      stripeAccountStatus: null,
      currency: "GBP",
    });

    await POST(req(CART));
    expect(mockStripeCtor).toHaveBeenCalled();
  });

  it("a club that never chose, with no key, still falls to pay at desk", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    mockTenantFindUnique.mockResolvedValue({
      paymentRail: null,
      stripeAccountId: null,
      stripeConnected: false,
      stripeAccountStatus: null,
      currency: "GBP",
    });

    const res = await POST(req(CART));
    const body = await res.json();

    expect(body.mode).toBe("pay_at_desk");
    expect(mockStripeCtor).not.toHaveBeenCalled();
  });
});

describe("member checkout — a desk order that was not saved is not reported as placed", () => {
  it("refuses rather than inventing an order reference", async () => {
    mockTenantFindUnique.mockResolvedValue({
      paymentRail: "pay_at_desk",
      stripeAccountId: null,
      stripeConnected: false,
      stripeAccountStatus: null,
      currency: "GBP",
    });
    mockOrderCreate.mockRejectedValue(new Error("db down"));

    const res = await POST(req(CART));
    const body = await res.json();

    // The value of the reference is that staff can look it up. Handing one back
    // for a row that does not exist promises something the product cannot keep
    // to a member standing at the desk.
    expect(res.status).toBe(503);
    expect(body.orderRef).toBeUndefined();
    expect(body.mode).toBeUndefined();
  });
});
