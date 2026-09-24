import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Moving memberships off a previous platform (lib/stripe/migrate-memberships.ts).
 *
 * The whole point is that nobody re-enters a card and nobody is charged twice,
 * so the tests pin: the per-member classification (replace by default for an
 * existing subscription, adopt only when allowed, create for a saved card, the
 * exact skip reason otherwise), that a preview never writes, that apply
 * recomputes rather than trusting the client, that a replacement is anchored
 * to the EXISTING subscription's verified period end, that a created
 * subscription is keyed on the member and recoverable from its own metadata
 * after the idempotency window, and that a member already linked or on hold
 * is left alone.
 */

const {
  customersListMock,
  listPaymentMethodsMock,
  paymentMethodsRetrieveMock,
  subscriptionsListMock,
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
  paymentMethodsRetrieveMock: vi.fn(),
  subscriptionsListMock: vi.fn(),
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
  paymentMethods: { retrieve: paymentMethodsRetrieveMock },
  subscriptions: { list: subscriptionsListMock, create: subscriptionsCreateMock },
  products: { create: productsCreateMock },
  prices: { create: pricesCreateMock },
} as unknown as Stripe;

const NOW = new Date("2026-09-24T09:00:00Z");
const PERIOD_END = new Date("2026-10-08T00:00:00Z");
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
  id: string; name: string; email: string; status: string; paymentStatus: string; stripeCustomerId: string | null;
  stripeSubscriptionId: string | null; membershipTierId: string | null; nextDueAt: Date | null;
}> = {}) {
  return {
    id: "mem_1", name: "Sam Fighter", email: "sam@gym.test", status: "active", paymentStatus: "paid",
    stripeCustomerId: null, stripeSubscriptionId: null, membershipTierId: null, nextDueAt: null,
    ...over,
  };
}

const CARD = { id: "pm_card", type: "card", card: { brand: "visa", last4: "4242" } };
const BACS = { id: "pm_bacs", type: "bacs_debit", bacs_debit: { last4: "1234" } };

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

function liveSub(over: Partial<{ id: string; status: string; priceId: string; unit_amount: number; interval: string; interval_count: number; period_end: number; default_payment_method: unknown; metadata: Record<string, string> }> = {}) {
  const priceId = over.priceId ?? "price_monthly_65";
  return {
    id: over.id ?? "sub_live",
    status: over.status ?? "active",
    default_payment_method: over.default_payment_method ?? null,
    metadata: over.metadata ?? {},
    items: {
      data: [{
        current_period_end: over.period_end ?? Math.floor(PERIOD_END.getTime() / 1000),
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
  subscriptionsListMock.mockResolvedValue({ data: [] });
  memberUpdateManyMock.mockResolvedValue({ count: 1 });
  tierUpdateManyMock.mockResolvedValue({ count: 1 });
  tierUpdateMock.mockResolvedValue({});
});

describe("preview — an existing subscription is REPLACED at its period end by default", () => {
  it("replaces: anchor = the existing subscription's verified period end, same tier, same card, old id reported", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()], defaultPaymentMethod: CARD })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r.action).toBe("replace");
    expect(r.tierId).toBe("tier_m");
    expect(r.tierMatchedBy).toBe("price");
    expect(r.replacesSubscriptionId).toBe("sub_live");
    expect(r.subscriptionId).toBeNull();
    expect(r.firstChargeAt).toBe(PERIOD_END.toISOString());
    expect(r.paymentMethod).toEqual({ id: "pm_card", type: "card", label: "Visa ending 4242" });
    expect(p.summary).toMatchObject({ replace: 1, adopt: 0, create: 0, skip: 0, firstChargeDates: ["2026-10-08"] });
  });

  it("uses the subscription's own payment method when it names one the customer does not default to", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ default_payment_method: "pm_sub_card" })], defaultPaymentMethod: BACS })],
      has_more: false,
    });
    paymentMethodsRetrieveMock.mockResolvedValue({ id: "pm_sub_card", type: "card", card: { brand: "mastercard", last4: "5555" } });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0].paymentMethod).toEqual({ id: "pm_sub_card", type: "card", label: "Mastercard ending 5555" });
    expect(paymentMethodsRetrieveMock).toHaveBeenCalledWith("pm_sub_card", {}, { stripeAccount: "acct_gym" });
  });

  it("adopts instead only when allowAdopt is set", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()] })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW, { allowAdopt: true });
    expect(p.rows[0]).toMatchObject({ action: "adopt", subscriptionId: "sub_live", replacesSubscriptionId: null, firstChargeAt: PERIOD_END.toISOString() });
    expect(p.summary).toMatchObject({ adopt: 1, replace: 0 });
  });

  it("matches an unpriced tier by amount + currency + cycle (a 4-weekly Stripe price is week × 4)", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_from_old_platform", unit_amount: 3800, interval: "week", interval_count: 4 })], defaultPaymentMethod: CARD })],
      has_more: false,
    });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "replace", tierId: "tier_4w", tierMatchedBy: "amount", cycle: "four_weekly", cycleLabel: "Every 4 weeks", priceId: "price_from_old_platform" });
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

  it("the member's imported tier must agree with what the subscription bills — otherwise tier_mismatch, both named", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w" })]);
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()], defaultPaymentMethod: CARD })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "skip", reason: "tier_mismatch", memberTierName: "Adult 4-weekly", tierName: "Adult Monthly" });
  });

  it("a period ending within the hour is period_end_too_soon, never an anchor in the past", async () => {
    const soon = Math.floor((NOW.getTime() + MIN_ANCHOR_LEAD_MS - 1000) / 1000);
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub({ period_end: soon })], defaultPaymentMethod: CARD })], has_more: false });
    expect((await previewMigration(stripe, "tenant-A", NOW)).rows[0]).toMatchObject({ action: "skip", reason: "period_end_too_soon" });
  });

  it("a subscription with no usable payment method cannot be replaced", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()] })], has_more: false });
    expect((await previewMigration(stripe, "tenant-A", NOW)).rows[0]).toMatchObject({ action: "skip", reason: "no_payment_method" });
  });
});

