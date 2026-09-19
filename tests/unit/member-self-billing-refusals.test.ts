// `Tenant.memberSelfBilling` is the owner's switch for "members may spend money
// in this product". `member/subscriptions/start` reads it and refuses with a
// 403; the shop and the class-pack purchase never read it at all, so an owner
// who switched member purchasing off still had members placing pay-at-desk
// Order rows and opening pack checkouts.
//
// One switch, one refusal, everywhere money starts.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { PRODUCT_PRICE_MAP } from "@/lib/products";

vi.mock("next/server", () => {
  class FakeNextRequest {
    url: string;
    method: string;
    headers: Headers;
    private body: string;
    constructor(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
      this.url = url;
      this.method = init.method ?? "GET";
      this.headers = new Headers(init.headers ?? {});
      this.body = init.body ?? "";
    }
    get nextUrl() { return new URL(this.url); }
    async json() { return JSON.parse(this.body); }
  }
  return {
    NextRequest: FakeNextRequest,
    NextResponse: {
      json: (body: unknown, init?: { status?: number }) => ({
        status: init?.status ?? 200,
        json: async () => body,
      }),
    },
  };
});
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));
vi.mock("@/lib/stripe-account-status", () => ({
  ensureCanAcceptCharges: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { tenantId: "tenant-A", memberId: "mem-1", id: "user-1" } }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    product: { findMany: vi.fn() },
    order: { create: vi.fn() },
    member: { findFirst: vi.fn() },
    classPack: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";

const SELF_BILLING_OFF = "This gym manages payments centrally — please speak to staff";

const [DEMO_ID, DEMO_PRICE] = Object.entries(PRODUCT_PRICE_MAP)[0] as [string, number];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.STRIPE_SECRET_KEY;
  vi.mocked(prisma.product.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.order.create).mockResolvedValue({ id: "ord-1" } as never);
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: "mem-1", email: "m@example.test", name: "Member", stripeCustomerId: null,
  } as never);
  vi.mocked(prisma.classPack.findFirst).mockResolvedValue({
    id: "pack-1", tenantId: "tenant-A", stripePriceId: "price_x", name: "Ten pack",
  } as never);
});

function tenant(memberSelfBilling: boolean) {
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    memberSelfBilling,
    paymentRail: "pay_at_desk",
    stripeAccountId: "acct_test",
    stripeConnected: true,
    stripeAccountStatus: "active",
    currency: "GBP",
  } as never);
}

async function checkout() {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/member/checkout/route");
  const req = new NextRequest("http://localhost:3847/api/member/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3847" },
    body: JSON.stringify({
      items: [{ id: DEMO_ID, name: "Rash guard", price: DEMO_PRICE, quantity: 1 }],
    }),
  });
  return POST(req as never);
}

async function buyPack() {
  const { POST } = await import("@/app/api/member/class-packs/buy/route");
  const req = new Request("http://localhost:3847/api/member/class-packs/buy", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3847" },
    body: JSON.stringify({ packId: "pack-1" }),
  });
  return POST(req as never);
}

describe("member/checkout honours the owner's self-billing switch", () => {
  it("refuses with the same 403 the subscription route gives, and writes no Order", async () => {
    tenant(false);
    const res = await checkout();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe(SELF_BILLING_OFF);
    // The whole point: the owner turned purchasing off and no row appeared.
    expect(vi.mocked(prisma.order.create)).not.toHaveBeenCalled();
  });

  it("places the order as before when the switch is on", async () => {
    tenant(true);
    const res = await checkout();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mode).toBe("pay_at_desk");
    expect(vi.mocked(prisma.order.create)).toHaveBeenCalled();
  });
});

describe("member/class-packs/buy honours the owner's self-billing switch", () => {
  it("refuses with the same 403, and never says the pack is unavailable", async () => {
    tenant(false);
    const res = await buyPack();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe(SELF_BILLING_OFF);
    // "Pack unavailable" would tell the member their club's pack is broken when
    // in fact the club switched buying off.
    expect(body.error).not.toContain("unavailable");
  });

  it("gets past the switch when it is on", async () => {
    tenant(true);
    const res = await buyPack();
    const body = await res.json();
    // Stripe is unconfigured in this test, so the honest next refusal is 503 —
    // what matters is that the self-billing gate is no longer the one refusing.
    expect(res.status).not.toBe(403);
    expect(body.error).not.toBe(SELF_BILLING_OFF);
  });
});
