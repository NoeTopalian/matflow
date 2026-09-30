// Connection register gap 24 (30 Sep 2026): three routes take a card payment —
// the member shop's card path, a class-pack purchase and the staff "charge the
// card on file" — and none honoured review mode, and nothing stopped a second
// collection channel for a member TeamUp bills (readiness spec v3 §7).
// These drive the real guards (not mocked) and assert no provider call.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }),
}));

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  tenant: vi.fn(),
  member: vi.fn(),
  pack: vi.fn(),
  accept: vi.fn(),
  stripeCtor: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({ ok: true, tenantId: "t1", userId: "u1" }),
  requireApiOwnerOrManager: async () => ({ ok: true, tenantId: "t1", userId: "u1" }),
}));
vi.mock("@/lib/stripe-account-status", () => ({ ensureCanAcceptCharges: m.accept }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("stripe", () => ({ default: m.stripeCtor }));
vi.mock("@/lib/prisma-tenant", () => {
  const tx = () => ({
    tenant: { findUnique: m.tenant, findFirst: m.tenant },
    member: { findFirst: m.member, findUnique: m.member },
    classPack: { findFirst: m.pack },
  });
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
  };
});

let packPOST: (r: Request) => Promise<Response>;
let chargePOST: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
beforeAll(async () => {
  ({ POST: packPOST } = await import("@/app/api/member/class-packs/buy/route"));
  ({ POST: chargePOST } = await import("@/app/api/members/[id]/charge/route"));
});
const req = (body: unknown) => ({ json: async () => body, headers: new Headers(), url: "http://localhost/x" }) as unknown as Request;

const TENANT = {
  id: "t1", name: "Club", stripeAccountId: "acct_1", stripeConnected: true, stripeAccountStatus: null,
  memberSelfBilling: true, reviewLockedAt: null, reviewSnapshotAt: null, reviewNote: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  m.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "mem_1", role: "member" } });
  m.tenant.mockResolvedValue(TENANT);
  m.member.mockResolvedValue({ id: "mem_1", email: "sam@example.test", name: "Sam", stripeCustomerId: "cus_1", billedBy: "matflow" });
  m.pack.mockResolvedValue({ id: "pack_1", name: "10 classes", stripePriceId: "price_1", isActive: true });
  m.accept.mockResolvedValue({ ok: true });
});

describe("class-pack purchase", () => {
  it("refuses a member TeamUp bills before any provider check", async () => {
    m.member.mockResolvedValue({ id: "mem_1", email: "sam@example.test", name: "Sam", stripeCustomerId: "cus_1", billedBy: "teamup" });
    const res = await packPOST(req({ packId: "pack_1" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason: string }).reason).toBe("billed_elsewhere");
    expect(m.accept).not.toHaveBeenCalled();
    expect(m.stripeCtor).not.toHaveBeenCalled();
  });

  it("refuses while the club is in review", async () => {
    m.tenant.mockResolvedValue({ ...TENANT, reviewLockedAt: new Date("2026-10-01T00:00:00Z") });
    const res = await packPOST(req({ packId: "pack_1" }));
    expect(res.status).toBe(423);
    expect(m.accept).not.toHaveBeenCalled();
  });
});

describe("staff charging the card on file", () => {
  const ctx = { params: Promise.resolve({ id: "mem_1" }) };

  it("refuses a member TeamUp bills before any provider call", async () => {
    m.member.mockResolvedValue({ id: "mem_1", billedBy: "teamup" });
    const res = await chargePOST(req({ amountPence: 4000, description: "Mat fee", requestId: "req_12345678" }), ctx);
    expect(res.status).toBe(409);
    expect(m.stripeCtor).not.toHaveBeenCalled();
  });

  it("refuses while the club is in review", async () => {
    m.tenant.mockResolvedValue({ ...TENANT, reviewLockedAt: new Date("2026-10-01T00:00:00Z") });
    const res = await chargePOST(req({ amountPence: 4000, description: "Mat fee", requestId: "req_12345678" }), ctx);
    expect(res.status).toBe(423);
    expect(m.stripeCtor).not.toHaveBeenCalled();
  });
});
