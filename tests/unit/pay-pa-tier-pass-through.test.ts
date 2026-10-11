// Lane PA round 2 (11 Oct 2026) — review item RP-2 on the subscribe routes.
//
// The tier must follow the PAYMENT, not the click: no route may write
// Member.membershipTierId or membershipType before the first invoice is paid
// (lib/stripe/subscriptions.ts records the price's tier on the subscription
// mapping; the webhook grants it on payment). The staff route now accepts the
// drawer's `membershipTierId` and refuses a tier that is missing, inactive,
// from another club, or paired with a different tier's price; without the
// field it resolves the tier from the price as the member routes do.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLUB = "acct_pa_round2";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  tierFindFirst: vi.fn(),
  memberRow: {} as Record<string, unknown>,
  memberWrites: [] as unknown[],
  create: vi.fn(),
  retrieve: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ ok: false, error: message }) }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/stripe/subscriptions", () => ({ createSubscriptionForMember: m.create }));
vi.mock("stripe", () => ({ default: class { accounts = { retrieve: (...a: unknown[]) => m.retrieve(...a) }; } }));
vi.mock("@/lib/prisma-tenant", () => {
  const write = (kind: string) => vi.fn(async (a: unknown) => { m.memberWrites.push({ kind, a }); return kind === "updateMany" ? { count: 1 } : {}; });
  const tx = () => ({
    $executeRaw: vi.fn(async () => 0),
    tenant: {
      findUnique: vi.fn(async () => ({
        stripeAccountId: CLUB, stripeConnected: true, acceptsBacs: false, memberSelfBilling: true,
        stripeAccountStatus: { chargesEnabled: true, payoutsEnabled: true, requirementsPastDue: [], disabledReason: null, refreshedAt: new Date().toISOString() },
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    member: {
      findFirst: vi.fn(async () => ({ ...m.memberRow })),
      findUnique: vi.fn(async () => ({ ...m.memberRow })),
      update: write("update"),
      updateMany: write("updateMany"),
    },
    membershipTier: { findFirst: m.tierFindFirst },
  });
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
  };
});

type H = (r: Request) => Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
let staffPOST: H;
let startPOST: H;
let kidPOST: H;
beforeAll(async () => {
  staffPOST = (await import("@/app/api/stripe/create-subscription/route")).POST as unknown as H;
  startPOST = (await import("@/app/api/member/subscriptions/start/route")).POST as unknown as H;
  kidPOST = (await import("@/app/api/member/subscriptions/start-for-kid/route")).POST as unknown as H;
});

const req = (body: unknown) => ({ json: async () => body, headers: new Headers(), url: "https://club.test/x" }) as unknown as Request;
const staffBody = (extra: Record<string, unknown> = {}) => ({ memberId: "mem_1", priceId: "price_adult", requestId: "req_12345678", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  m.memberWrites.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_pa_round2_fixture";
  m.auth.mockResolvedValue({ user: { id: "u1", tenantId: "t1", memberId: "mem_1", role: "owner" } });
  m.memberRow = {
    id: "mem_1", tenantId: "t1", name: "Sam", email: "sam@example.test", stripeCustomerId: "cus_1",
    stripeSubscriptionId: null, parentMemberId: null, billedBy: "matflow", accountType: "junior",
  };
  m.tierFindFirst.mockResolvedValue({ id: "tier_adult", isKids: false, name: "Adult", stripePriceId: "price_adult" });
  m.create.mockResolvedValue({ ok: true, subscriptionId: "sub_new", clientSecret: "pi_x_secret_y", customerId: "cus_1" });
});

describe("staff subscribe — membershipTierId (RP-2)", () => {
  it("looks the named tier up inside the club, active only, and passes the price through on the club account", async () => {
    const res = await staffPOST(req(staffBody({ membershipTierId: "tier_adult" })));
    expect(res.status).toBe(200);
    expect(m.tierFindFirst).toHaveBeenCalledWith({
      where: { id: "tier_adult", tenantId: "t1", isActive: true },
      select: { id: true, stripePriceId: true },
    });
    expect(m.create).toHaveBeenCalledTimes(1);
    const input = m.create.mock.calls[0][0] as { priceId: string; tenant: { stripeAccountId: string } };
    expect(input.priceId).toBe("price_adult");
    expect(input.tenant.stripeAccountId).toBe(CLUB);
  });

  it("refuses 400 when the named tier does not exist in this club (or is inactive) — nothing reaches Stripe", async () => {
    m.tierFindFirst.mockResolvedValue(null);
    const res = await staffPOST(req(staffBody({ membershipTierId: "tier_other_club" })));
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("refuses 400 when the named tier's price is not the price sent (one tier paired with another's price)", async () => {
    m.tierFindFirst.mockResolvedValue({ id: "tier_kids", stripePriceId: "price_kids" });
    const res = await staffPOST(req(staffBody({ membershipTierId: "tier_kids" })));
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("refuses 400 when the named tier has no price at all", async () => {
    m.tierFindFirst.mockResolvedValue({ id: "tier_unpriced", stripePriceId: null });
    const res = await staffPOST(req(staffBody({ membershipTierId: "tier_unpriced" })));
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("without the field (older client) resolves the tier from the price, active and in this club", async () => {
    const res = await staffPOST(req(staffBody()));
    expect(res.status).toBe(200);
    expect(m.tierFindFirst).toHaveBeenCalledWith({
      where: { stripePriceId: "price_adult", tenantId: "t1", isActive: true },
      select: { id: true, stripePriceId: true },
    });
    expect((m.create.mock.calls[0][0] as { priceId: string }).priceId).toBe("price_adult");
  });

  it("without the field, a price that is no active tier's price is refused 400", async () => {
    m.tierFindFirst.mockResolvedValue(null);
    const res = await staffPOST(req(staffBody()));
    expect(res.status).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed membershipTierId (empty or over 50 characters) as invalid data", async () => {
    for (const bad of ["", "x".repeat(51)]) {
      const res = await staffPOST(req(staffBody({ membershipTierId: bad })));
      expect(res.status).toBe(400);
    }
    expect(m.tierFindFirst).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe("member routes — the tier travels as its price; bodies unchanged", () => {
  it("self-subscribe passes the resolved tier's price on the club account", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1", tenantId: "t1", memberId: "mem_1", role: "member" } });
    const res = await startPOST(req({ priceId: "price_adult", requestId: "req_12345678" }));
    expect(res.status).toBe(201);
    const input = m.create.mock.calls[0][0] as { priceId: string; tenant: { stripeAccountId: string } };
    expect(input.priceId).toBe("price_adult");
    expect(input.tenant.stripeAccountId).toBe(CLUB);
  });

  it("guardian subscribe passes the resolved kids tier's price on the club account", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1", tenantId: "t1", memberId: "par_1", role: "member" } });
    m.tierFindFirst.mockResolvedValue({ id: "tier_kids", isKids: true, name: "Kids", stripePriceId: "price_kids" });
    const res = await kidPOST(req({ kidMemberId: "mem_1", priceId: "price_kids", requestId: "req_12345678" }));
    expect(res.status).toBe(201);
    expect((m.create.mock.calls[0][0] as { priceId: string }).priceId).toBe("price_kids");
  });
});

describe("no route writes the tier before payment (RP-2)", () => {
  it("none of the three subscribe routes writes Member.membershipTierId or membershipType while starting a subscription", async () => {
    await staffPOST(req(staffBody({ membershipTierId: "tier_adult" })));
    m.auth.mockResolvedValue({ user: { id: "u1", tenantId: "t1", memberId: "mem_1", role: "member" } });
    await startPOST(req({ priceId: "price_adult", requestId: "req_12345678" }));
    m.tierFindFirst.mockResolvedValue({ id: "tier_kids", isKids: true, name: "Kids", stripePriceId: "price_kids" });
    await kidPOST(req({ kidMemberId: "mem_1", priceId: "price_kids", requestId: "req_12345678" }));
    expect(m.create).toHaveBeenCalledTimes(3);
    for (const w of m.memberWrites) expect(JSON.stringify(w)).not.toMatch(/membershipTierId|membershipType/);
    // And the helper is never handed a tier to WRITE. Since the RP-2 hand-over (lane PA request, done by lane
    // PC round 5) each route passes the id of the tier it validated, which the helper records on the
    // subscription mapping only; never a label, and never anything else.
    const passed = m.create.mock.calls.map(([input]) => (input as { membershipTierId?: unknown }).membershipTierId);
    expect(passed).toEqual(["tier_adult", expect.any(String), "tier_kids"]);
    for (const [input] of m.create.mock.calls) expect(JSON.stringify(input)).not.toMatch(/membershipType/);
  });

  it("source check: no lane-PA route assigns membershipTierId or membershipType in a write", () => {
    const files = [
      "app/api/member/checkout/route.ts", "app/api/member/class-packs/buy/route.ts", "app/api/members/[id]/charge/route.ts",
      "app/api/payments/[id]/refund/route.ts", "app/api/stripe/portal/route.ts", "app/api/member/family/[id]/billing/portal/route.ts",
      "app/api/stripe/create-subscription/route.ts", "app/api/member/subscriptions/start/route.ts",
      "app/api/member/subscriptions/start-for-kid/route.ts", "app/api/stripe/subscription-plans/route.ts", "app/api/class-packs/route.ts",
      "app/api/members/[id]/hold/route.ts", "app/api/members/[id]/resume/route.ts", "app/api/member/subscriptions/cancel/route.ts",
      "app/api/member/subscriptions/cancel-for-kid/route.ts", "app/api/stripe/disconnect/route.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      // A `data: { … membershipTierId/membershipType … }` write, or a bare `membershipType:` assignment.
      expect(src, f).not.toMatch(/data:\s*\{[^}]*membership(TierId|Type)/);
      expect(src, f).not.toMatch(/membershipType\s*:/);
      // The only membershipTierId allowed outside create-subscription is the pass-through of the validated
      // tier to createSubscriptionForMember (RP-2 hand-over), which records it on the mapping, not the member.
      if (!f.endsWith("stripe/create-subscription/route.ts")) {
        expect(src.replace(/^[ \t]*membershipTierId: tier\.id,\r?$/m, ""), f).not.toMatch(/membershipTierId/);
      }
    }
  });
});
