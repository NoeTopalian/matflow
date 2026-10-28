// Packs per product (owner decision, 27 Oct 2026): "the club chooses an expiry
// or no expiry per new pack product ... Later product edits must not silently
// rewrite sold entitlements."
//
// POST /api/class-packs stores the owner's choice as validityDays: a positive
// whole number of days (1 to 3650), or null for "Never expires". The choice is
// required, so a pack product is never created with an unstated term.
// The Stripe product's default description follows the choice.
//
// PATCH /api/class-packs/[id] edits name, description and the on-sale switch
// only. The validity is fixed at creation, like credits and price, so a
// validityDays in an edit is ignored. Neither PATCH nor DELETE touches any
// sold MemberClassPack.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_validity";

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
  mockGate, mockAudit, mockTenant,
  mockPackCreate, mockPackUpdateMany, mockPackFindFirst,
  mockPriceCreate, mockProductCreate, mockProductUpdate, memberPackSpy,
} = vi.hoisted(() => ({
  mockGate: vi.fn(), mockAudit: vi.fn(), mockTenant: vi.fn(),
  mockPackCreate: vi.fn(), mockPackUpdateMany: vi.fn(), mockPackFindFirst: vi.fn(),
  mockPriceCreate: vi.fn(), mockProductCreate: vi.fn(), mockProductUpdate: vi.fn(),
  memberPackSpy: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: mockGate,
  requireApiOwner: mockGate,
  requireApiStaff: mockGate,
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockAudit }));
// Any MemberClassPack method an edit could reach records the call.
const memberClassPack = new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => memberPackSpy(String(prop), ...args) });
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: mockTenant },
      classPack: { create: mockPackCreate, updateMany: mockPackUpdateMany, findFirst: mockPackFindFirst },
      memberClassPack,
    }),
}));
vi.mock("stripe", () => ({
  default: class {
    products = { create: mockProductCreate, update: mockProductUpdate };
    prices = { create: mockPriceCreate };
  },
}));

type PackRoute = typeof import("@/app/api/class-packs/route");
type PackIdRoute = typeof import("@/app/api/class-packs/[id]/route");
let packPOST: PackRoute["POST"];
let packPATCH: PackIdRoute["PATCH"];
let packDELETE: PackIdRoute["DELETE"];

beforeAll(async () => {
  ({ POST: packPOST } = await import("@/app/api/class-packs/route"));
  ({ PATCH: packPATCH, DELETE: packDELETE } = await import("@/app/api/class-packs/[id]/route"));
});

function req(body?: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}
const params = { params: Promise.resolve({ id: "pack_1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_not_real";
  mockGate.mockResolvedValue({ ok: true, tenantId: TENANT, userId: "u1", role: "owner" });
  mockAudit.mockResolvedValue(undefined);
  mockTenant.mockResolvedValue({ currency: "GBP", stripeAccountId: "acct_1", stripeConnected: true });
  mockProductCreate.mockResolvedValue({ id: "prod_1" });
  mockPriceCreate.mockResolvedValue({ id: "price_1" });
  mockPackCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "pack_1", ...data }));
  mockPackUpdateMany.mockResolvedValue({ count: 1 });
  mockPackFindFirst.mockResolvedValue({ id: "pack_1", name: "Ten", validityDays: 90 });
});

const BASE = { name: "10 Class Pack", totalCredits: 10, pricePence: 10000 };

describe("POST /api/class-packs — the owner chooses the validity per product", () => {
  it("\"Never expires\": validityDays null is stored as null", async () => {
    const res = await packPOST(req({ ...BASE, validityDays: null }));
    expect(res.status).toBe(201);
    expect(mockPackCreate.mock.calls[0][0].data).toMatchObject({ validityDays: null, totalCredits: 10 });
  });

  it("\"Expires N days after purchase\": a whole number of days is stored", async () => {
    const res = await packPOST(req({ ...BASE, validityDays: 90 }));
    expect(res.status).toBe(201);
    expect(mockPackCreate.mock.calls[0][0].data).toMatchObject({ validityDays: 90 });
  });

  it.each([[0], [-5], [3651], [1.5], ["90"]])("refuses validityDays %j (null, or 1 to 3650 whole days)", async (validityDays) => {
    const res = await packPOST(req({ ...BASE, validityDays }));
    expect(res.status).toBe(400);
    expect(mockPackCreate).not.toHaveBeenCalled();
    expect(mockProductCreate).not.toHaveBeenCalled();
  });

  it("refuses a product with no validity choice at all", async () => {
    const res = await packPOST(req(BASE));
    expect(res.status).toBe(400);
    expect(mockPackCreate).not.toHaveBeenCalled();
  });

  it("the edges 1 and 3650 days are accepted", async () => {
    expect((await packPOST(req({ ...BASE, validityDays: 1 }))).status).toBe(201);
    expect((await packPOST(req({ ...BASE, validityDays: 3650 }))).status).toBe(201);
  });
});

describe("POST /api/class-packs — the Stripe product's default description follows the terms", () => {
  it("a dated product keeps the existing default", async () => {
    await packPOST(req({ ...BASE, validityDays: 90 }));
    expect(mockProductCreate.mock.calls[0][0].description).toBe("10 classes valid for 90 days");
  });

  it("a no-expiry product reads \"N classes · no expiry\", never \"valid for null days\"", async () => {
    await packPOST(req({ ...BASE, validityDays: null }));
    expect(mockProductCreate.mock.calls[0][0].description).toBe("10 classes · no expiry");
  });

  it("the owner's own description is used as given", async () => {
    await packPOST(req({ ...BASE, validityDays: null, description: "Drop-in bundle" }));
    expect(mockProductCreate.mock.calls[0][0].description).toBe("Drop-in bundle");
  });
});

describe("PATCH and DELETE /api/class-packs/[id] — editing a product never rewrites a sold pack", () => {
  it("an edit that sends validityDays changes only name/description/on-sale; the validity is not edited", async () => {
    const res = await packPATCH(req({ name: "Ten (renamed)", validityDays: null }), params);
    expect(res.status).toBe(200);
    const data = mockPackUpdateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toEqual({ name: "Ten (renamed)" });
    expect(mockPackUpdateMany.mock.calls[0][0].where).toEqual({ id: "pack_1", tenantId: TENANT });
  });

  it("no edit reaches MemberClassPack, and no edit re-sends anything to Stripe", async () => {
    await packPATCH(req({ name: "Renamed", description: "New words", isActive: false, validityDays: 30 }), params);
    await packDELETE(req(), params);
    expect(memberPackSpy).not.toHaveBeenCalled();
    expect(mockProductUpdate).not.toHaveBeenCalled();
    expect(mockProductCreate).not.toHaveBeenCalled();
  });
});
