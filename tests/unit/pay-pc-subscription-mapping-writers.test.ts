import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Payments lane PC (11 Oct 2026): every place MatFlow creates, migrates or
// adopts a Stripe subscription writes the MemberSubscription mapping in the
// SAME transaction as the member's pointer, and the in-app create tags the
// subscription with MatFlow's metadata (the migration already did). Without the
// mapping the webhook cannot tell MatFlow's subscription from another
// platform's on the same customer.

const {
  customersCreateMock, subscriptionsCreateMock, subscriptionsListMock, stripeCtorMock,
  memberUpdateMock, memberUpdateManyMock, memberFindUniqueMock, mappingUpsertMock, txLog,
  tierUpdateManyMock, tierFindFirstMock, logAuditMock,
} = vi.hoisted(() => ({
  customersCreateMock: vi.fn(),
  subscriptionsCreateMock: vi.fn(),
  subscriptionsListMock: vi.fn(),
  stripeCtorMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  memberUpdateManyMock: vi.fn(),
  memberFindUniqueMock: vi.fn(),
  mappingUpsertMock: vi.fn(),
  tierUpdateManyMock: vi.fn(),
  tierFindFirstMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  txLog: [] as Array<{ tx: number; op: string }>,
}));

let txCounter = 0;
function makeTx(n: number) {
  return {
    member: {
      update: (a: unknown) => { txLog.push({ tx: n, op: "member.update" }); return memberUpdateMock(a); },
      updateMany: (a: unknown) => { txLog.push({ tx: n, op: "member.updateMany" }); return memberUpdateManyMock(a); },
      findUnique: memberFindUniqueMock,
    },
    memberSubscription: {
      upsert: (a: unknown) => { txLog.push({ tx: n, op: "memberSubscription.upsert" }); return mappingUpsertMock(a); },
    },
    membershipTier: { updateMany: tierUpdateManyMock, findFirst: tierFindFirstMock },
  };
}

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(makeTx(++txCounter))),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("stripe", () => ({ default: stripeCtorMock }));

import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";

const TENANT = { id: "tenant-A", stripeAccountId: "acct_gym", acceptsBacs: true };
const MEMBER = { id: "mem-1", email: "sam@gym.test", name: "Sam", stripeCustomerId: "cus_1" };
const SECRET = "pi_0000000000000000000000_secret_0000000000000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  txLog.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  stripeCtorMock.mockImplementation(function (this: Record<string, unknown>) {
    this.customers = { create: customersCreateMock };
    this.subscriptions = { create: subscriptionsCreateMock, list: subscriptionsListMock };
  });
  memberUpdateMock.mockResolvedValue({ id: MEMBER.id });
  mappingUpsertMock.mockImplementation(async (a: { create: { tenantId: string; memberId: string } }) => ({ id: "ms-1", tenantId: a.create.tenantId, memberId: a.create.memberId }));
  subscriptionsCreateMock.mockResolvedValue({
    id: "sub_new",
    status: "incomplete",
    items: { data: [{ current_period_end: 1893456000 }] },
    latest_invoice: { id: "in_1", confirmation_secret: { client_secret: SECRET } },
  });
});
afterEach(() => vi.restoreAllMocks());

function create() {
  return createSubscriptionForMember({ tenant: TENANT, member: MEMBER, priceId: "price_1", paymentMethodType: "card", requestId: "req_1" });
}

describe("in-app create (lib/stripe/subscriptions.ts)", () => {
  it("tags the Stripe subscription with MatFlow's tenant, member and source", async () => {
    await create();
    const [params] = subscriptionsCreateMock.mock.calls[0];
    expect(params.metadata).toEqual({ matflowTenantId: "tenant-A", matflowMemberId: "mem-1", matflowSource: "app" });
  });

  it("writes the mapping and the member pointer in ONE transaction, mapping first", async () => {
    const out = await create();
    expect(out.ok).toBe(true);
    expect(mappingUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripeSubscriptionId: "sub_new" },
      create: expect.objectContaining({
        tenantId: "tenant-A", memberId: "mem-1", stripeAccountId: "acct_gym",
        stripeSubscriptionId: "sub_new", source: "app", status: "incomplete",
        currentPeriodEnd: new Date(1893456000 * 1000),
      }),
      update: {},
    }));
    const ops = txLog.filter((l) => l.op === "memberSubscription.upsert" || l.op === "member.update");
    expect(ops.map((o) => o.op)).toEqual(["memberSubscription.upsert", "member.update"]);
    expect(new Set(ops.map((o) => o.tx)).size).toBe(1);
  });

  it("marks the member's payment pending until the first payment lands", async () => {
    await create();
    expect(memberUpdateMock).toHaveBeenCalledWith({
      where: { id: "mem-1" },
      data: { stripeSubscriptionId: "sub_new", preferredPaymentMethod: "card", paymentStatus: "pending" },
    });
  });

  it("refuses (and leaves the pointer alone) when the subscription is already mapped to another member", async () => {
    mappingUpsertMock.mockResolvedValue({ id: "ms-other", tenantId: "tenant-A", memberId: "mem-OTHER" });
    const out = await create();
    expect(out.ok).toBe(false);
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });

  it("writes no mapping when Stripe gives no confirmation secret (nothing is persisted, as before)", async () => {
    subscriptionsCreateMock.mockResolvedValue({ id: "sub_nosecret", status: "incomplete", latest_invoice: { id: "in_2", confirmation_secret: null } });
    const out = await create();
    expect(out.ok).toBe(false);
    expect(mappingUpsertMock).not.toHaveBeenCalled();
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });
});

