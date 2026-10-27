// TeamUp bridge (readiness spec v3 §7): a member TeamUp bills is never given a
// second collection in MatFlow. Each of the three routes that start a card
// subscription refuses with 409 `billed_elsewhere` before any provider call.
// docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md §5.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import {
  BILLED_ELSEWHERE_REFUSAL,
  billingSourceLabel,
  importedFromTeamUpLabel,
} from "@/lib/billing-source";
import * as billingSource from "@/lib/billing-source";

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
  tier: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/stripe-account-status", () => ({ ensureCanAcceptCharges: async () => ({ ok: true }) }));
vi.mock("@/lib/stripe/subscriptions", () => ({ createSubscriptionForMember: m.create }));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findFirst: m.tenant, findUnique: m.tenant },
      member: { findFirst: m.member, findUnique: m.member },
      membershipTier: { findFirst: m.tier },
    }),
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: m.tenant, findUnique: m.tenant }, member: { findFirst: m.member } }),
}));

let adultPOST: (r: Request) => Promise<Response>;
let kidPOST: (r: Request) => Promise<Response>;
let staffPOST: (r: Request) => Promise<Response>;
beforeAll(async () => {
  ({ POST: adultPOST } = await import("@/app/api/member/subscriptions/start/route"));
  ({ POST: kidPOST } = await import("@/app/api/member/subscriptions/start-for-kid/route"));
  ({ POST: staffPOST } = await import("@/app/api/stripe/create-subscription/route"));
});
const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;

// Every member lookup answers with a TeamUp-billed member who otherwise
// qualifies (own family, no live subscription), so only the new guard can refuse.
const TEAMUP_MEMBER = {
  id: "mem_1", name: "Sam", email: "sam@example.test", tenantId: "t1",
  parentMemberId: "par_1", accountType: "kids", stripeCustomerId: null, stripeSubscriptionId: null,
  billedBy: "teamup",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.tenant.mockResolvedValue({
    id: "t1", name: "Club", stripeAccountId: "acct_1", stripeConnected: true, acceptsBacs: false,
    memberSelfBilling: true, stripeAccountStatus: null,
  });
  m.member.mockResolvedValue(TEAMUP_MEMBER);
  m.tier.mockResolvedValue({ id: "tier_1", isKids: true, name: "Kids", stripePriceId: "price_1" });
  m.create.mockResolvedValue({ ok: true, subscriptionId: "sub_new", clientSecret: "cs" });
});

describe("a card subscription for a member TeamUp bills is refused before any provider call", () => {
  it("member self-subscribe", async () => {
    m.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "mem_1", role: "member" } });
    const res = await adultPOST(req({ priceId: "price_1", requestId: "req_12345678" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: BILLED_ELSEWHERE_REFUSAL, reason: "billed_elsewhere" });
    expect(m.create).not.toHaveBeenCalled();
  });

  it("parent subscribing their child", async () => {
    m.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "par_1", role: "member" } });
    const res = await kidPOST(req({ kidMemberId: "mem_1", priceId: "price_1", requestId: "req_12345678" }));
    expect(res.status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("staff starting one from the desk", async () => {
    m.auth.mockResolvedValue({ user: { id: "u1", tenantId: "t1", role: "owner" } });
    const res = await staffPOST(req({ memberId: "mem_1", priceId: "price_1", requestId: "req_12345678" }));
    expect(res.status).toBe(409);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("a member MatFlow bills is not refused by this guard", async () => {
    m.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "mem_1", role: "member" } });
    m.member.mockResolvedValue({ ...TEAMUP_MEMBER, billedBy: "matflow", parentMemberId: null, accountType: "adult" });
    const res = await adultPOST(req({ priceId: "price_1", requestId: "req_12345678" }));
    expect(res.status).not.toBe(409);
  });
});

// Owner decision, 27 Oct 2026: imports no longer update an existing member,
// so the date never moves. "status as of <date>" became "Imported from TeamUp
// on <date>", and the 8-day staleness warning is gone.
describe("billing source labels", () => {
  it("labels only TeamUp-billed members, with the import date or 'date unknown'", () => {
    expect(billingSourceLabel({ billedBy: "matflow", billingStatusAsOf: new Date("2026-10-03T08:00:00Z") })).toBeNull();
    expect(billingSourceLabel({ billedBy: "teamup", billingStatusAsOf: new Date("2026-10-03T08:00:00Z") })).toBe(
      "Billed by TeamUp · Imported from TeamUp on 3 Oct 2026",
    );
    expect(billingSourceLabel({ billedBy: "teamup", billingStatusAsOf: null })).toBe("Billed by TeamUp · Imported from TeamUp, date unknown");
  });

  it("gives the import line on its own", () => {
    expect(importedFromTeamUpLabel({ billedBy: "teamup", billingStatusAsOf: "2026-09-20T09:00:00.000Z" })).toBe("Imported from TeamUp on 20 Sept 2026");
    expect(importedFromTeamUpLabel({ billedBy: "matflow", billingStatusAsOf: "2026-09-20T09:00:00.000Z" })).toBeNull();
  });

  it("has no staleness rule left: a months-old import reads the same as yesterday's", () => {
    const keys = Object.keys(billingSource);
    expect(keys).not.toContain("BILLING_STATUS_STALE_AFTER_DAYS");
    expect(keys).not.toContain("isBillingStatusStale");
    expect(keys).not.toContain("staleBillingWarning");
    expect(billingSourceLabel({ billedBy: "teamup", billingStatusAsOf: new Date("2026-01-03T08:00:00Z") })).toBe(
      "Billed by TeamUp · Imported from TeamUp on 3 Jan 2026",
    );
  });
});