describe("preview — no subscription", () => {
  it("creates on the saved card, anchored to the member's confirmed due date", async () => {
    memberFindManyMock.mockResolvedValue([member({ membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") })]);
    customersListMock.mockResolvedValue({ data: [customer({ defaultPaymentMethod: CARD })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({
      action: "create", tierId: "tier_4w", tierMatchedBy: "member",
      paymentMethod: { id: "pm_card", type: "card", label: "Visa ending 4242" },
      firstChargeAt: "2026-10-06T00:00:00.000Z", amountPence: 3800, cycleLabel: "Every 4 weeks", replacesSubscriptionId: null,
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
    ["on_hold", { paymentStatus: "paused", membershipTierId: "tier_4w", nextDueAt: new Date("2026-10-06T00:00:00Z") }, { defaultPaymentMethod: CARD }],
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

  it("an on-hold member is skipped even when their customer has a live subscription", async () => {
    memberFindManyMock.mockResolvedValue([member({ paymentStatus: "paused" })]);
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()], defaultPaymentMethod: CARD })], has_more: false });
    expect((await previewMigration(stripe, "tenant-A", NOW)).rows[0]).toMatchObject({ action: "skip", reason: "on_hold" });
  });

  it("an already-moved member whose old subscription is still running is flagged and counted", async () => {
    memberFindManyMock.mockResolvedValue([member({ stripeSubscriptionId: "sub_ours" })]);
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub({ id: "sub_teamup" }), liveSub({ id: "sub_ours" })] })], has_more: false });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "skip", reason: "already_linked", otherLiveSubscriptionId: "sub_teamup" });
    expect(p.summary.oldSubscriptionsStillLive).toBe(1);
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
        customer({ id: "cus_live", email: "Sam@Gym.Test", created: 1_600_000_000, subscriptions: [liveSub()], defaultPaymentMethod: CARD }),
      ],
      has_more: false,
    });
    const p = await previewMigration(stripe, "tenant-A", NOW);
    expect(p.rows[0]).toMatchObject({ action: "replace", customerId: "cus_live" });
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

