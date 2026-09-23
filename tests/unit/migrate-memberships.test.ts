import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Moving memberships off a previous platform (lib/stripe/migrate-memberships.ts).
 *
 * The whole point is that nobody re-enters a card and nobody is charged twice,
 * so the tests pin: the per-member classification (adopt / create / the exact
 * skip reason), that a preview never writes, that apply recomputes rather than
 * trusting the client, that a created subscription is anchored to the member's
 * due date with no proration and an idempotency key on the MEMBER, that an
 * adopt writes the existing ids and never calls Stripe, and that a member
 * already linked is left alone.
 */

const {
  customersListMock,
  listPaymentMethodsMock,
  subscriptionsCreateMock,
  productsCreateMock,
  pricesCreateMock,
  tenantFindUniqueMock,
  tierFindManyMock,
  tierUpdateMock,
  tierUpdateManyMock,
  memberFindManyMock,
  memberUpdateManyMock,
  logAuditMock,
} = vi.hoisted(() => ({
  customersListMock: vi.fn(),
  listPaymentMethodsMock: vi.fn(),
  subscriptionsCreateMock: vi.fn(),
  productsCreateMock: vi.fn(),
  pricesCreateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  tierFindManyMock: vi.fn(),
  tierUpdateMock: vi.fn(),
  tierUpdateManyMock: vi.fn(),
  memberFindManyMock: vi.fn(),
  memberUpdateManyMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

const fakeTx = {
  tenant: { findUnique: tenantFindUniqueMock },
  membershipTier: { findMany: tierFindManyMock, update: tierUpdateMock, updateMany: tierUpdateManyMock },
  member: { findMany: memberFindManyMock, updateMany: memberUpdateManyMock },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

import { previewMigration, applyMigration, MIN_ANCHOR_LEAD_MS } from "@/lib/stripe/migrate-memberships";
import type Stripe from "stripe";

const stripe = {
  customers: { list: customersListMock, listPaymentMethods: listPaymentMethodsMock },
  subscriptions: { create: subscriptionsCreateMock },
  products: { create: productsCreateMock },
  prices: { create: pricesCreateMock },
} as unknown as Stripe;

const NOW = new Date("2026-09-24T09:00:00Z");
const TENANT = { id: "tenant-A", stripeAccountId: "acct_gym", stripeConnected: true, acceptsBacs: false, currency: "GBP" };

const TIER_4W = {
  id: "tier_4w", name: "Adult 4-weekly", pricePence: 3800, currency: "GBP", billingCycle: "four_weekly",
  stripePriceId: null, stripeProductId: null, isActive: true,
};
const TIER_MONTHLY_PRICED = {
  id: "tier_m", name: "Adult Monthly", pricePence: 6500, currency: "GBP", billingCycle: "monthly",
  stripePriceId: "price_monthly_65", stripeProductId: "prod_m", isActive: true,
};

function member(over: Partial<{
  id: string; name: string; email: string; status: string; stripeCustomerId: string | null;
  stripeSubscriptionId: string | null; membershipTierId: string | null; nextDueAt: Date | null;
}> = {}) {
  return {
    id: "mem_1", name: "Sam Fighter", email: "sam@gym.test", status: "active",
    stripeCustomerId: null, stripeSubscriptionId: null, membershipTierId: null, nextDueAt: null,
    ...over,
  };
}

function customer(over: Partial<{
  id: string; email: string | null; created: number; subscriptions: unknown[];
  defaultPaymentMethod: unknown;
}> = {}) {
  const { defaultPaymentMethod, subscriptions, ...rest } = over;
  return {
    id: "cus_sam", email: "sam@gym.test", created: 1_700_000_000,
    subscriptions: { data: subscriptions ?? [] },
    invoice_settings: { default_payment_method: defaultPaymentMethod ?? null },
    ...rest,
  };
}

const CARD = { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } };
const BACS = { id: "pm_bacs", type: "bacs_debit", bacs_debit: { last4: "1234" } };

function liveSub(over: Partial<{ id: string; status: string; priceId: string; unit_amount: number; interval: string; interval_count: number; period_end: number }> = {}) {
  const priceId = over.priceId ?? "price_monthly_65";
  return {
    id: over.id ?? "sub_live",
    status: over.status ?? "active",
    items: {
      data: [{
        current_period_end: over.period_end ?? Math.floor(new Date("2026-10-08T00:00:00Z").getTime() / 1000),
        price: {
          id: priceId,
          unit_amount: over.unit_amount ?? 6500,
          currency: "gbp",
          recurring: { interval: over.interval ?? "month", interval_count: over.interval_count ?? 1 },
        },
      }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantFindUniqueMock.mockResolvedValue(TENANT);
  tierFindManyMock.mockResolvedValue([TIER_4W, TIER_MONTHLY_PRICED]);
  memberFindManyMock.mockResolvedValue([member()]);
  customersListMock.mockResolvedValue({ data: [customer()], has_more: false });
  listPaymentMethodsMock.mockResolvedValue({ data: [] });
  memberUpdateManyMock.mockResolvedValue({ count: 1 });
  tierUpdateManyMock.mockResolvedValue({ count: 1 });
  tierUpdateMock.mockResolvedValue({});
});

describe("preview — classification", () => {
  it("adopts a live subscription whose price is already on a tier, taking the period end as the next due date", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()] })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r.action).toBe("adopt");
    expect(r.tierId).toBe("tier_m");
    expect(r.tierMatchedBy).toBe("price");
    expect(r.subscriptionId).toBe("sub_live");
    expect(r.firstChargeAt).toBe("2026-10-08T00:00:00.000Z");
    expect(r.amountPence).toBe(6500);
    expect(r.cycle).toBe("monthly");
    expect(p.summary).toMatchObject({ adopt: 1, create: 0, skip: 0, unmatchedCustomers: 0, firstChargeDates: ["2026-10-08"] });
  });

  it("matches an unpriced tier by amount + currency + cycle (a 4-weekly Stripe price is week × 4)", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_from_old_platform", unit_amount: 3800, interval: "week", interval_count: 4 })] })],
      has_more: false,
    });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "adopt", tierId: "tier_4w", tierMatchedBy: "amount", cycle: "four_weekly", cycleLabel: "Every 4 weeks", priceId: "price_from_old_platform" });
  });

  it("never guesses a tier: an unknown price is needs_tier, two candidates is ambiguous_tier", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_unknown", unit_amount: 9900 })] })],
      has_more: false,
    });
    expect((await previewMigration(stripe, "tenant-A", NOW)).rows[0]).toMatchObject({ action: "skip", reason: "needs_tier", amountPence: 9900 });

    tierFindManyMock.mockResolvedValue([TIER_4W, { ...TIER_4W, id: "tier_4w_b", name: "Adult 4-weekly (old)" }]);
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_x", unit_amount: 3800, interval: "week", interval_count: 4 })] })],
      has_more: false,
    });
    expect((await previewMigration(stripe, "tenant-A", NOW)).rows[0]).toMatchObject({ action: "skip", reason: "ambiguous_tier" });
  });

  it("creates on the saved card, anchored to the member's due date, when there is no live subscription", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    customersListMock.mockResolvedValue({ data: [customer({ defaultPaymentMethod: CARD })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({
      action: "create", tierId: "tier_4w", tierMatchedBy: "member",
      paymentMethod: { id: "pm_card", type: "card", label: "Visa ending 4242" },
      firstChargeAt: "2026-10-06T00:00:00.000Z", amountPence: 3800, cycleLabel: "Every 4 weeks",
    });
    expect(listPaymentMethodsMock).not.toHaveBeenCalled();
  });

  it("falls back to the customer's attached methods when no default is set, preferring a card", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    listPaymentMethodsMock.mockResolvedValue({ data: [BACS, CARD] });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0].action).toBe("create");
    expect(p.rows[0].paymentMethod?.id).toBe("pm_card");
    expect(listPaymentMethodsMock).toHaveBeenCalledWith("cus_sam", { limit: 10 }, { stripeAccount: "acct_gym" });
  });

  it.each([
    ["already_linked", { stripeSubscriptionId: "sub_old" }, {}],
    ["no_tier", { nextDueAt: new Date("2026-10-06T00:00:00Z") }, { defaultPaymentMethod: CARD }],
    ["tier_not_recurring", { membershipTierId: "tier_oneoff", nextDueAt: new Date("2026-10-06T00:00:00Z") }, { defaultPaymentMethod: CARD }],
    ["no_payment_method", { membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }, {}],
    ["bacs_not_enabled", { membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }, { defaultPaymentMethod: BACS }],
    ["no_due_date", { membershipTierId: "tier_4w", nextDueAt: null }, { defaultPaymentMethod: CARD }],
    ["due_date_past", { membershipTierId: "tier_4w", nextDueAt: new Date(NOW.getTime() + MIN_ANCHOR_LEAD_MS - 1) }, { defaultPaymentMethod: CARD }],
  ] as const)("skips with the exact reason: %s", async (reason, memberOver, customerOver) => {
    tierFindManyMock.mockResolvedValue([TIER_4W, { ...TIER_4W, id: "tier_oneoff", name: "Drop-in", billingCycle: "none" }]);
    memberFindManyMock.mockResolvedValue([member(memberOver)]);
    customersListMock.mockResolvedValue({ data: [customer(customerOver)], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "skip", reason });
    expect(p.summary.skippedByReason[reason]).toBe(1);
  });

  it("a member with no Stripe customer is no_customer, and a customer with no member is counted", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ id: "cus_other", email: "nobody@gym.test" })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "skip", reason: "no_customer", customerId: null });
    expect(p.summary.unmatchedCustomers).toBe(1);
  });

  it("matches emails case-insensitively and prefers the duplicate customer with a live subscription", async () => {
    customersListMock.mockResolvedValue({
      data: [
        customer({ id: "cus_stale", email: "SAM@gym.test", created: 1_800_000_000 }),
        customer({ id: "cus_live", email: "Sam@Gym.Test", created: 1_600_000_000, subscriptions: [liveSub()] }),
      ],
      has_more: false,
    });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "adopt", customerId: "cus_live" });
  });

  it("pages through every customer on the connected account", async () => {
    customersListMock
      .mockResolvedValueOnce({ data: [customer({ id: "cus_a", email: "a@x.test" })], has_more: true })
      .mockResolvedValueOnce({ data: [customer({ id: "cus_sam" })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(customersListMock).toHaveBeenCalledTimes(2);
    expect(customersListMock.mock.calls[1][0]).toMatchObject({ starting_after: "cus_a" });
    expect(customersListMock.mock.calls[0][1]).toEqual({ stripeAccount: "acct_gym" });
    expect(p.rows[0].customerId).toBe("cus_sam");
  });

  it("preview never writes and never creates anything on Stripe", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    customersListMock.mockResolvedValue({ data: [customer({ defaultPaymentMethod: CARD })], has_more: false });
    await previewMigration(stripe, "tenant-A", NOW);
    expect(memberUpdateManyMock).not.toHaveBeenCalled();
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(pricesCreateMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("refuses when the club has not connected Stripe", async () => {
    tenantFindUniqueMock.mockResolvedValue({ ...TENANT, stripeConnected: false, stripeAccountId: null });
    await expect(previewMigration(stripe, "tenant-A", NOW)).rejects.toMatchObject({ code: "not_connected" });
    expect(customersListMock).not.toHaveBeenCalled();
  });
});

describe("apply — adopt", () => {
  beforeEach(() => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub({ status: "past_due" })] })], has_more: false });
  });

  it("links the existing customer and subscription, sets the tier, period end and payment status — and calls Stripe for nothing", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: "user_owner", now: NOW });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "adopted", subscriptionId: "sub_live", firstChargeAt: "2026-10-08T00:00:00.000Z" }]);
    expect(memberUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "mem_1", tenantId: "tenant-A", stripeSubscriptionId: null },
      data: expect.objectContaining({
        stripeCustomerId: "cus_sam",
        stripeSubscriptionId: "sub_live",
        membershipTierId: "tier_m",
        membershipType: "Adult Monthly",
        nextDueAt: new Date("2026-10-08T00:00:00.000Z"),
        paymentStatus: "overdue",
      }),
    });
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(pricesCreateMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.subscription.migrated", entityId: "mem_1", userId: "user_owner",
      metadata: expect.objectContaining({ mode: "adopt", stripeSubscriptionId: "sub_live" }),
    }));
  });

  it("a tier matched by amount learns the price id", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_old", unit_amount: 3800, interval: "week", interval_count: 4 })] })],
      has_more: false,
    });
    await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(tierUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "tier_4w", tenantId: "tenant-A", stripePriceId: null },
      data: { stripePriceId: "price_old" },
    });
  });

  it("does not overwrite a member linked in the meantime", async () => {
    memberUpdateManyMock.mockResolvedValue({ count: 0 });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(out[0]).toMatchObject({ outcome: "error" });
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("apply — create", () => {
  beforeEach(() => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    customersListMock.mockResolvedValue({ data: [customer({ defaultPaymentMethod: CARD })], has_more: false });
    productsCreateMock.mockResolvedValue({ id: "prod_new" });
    pricesCreateMock.mockResolvedValue({ id: "price_new" });
    subscriptionsCreateMock.mockResolvedValue({ id: "sub_new", status: "active" });
  });

  it("mints the tier's price if missing, then creates an anchored, unprorated subscription on the saved card, keyed on the member", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: "user_owner", now: NOW });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "created", subscriptionId: "sub_new", firstChargeAt: "2026-10-06T00:00:00.000Z" }]);

    expect(pricesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ product: "prod_new", unit_amount: 3800, currency: "gbp", recurring: { interval: "week", interval_count: 4 } }),
      { stripeAccount: "acct_gym" },
    );
    expect(tierUpdateMock).toHaveBeenCalledWith({ where: { id: "tier_4w" }, data: { stripePriceId: "price_new", stripeProductId: "prod_new" } });

    const [params, opts] = subscriptionsCreateMock.mock.calls[0];
    expect(params).toMatchObject({
      customer: "cus_sam",
      items: [{ price: "price_new" }],
      default_payment_method: "pm_card",
      billing_cycle_anchor: Math.floor(new Date("2026-10-06T00:00:00Z").getTime() / 1000),
      proration_behavior: "none",
      off_session: true,
      payment_settings: { payment_method_types: ["card"], save_default_payment_method: "on_subscription" },
    });
    expect(params.trial_end).toBeUndefined();
    expect(opts).toEqual({ stripeAccount: "acct_gym", idempotencyKey: "matflow_migrate_mem_1" });

    expect(memberUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "mem_1", tenantId: "tenant-A", stripeSubscriptionId: null },
      data: expect.objectContaining({
        stripeCustomerId: "cus_sam", stripeSubscriptionId: "sub_new", membershipTierId: "tier_4w",
        nextDueAt: new Date("2026-10-06T00:00:00Z"), paymentStatus: "paid", preferredPaymentMethod: "card",
      }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ mode: "create", stripeSubscriptionId: "sub_new" }) }));
  });

  it("reuses a tier's existing Stripe price instead of minting another", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_m", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(pricesCreateMock).not.toHaveBeenCalled();
    expect(subscriptionsCreateMock.mock.calls[0][0]).toMatchObject({ items: [{ price: "price_monthly_65" }] });
  });

  it("a dry run reports what would happen and touches nothing", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: true, userId: null, now: NOW });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "would_create", subscriptionId: null, firstChargeAt: "2026-10-06T00:00:00.000Z" }]);
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(memberUpdateManyMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("recomputes rather than trusting the request: a member the preview skips is reported skipped, and unnamed members are untouched", async () => {
    memberFindManyMock.mockResolvedValue([
      member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }),
      member({ id: "mem_2", email: "no-card@gym.test", membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }),
      member({ id: "mem_3", email: "unnamed@gym.test", membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }),
    ]);
    customersListMock.mockResolvedValue({
      data: [
        customer({ defaultPaymentMethod: CARD }),
        customer({ id: "cus_2", email: "no-card@gym.test" }),
        customer({ id: "cus_3", email: "unnamed@gym.test", defaultPaymentMethod: CARD }),
      ],
      has_more: false,
    });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1", "mem_2"], { dryRun: false, userId: null, now: NOW });
    expect(out).toEqual([
      { memberId: "mem_1", outcome: "created", subscriptionId: "sub_new", firstChargeAt: "2026-10-06T00:00:00.000Z" },
      { memberId: "mem_2", outcome: "skipped", reason: "no_payment_method" },
    ]);
    expect(subscriptionsCreateMock).toHaveBeenCalledTimes(1);
  });

  it("a Stripe failure on one member does not stop the next, and is reported per row", async () => {
    memberFindManyMock.mockResolvedValue([
      member({ membershipTierId: "tier_m", nextDueAt: new Date("2026-10-06T00:00:00Z") }),
      member({ id: "mem_2", email: "two@gym.test", membershipTierId: "tier_m", nextDueAt: new Date("2026-10-06T00:00:00Z") }),
    ]);
    customersListMock.mockResolvedValue({
      data: [customer({ defaultPaymentMethod: CARD }), customer({ id: "cus_2", email: "two@gym.test", defaultPaymentMethod: CARD })],
      has_more: false,
    });
    subscriptionsCreateMock
      .mockRejectedValueOnce(new Error("Your card was declined."))
      .mockResolvedValueOnce({ id: "sub_2", status: "active" });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1", "mem_2"], { dryRun: false, userId: null, now: NOW });
    expect(out[0]).toEqual({ memberId: "mem_1", outcome: "error", message: "Your card was declined." });
    expect(out[1]).toMatchObject({ memberId: "mem_2", outcome: "created", subscriptionId: "sub_2" });
  });
});