describe("RP-2: the create keeps the tier and the prior payment state on the mapping, not on the member", () => {
  it("stores the tier of the price and the member's current paymentStatus; Member.membershipTierId is not written", async () => {
    memberFindUniqueMock.mockResolvedValue({ paymentStatus: "paid" });
    tierFindFirstMock.mockResolvedValue({ id: "tier-app" });
    const out = await create();
    expect(out.ok).toBe(true);
    // Round 5: only an ACTIVE tier for the price is ever recorded.
    expect(tierFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-A", stripePriceId: "price_1", isActive: true } }));
    expect(mappingUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ membershipTierId: "tier-app", priorPaymentStatus: "paid" }),
    }));
    const memberData = (memberUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(memberData).not.toHaveProperty("membershipTierId");
    expect(memberData).not.toHaveProperty("membershipType");
  });

  it("a price with no MatFlow tier stores a null tier (nothing to grant on payment)", async () => {
    memberFindUniqueMock.mockResolvedValue({ paymentStatus: "pending" });
    tierFindFirstMock.mockResolvedValue(null);
    await create();
    expect(mappingUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ membershipTierId: null, priorPaymentStatus: "pending" }),
    }));
  });
});

describe("RP-2 hand-over: the tier recorded is the caller's validated one, and never an inactive tier", () => {
  // Two tiers share one Stripe price: an old, inactive one listed FIRST, and the active one.
  const tiers = [
    { id: "tier-old", tenantId: "tenant-A", stripePriceId: "price_1", isActive: false },
    { id: "tier-new", tenantId: "tenant-A", stripePriceId: "price_1", isActive: true },
    { id: "tier-other-club", tenantId: "tenant-B", stripePriceId: "price_1", isActive: true },
  ];
  beforeEach(() => {
    memberFindUniqueMock.mockResolvedValue({ paymentStatus: "pending" });
    // Behaves like Postgres: every condition in `where` must hold.
    tierFindFirstMock.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      tiers.find((t) => Object.entries(a.where).every(([k, v]) => (t as Record<string, unknown>)[k] === v)) ?? null);
  });
  const recordedTier = () => (mappingUpsertMock.mock.calls[0][0] as { create: { membershipTierId: string | null } }).create.membershipTierId;

  it("no tier given: the ACTIVE tier for the price is recorded, never the inactive one listed first", async () => {
    await create();
    expect(tierFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-A", stripePriceId: "price_1", isActive: true } }));
    expect(recordedTier()).toBe("tier-new");
  });

  it("a valid tier given (this club, active, same price): that tier is recorded", async () => {
    await createSubscriptionForMember({ tenant: TENANT, member: MEMBER, priceId: "price_1", paymentMethodType: "card", requestId: "req_t1", membershipTierId: "tier-new" });
    expect(tierFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tier-new", tenantId: "tenant-A", isActive: true, stripePriceId: "price_1" } }));
    expect(recordedTier()).toBe("tier-new");
  });

  it("an INACTIVE tier given (even with the same price): nothing recorded, and no fallback to another tier", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await createSubscriptionForMember({ tenant: TENANT, member: MEMBER, priceId: "price_1", paymentMethodType: "card", requestId: "req_t2", membershipTierId: "tier-old" });
    expect(out.ok).toBe(true);
    expect(recordedTier()).toBeNull();
    expect(tierFindFirstMock).toHaveBeenCalledTimes(1);
  });

  it("another club's tier, or a tier for a different price, is not recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await createSubscriptionForMember({ tenant: TENANT, member: MEMBER, priceId: "price_1", paymentMethodType: "card", requestId: "req_t3", membershipTierId: "tier-other-club" });
    expect(recordedTier()).toBeNull();
    mappingUpsertMock.mockClear();
    await createSubscriptionForMember({ tenant: TENANT, member: MEMBER, priceId: "price_2", paymentMethodType: "card", requestId: "req_t4", membershipTierId: "tier-new" });
    expect(recordedTier()).toBeNull();
  });
});
