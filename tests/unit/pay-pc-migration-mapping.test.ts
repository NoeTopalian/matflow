import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Payments lane PC (11 Oct 2026): the TeamUp migration (lib/stripe/migrate-memberships.ts)
// writes the MemberSubscription mapping in the SAME transaction that links the
// member — source "migration" for a replace/create, "adopted" for an adopt —
// so the webhook can tell MatFlow's replacement from TeamUp's subscription on
// the same customer. No other behaviour of the migration changes.

const m = vi.hoisted(() => ({
  customersList: vi.fn(),
  listPaymentMethods: vi.fn(),
  paymentMethodsRetrieve: vi.fn(),
  subscriptionsList: vi.fn(),
  subscriptionsCreate: vi.fn(),
  productsCreate: vi.fn(),
  pricesCreate: vi.fn(),
  tenantFindUnique: vi.fn(),
  tierFindMany: vi.fn(),
  tierUpdate: vi.fn(),
  tierUpdateMany: vi.fn(),
  memberFindMany: vi.fn(),
  memberUpdateMany: vi.fn(),
  mappingUpsert: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
  ops: [] as Array<{ tx: number; op: string }>,
}));

let txN = 0;
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => {
    const n = ++txN;
    return Promise.resolve(fn({
      tenant: { findUnique: m.tenantFindUnique },
      membershipTier: { findMany: m.tierFindMany, update: m.tierUpdate, updateMany: m.tierUpdateMany },
      member: {
        findMany: m.memberFindMany,
        updateMany: (a: unknown) => { m.ops.push({ tx: n, op: "member.updateMany" }); return m.memberUpdateMany(a); },
      },
      memberSubscription: {
        upsert: (a: unknown) => { m.ops.push({ tx: n, op: "memberSubscription.upsert" }); return m.mappingUpsert(a); },
      },
    }));
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: m.logAudit }));

import { applyMigration } from "@/lib/stripe/migrate-memberships";
import type Stripe from "stripe";

const stripe = {
  customers: { list: m.customersList, listPaymentMethods: m.listPaymentMethods },
  paymentMethods: { retrieve: m.paymentMethodsRetrieve },
  subscriptions: { list: m.subscriptionsList, create: m.subscriptionsCreate },
  products: { create: m.productsCreate },
  prices: { create: m.pricesCreate },
} as unknown as Stripe;

const NOW = new Date("2026-09-24T09:00:00Z");
const PERIOD_END = new Date("2026-10-08T00:00:00Z");
const TENANT = { id: "tenant-A", stripeAccountId: "acct_gym", stripeConnected: true, acceptsBacs: false, currency: "GBP" };
const TIER = {
  id: "tier_m", name: "Adult Monthly", pricePence: 6500, currency: "GBP", billingCycle: "monthly",
  stripePriceId: "price_monthly_65", stripeProductId: "prod_m", isActive: true,
};
const CARD = { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } };
const MEMBER = {
  id: "mem_1", name: "Sam Fighter", email: "sam@gym.test", status: "active", paymentStatus: "paid",
  stripeCustomerId: null, stripeSubscriptionId: null, membershipTierId: null, nextDueAt: null,
};
function liveSub(status = "active") {
  return {
    id: "sub_teamup", status, default_payment_method: null, metadata: {},
    items: { data: [{ current_period_end: Math.floor(PERIOD_END.getTime() / 1000), price: { id: "price_monthly_65", unit_amount: 6500, currency: "gbp", recurring: { interval: "month", interval_count: 1 } } }] },
  };
}
function customer(sub: unknown, defaultPm: unknown) {
  return { id: "cus_sam", email: "sam@gym.test", created: 1_700_000_000, subscriptions: { data: [sub] }, invoice_settings: { default_payment_method: defaultPm } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  m.ops.length = 0;
  m.tenantFindUnique.mockResolvedValue(TENANT);
  m.tierFindMany.mockResolvedValue([TIER]);
  m.memberFindMany.mockResolvedValue([MEMBER]);
  m.listPaymentMethods.mockResolvedValue({ data: [] });
  m.subscriptionsList.mockResolvedValue({ data: [] });
  m.memberUpdateMany.mockResolvedValue({ count: 1 });
  m.tierUpdateMany.mockResolvedValue({ count: 1 });
  m.mappingUpsert.mockImplementation(async (a: { create: { tenantId: string; memberId: string } }) => ({ id: "ms-1", tenantId: a.create.tenantId, memberId: a.create.memberId }));
});
afterEach(() => vi.useRealTimers());

describe("replace (the TeamUp cutover default)", () => {
  beforeEach(() => {
    m.customersList.mockResolvedValue({ data: [customer(liveSub(), CARD)], has_more: false });
    m.subscriptionsCreate.mockResolvedValue({ id: "sub_matflow", status: "active", items: { data: [{ current_period_end: Math.floor(PERIOD_END.getTime() / 1000) }] } });
  });

  it("maps OUR replacement (source migration) — never TeamUp's subscription — in the linking transaction, before the pointer", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: "user_owner", now: NOW });
    expect(out[0]).toMatchObject({ outcome: "replaced", subscriptionId: "sub_matflow", replacesSubscriptionId: "sub_teamup" });
    expect(m.mappingUpsert).toHaveBeenCalledTimes(1);
    expect(m.mappingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { stripeSubscriptionId: "sub_matflow" },
      create: expect.objectContaining({
        tenantId: "tenant-A", memberId: "mem_1", stripeAccountId: "acct_gym",
        stripeSubscriptionId: "sub_matflow", source: "migration", status: "active", currentPeriodEnd: PERIOD_END,
      }),
    }));
    const linking = m.ops.filter((o) => o.op === "memberSubscription.upsert" || o.op === "member.updateMany");
    expect(linking.map((o) => o.op)).toEqual(["memberSubscription.upsert", "member.updateMany"]);
    expect(new Set(linking.map((o) => o.tx)).size).toBe(1);
  });

  it("a mapping already held by another member aborts the link (reported as an error row)", async () => {
    m.mappingUpsert.mockResolvedValue({ id: "ms-x", tenantId: "tenant-A", memberId: "mem_OTHER" });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(out[0]).toMatchObject({ memberId: "mem_1", outcome: "error" });
    expect(m.memberUpdateMany).not.toHaveBeenCalled();
  });

  it("dry run writes no mapping", async () => {
    await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: true, userId: null, now: NOW });
    expect(m.mappingUpsert).not.toHaveBeenCalled();
  });
});

describe("adopt (allowAdopt only)", () => {
  it("maps the adopted subscription with source adopted and its Stripe status", async () => {
    m.customersList.mockResolvedValue({ data: [customer(liveSub("past_due"), null)], has_more: false });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW, allowAdopt: true });
    expect(out[0]).toMatchObject({ outcome: "adopted", subscriptionId: "sub_teamup" });
    expect(m.mappingUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        memberId: "mem_1", stripeSubscriptionId: "sub_teamup", source: "adopted", status: "past_due", currentPeriodEnd: PERIOD_END,
      }),
    }));
    const linking = m.ops.filter((o) => o.op === "memberSubscription.upsert" || o.op === "member.updateMany");
    expect(linking.map((o) => o.op)).toEqual(["memberSubscription.upsert", "member.updateMany"]);
    expect(new Set(linking.map((o) => o.tx)).size).toBe(1);
  });
});