describe("apply — replace", () => {
  beforeEach(() => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()], defaultPaymentMethod: CARD })], has_more: false });
    subscriptionsCreateMock.mockResolvedValue({ id: "sub_new", status: "active" });
  });

  it("creates our subscription anchored to the old one's period end, links the member to OURS, names the old one to end", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: "user_owner", now: NOW });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "replaced", subscriptionId: "sub_new", firstChargeAt: PERIOD_END.toISOString(), replacesSubscriptionId: "sub_live" }]);
    const [params, opts] = subscriptionsCreateMock.mock.calls[0];
    expect(params).toMatchObject({
      customer: "cus_sam",
      items: [{ price: "price_monthly_65" }],
      default_payment_method: "pm_card",
      billing_cycle_anchor: Math.floor(PERIOD_END.getTime() / 1000),
      proration_behavior: "none",
      off_session: true,
      metadata: { matflowMemberId: "mem_1", matflowReplaces: "sub_live" },
    });
    expect(opts).toEqual({ stripeAccount: "acct_gym", idempotencyKey: "matflow_migrate_mem_1" });
    expect(memberUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "mem_1", tenantId: "tenant-A", stripeSubscriptionId: null },
      data: expect.objectContaining({ stripeCustomerId: "cus_sam", stripeSubscriptionId: "sub_new", membershipTierId: "tier_m", nextDueAt: PERIOD_END, paymentStatus: "paid" }),
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.subscription.migrated",
      metadata: expect.objectContaining({ mode: "replace", stripeSubscriptionId: "sub_new", replacesSubscriptionId: "sub_live", recovered: false }),
    }));
    // The old subscription is never touched by us.
    expect(pricesCreateMock).not.toHaveBeenCalled();
  });

  it("recovers a subscription a previous run created but never linked, instead of creating a second one", async () => {
    subscriptionsListMock.mockResolvedValue({ data: [liveSub({ id: "sub_orphan", metadata: { matflowMemberId: "mem_1" } })] });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(out[0]).toMatchObject({ outcome: "replaced", subscriptionId: "sub_orphan" });
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(subscriptionsListMock).toHaveBeenCalledWith({ customer: "cus_sam", status: "all", limit: 20 }, { stripeAccount: "acct_gym" });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ recovered: true, stripeSubscriptionId: "sub_orphan" }) }));
  });

  it("a cancelled orphan is not recovered", async () => {
    subscriptionsListMock.mockResolvedValue({ data: [liveSub({ id: "sub_dead", status: "canceled", metadata: { matflowMemberId: "mem_1" } })] });
    await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(subscriptionsCreateMock).toHaveBeenCalledTimes(1);
  });

  it("dry run reports would_replace and touches nothing", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: true, userId: null, now: NOW });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "would_replace", subscriptionId: null, firstChargeAt: PERIOD_END.toISOString(), replacesSubscriptionId: "sub_live" }]);
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(memberUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("apply — adopt (allowAdopt only)", () => {
  beforeEach(() => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub({ status: "past_due" })] })], has_more: false });
  });

  it("links the existing customer and subscription, sets the tier, period end and payment status — and calls Stripe for nothing", async () => {
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: "user_owner", now: NOW, allowAdopt: true });
    expect(out).toEqual([{ memberId: "mem_1", outcome: "adopted", subscriptionId: "sub_live", firstChargeAt: PERIOD_END.toISOString() }]);
    expect(memberUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "mem_1", tenantId: "tenant-A", stripeSubscriptionId: null },
      data: expect.objectContaining({ stripeCustomerId: "cus_sam", stripeSubscriptionId: "sub_live", membershipTierId: "tier_m", nextDueAt: PERIOD_END, paymentStatus: "overdue" }),
    });
    expect(subscriptionsCreateMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ mode: "adopt", stripeSubscriptionId: "sub_live" }) }));
  });

  it("a tier matched by amount learns the price id", async () => {
    customersListMock.mockResolvedValue({
      data: [customer({ subscriptions: [liveSub({ priceId: "price_old", unit_amount: 3800, interval: "week", interval_count: 4 })] })],
      has_more: false,
    });
    await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW, allowAdopt: true });
    expect(tierUpdateManyMock).toHaveBeenCalledWith({ where: { id: "tier_4w", tenantId: "tenant-A", stripePriceId: null }, data: { stripePriceId: "price_old" } });
  });

  it("without allowAdopt the same member is a replace, not an adopt", async () => {
    customersListMock.mockResolvedValue({ data: [customer({ subscriptions: [liveSub()], defaultPaymentMethod: CARD })], has_more: false });
    subscriptionsCreateMock.mockResolvedValue({ id: "sub_new", status: "active" });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW });
    expect(out[0]).toMatchObject({ outcome: "replaced" });
  });

  it("does not overwrite a member linked in the meantime", async () => {
    memberUpdateManyMock.mockResolvedValue({ count: 0 });
    const out = await applyMigration(stripe, "tenant-A", ["mem_1"], { dryRun: false, userId: null, now: NOW, allowAdopt: true });
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
    expect(out).toEqual([{ memberId: "mem_1", outcome: "created", subscriptionId: "sub_new", firstChargeAt: "2026-10-06T00:00:00.000Z", replacesSubscriptionId: null }]);

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
    expect(params.metadata.matflowReplaces).toBeUndefined();
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
    expect(out).toEqual([{ memberId: "mem_1", outcome: "would_create", subscriptionId: null, firstChargeAt: "2026-10-06T00:00:00.000Z", replacesSubscriptionId: null }]);
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
      { memberId: "mem_1", outcome: "created", subscriptionId: "sub_new", firstChargeAt: "2026-10-06T00:00:00.000Z", replacesSubscriptionId: null },
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
