// A club's money must be denominated in that club's currency.
//
// `Tenant.currency` exists and is CHECK-constrained to GBP|EUR|USD. The member
// checkout reads it correctly and carries the comment "EUR/USD gyms were
// charging members in the wrong currency" — so this bug was found, understood
// and fixed on ONE path, and left standing on two others:
//
//  * app/api/class-packs — sets the currency on the Stripe PRICE, so a EUR
//    club's pack charged EVERY future buyer in GBP, not one bad order;
//  * app/api/payments/manual — logged a EUR club's cash takings in sterling,
//    silently mixing currencies in every revenue total.
//
// Both took the value from an optional client field defaulting to "GBP" and
// never consulted the club.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_eur";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  mockGate, mockAuth, mockTenant, mockMember,
  mockPaymentCreate, mockMemberUpdate, mockAudit, mockRateLimit,
  mockPackCreate, mockPriceCreate, mockProductCreate,
} = vi.hoisted(() => ({
  mockGate: vi.fn(), mockAuth: vi.fn(), mockTenant: vi.fn(), mockMember: vi.fn(),
  mockPaymentCreate: vi.fn(), mockMemberUpdate: vi.fn(), mockAudit: vi.fn(), mockRateLimit: vi.fn(),
  mockPackCreate: vi.fn(), mockPriceCreate: vi.fn(), mockProductCreate: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: mockGate,
  requireApiOwner: mockGate,
  requireApiStaff: mockGate,
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockAudit }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "1.1.1.1" }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: mockTenant, findFirst: mockTenant },
      member: { findFirst: mockMember, update: mockMemberUpdate },
      payment: { create: mockPaymentCreate },
      classPack: { create: mockPackCreate },
    }),
}));
vi.mock("stripe", () => ({
  default: class {
    products = { create: mockProductCreate };
    prices = { create: mockPriceCreate };
  },
}));

type ManualRoute = typeof import("@/app/api/payments/manual/route");
type PackRoute = typeof import("@/app/api/class-packs/route");
let manualPOST: ManualRoute["POST"];
let packPOST: PackRoute["POST"];

beforeAll(async () => {
  ({ POST: manualPOST } = await import("@/app/api/payments/manual/route"));
  ({ POST: packPOST } = await import("@/app/api/class-packs/route"));
});

function req(body: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_not_real";
  mockGate.mockResolvedValue({ ok: true, tenantId: TENANT, userId: "u1", role: "owner" });
  mockAuth.mockResolvedValue({ user: { tenantId: TENANT, id: "u1", role: "owner" } });
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockAudit.mockResolvedValue(undefined);
  // A euro club.
  mockTenant.mockResolvedValue({
    currency: "EUR",
    stripeAccountId: "acct_1",
    stripeConnected: true,
  });
  mockMember.mockResolvedValue({
    id: "mem_1", name: "Sam", nextDueAt: null, membershipTier: null,
  });
  mockPaymentCreate.mockResolvedValue({ id: "pay_1" });
  mockMemberUpdate.mockResolvedValue({});
  mockProductCreate.mockResolvedValue({ id: "prod_1" });
  mockPriceCreate.mockResolvedValue({ id: "price_1" });
  mockPackCreate.mockResolvedValue({ id: "pack_1" });
});

describe("manual payment — a EUR club's cash is not logged in sterling", () => {
  it("uses the club's currency when the client sends none", async () => {
    await manualPOST(req({ memberId: "mem_1", amountPence: 4000, method: "cash" }));
    expect(mockPaymentCreate.mock.calls[0][0].data.currency).toBe("EUR");
  });

  it("still honours an explicit client currency", async () => {
    await manualPOST(req({ memberId: "mem_1", amountPence: 4000, method: "cash", currency: "usd" }));
    expect(mockPaymentCreate.mock.calls[0][0].data.currency).toBe("USD");
  });
});

describe("class pack — the STRIPE PRICE carries the club's currency", () => {
  const body = {
    name: "10 Class Pack", totalCredits: 10, validityDays: 90, pricePence: 10000,
  };

  it("creates the Stripe price in the club's currency, not GBP", async () => {
    await packPOST(req(body));
    // This is the one that matters: the currency lives on the PRICE, so every
    // future buyer of this pack inherits it.
    expect(mockPriceCreate.mock.calls[0][0].currency).toBe("eur");
  });

  it("stores the local row in the same currency as the Stripe price", async () => {
    await packPOST(req(body));
    expect(mockPackCreate.mock.calls[0][0].data.currency).toBe("EUR");
    expect(mockPriceCreate.mock.calls[0][0].currency.toUpperCase()).toBe(
      mockPackCreate.mock.calls[0][0].data.currency,
    );
  });

  it("still honours an explicit client currency", async () => {
    await packPOST(req({ ...body, currency: "usd" }));
    expect(mockPriceCreate.mock.calls[0][0].currency).toBe("usd");
  });

  it("falls back to GBP only when the club has no currency set", async () => {
    mockTenant.mockResolvedValue({ currency: null, stripeAccountId: "acct_1", stripeConnected: true });
    await packPOST(req(body));
    expect(mockPriceCreate.mock.calls[0][0].currency).toBe("gbp");
  });
});
