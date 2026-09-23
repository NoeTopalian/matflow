import type Stripe from "stripe";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { membershipTierWrite } from "@/lib/membership-tier";
import { cycleFromStripeRecurring, cycleLabel, type BillingCycle } from "@/lib/billing-cycle";
import { ensureTierPrice, type TierForPrice } from "@/lib/stripe/tier-price";
import { isLiveSubscriptionStatus, subscriptionStatusToPaymentStatus } from "@/lib/stripe/subscription-status";

/**
 * Moving a club's memberships off its previous platform WITHOUT anyone
 * re-entering card details.
 *
 * The club connects the SAME Stripe account its old platform billed through
 * (Standard Connect, the club is merchant of record), so its members' Stripe
 * customers, saved cards and Direct Debit mandates are already there. Two
 * shapes exist, per customer, and the preview says which:
 *
 *  - ADOPT: the old platform created a Stripe subscription. Nothing new is
 *    created; the member row is pointed at the existing customer and
 *    subscription, the tier is matched to the subscription's price, and the
 *    next due date is the subscription's own period end. The member keeps
 *    their amount, cadence and charge date because nothing about the
 *    subscription changed.
 *  - CREATE: the old platform only saved a payment method and charged on its
 *    own timetable. A subscription is created on that saved method, anchored
 *    to the member's next due date (`billing_cycle_anchor`, no proration), so
 *    the first MatFlow charge falls exactly where the next old-platform charge
 *    would have. Nothing is charged at creation (on 2026-03-25.dahlia Stripe
 *    creates no invoice until the anchor; older versions issued a £0 one,
 *    which the webhook knows not to record as a payment).
 *
 * What this module never does: charge anyone now, touch a member who is
 * already linked, guess a tier, or write outside the tenant's own context.
 * The one guard it cannot provide is the cutover itself — the old platform
 * must stop billing before each first-charge date, which is why every row
 * carries that date for the owner to act on.
 */

export type MigrationAction = "adopt" | "create" | "skip";

export type MigrationReason =
  | "already_linked"
  | "no_customer"
  | "needs_tier"
  | "ambiguous_tier"
  | "no_tier"
  | "tier_not_recurring"
  | "no_payment_method"
  | "bacs_not_enabled"
  | "no_due_date"
  | "due_date_past";

export type MigrationPaymentMethod = {
  id: string;
  type: "card" | "bacs_debit";
  /** Owner-facing: "Visa ending 4242" / "Direct Debit ending 1234". */
  label: string;
};

export type MigrationRow = {
  memberId: string;
  memberName: string;
  memberEmail: string;
  customerId: string | null;
  action: MigrationAction;
  reason: MigrationReason | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  /** The Stripe price an adopted subscription bills on (null for create rows). */
  priceId: string | null;
  tierId: string | null;
  tierName: string | null;
  tierMatchedBy: "price" | "amount" | "member" | null;
  amountPence: number | null;
  currency: string | null;
  cycle: string | null;
  cycleLabel: string | null;
  paymentMethod: MigrationPaymentMethod | null;
  /** ISO. Adopt: the subscription's current period end. Create: the anchor. */
  firstChargeAt: string | null;
};

export type MigrationPreview = {
  rows: MigrationRow[];
  summary: {
    adopt: number;
    create: number;
    skip: number;
    skippedByReason: Partial<Record<MigrationReason, number>>;
    /** Stripe customers with no member of this club on that email. */
    unmatchedCustomers: number;
    firstChargeDates: string[];
  };
};

export type MigrationOutcome =
  | { memberId: string; outcome: "adopted" | "created" | "would_adopt" | "would_create"; subscriptionId: string | null; firstChargeAt: string | null }
  | { memberId: string; outcome: "skipped"; reason: MigrationReason }
  | { memberId: string; outcome: "error"; message: string };

export class MigrationError extends Error {
  constructor(public code: "not_connected" | "stripe_not_configured", message: string) {
    super(message);
  }
}

/** The earliest a created subscription may first charge — Stripe needs the anchor in the future. */
export const MIN_ANCHOR_LEAD_MS = 60 * 60 * 1000;

type TenantForMigration = {
  id: string;
  stripeAccountId: string | null;
  stripeConnected: boolean;
  acceptsBacs: boolean;
  currency: string;
};

type TierRow = TierForPrice & { isActive: boolean };

type MemberRow = {
  id: string;
  name: string;
  email: string;
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  membershipTierId: string | null;
  nextDueAt: Date | null;
};

type CustomerLite = {
  id: string;
  email: string | null;
  created: number;
  subscriptions: Stripe.Subscription[];
  defaultPaymentMethod: Stripe.PaymentMethod | null;
};

async function loadTenant(tenantId: string): Promise<TenantForMigration> {
  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, stripeAccountId: true, stripeConnected: true, acceptsBacs: true, currency: true },
    }),
  );
  if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
    throw new MigrationError("not_connected", "Connect the club's Stripe account before moving memberships");
  }
  return tenant;
}

async function loadTiersAndMembers(tenantId: string): Promise<{ tiers: TierRow[]; members: MemberRow[] }> {
  return withTenantContext(tenantId, async (tx) => {
    const tiers = await tx.membershipTier.findMany({
      where: { tenantId },
      select: {
        id: true, name: true, pricePence: true, currency: true, billingCycle: true,
        stripePriceId: true, stripeProductId: true, isActive: true,
      },
    });
    const members = await tx.member.findMany({
      // Cancelled members are not migrated: there is nothing to keep billing.
      where: { tenantId, status: { not: "cancelled" } },
      select: {
        id: true, name: true, email: true, status: true,
        stripeCustomerId: true, stripeSubscriptionId: true, membershipTierId: true, nextDueAt: true,
      },
      orderBy: { name: "asc" },
    });
    return { tiers, members };
  });
}

/** Every customer on the connected account, with subscriptions and default payment method expanded. */
async function listCustomers(stripe: Stripe, stripeAccountId: string): Promise<CustomerLite[]> {
  const out: CustomerLite[] = [];
  let startingAfter: string | undefined;
  // Bounded: 100 pages × 100 customers. A club with more than 10,000 Stripe
  // customers is not migrating through a settings panel.
  for (let page = 0; page < 100; page += 1) {
    const res = await stripe.customers.list(
      {
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
        expand: ["data.subscriptions", "data.invoice_settings.default_payment_method"],
      },
      { stripeAccount: stripeAccountId },
    );
    for (const c of res.data) {
      const dpm = c.invoice_settings?.default_payment_method;
      out.push({
        id: c.id,
        email: c.email ?? null,
        created: c.created,
        subscriptions: c.subscriptions?.data ?? [],
        defaultPaymentMethod: dpm && typeof dpm === "object" ? dpm : null,
      });
    }
    if (!res.has_more || res.data.length === 0) break;
    startingAfter = res.data[res.data.length - 1].id;
  }
  return out;
}

/**
 * One customer per email. The old platform may have left duplicates (a member
 * who re-joined); the one with a live subscription wins, then the newest.
 */
function indexCustomersByEmail(customers: CustomerLite[]): Map<string, CustomerLite> {
  const byEmail = new Map<string, CustomerLite>();
  for (const c of customers) {
    const key = c.email?.trim().toLowerCase();
    if (!key) continue;
    const existing = byEmail.get(key);
    if (!existing) { byEmail.set(key, c); continue; }
    const liveNew = pickLiveSubscription(c) !== null;
    const liveOld = pickLiveSubscription(existing) !== null;
    if ((liveNew && !liveOld) || (liveNew === liveOld && c.created > existing.created)) {
      byEmail.set(key, c);
    }
  }
  return byEmail;
}

function pickLiveSubscription(c: CustomerLite): Stripe.Subscription | null {
  const live = c.subscriptions.filter((s) => isLiveSubscriptionStatus(s.status));
  if (live.length === 0) return null;
  return live.find((s) => s.status === "active") ?? live[0];
}

function describePaymentMethod(pm: Stripe.PaymentMethod): MigrationPaymentMethod | null {
  if (pm.type === "card" && pm.card) {
    const brand = pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : "Card";
    return { id: pm.id, type: "card", label: `${brand} ending ${pm.card.last4}` };
  }
  if (pm.type === "bacs_debit" && pm.bacs_debit) {
    return { id: pm.id, type: "bacs_debit", label: `Direct Debit ending ${pm.bacs_debit.last4}` };
  }
  return null;
}

async function findUsablePaymentMethod(
  stripe: Stripe,
  stripeAccountId: string,
  customer: CustomerLite,
): Promise<MigrationPaymentMethod | null> {
  if (customer.defaultPaymentMethod) {
    const d = describePaymentMethod(customer.defaultPaymentMethod);
    if (d) return d;
  }
  const methods = await stripe.customers.listPaymentMethods(
    customer.id,
    { limit: 10 },
    { stripeAccount: stripeAccountId },
  );
  const described = methods.data.map(describePaymentMethod).filter((d): d is MigrationPaymentMethod => d !== null);
  return described.find((d) => d.type === "card") ?? described[0] ?? null;
}

/** `current_period_end` lives on the subscription item on this API version. */
function periodEndOf(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as { current_period_end?: number } | undefined;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix = item?.current_period_end ?? legacy;
  return typeof unix === "number" ? new Date(unix * 1000) : null;
}

type TierMatch =
  | { tier: TierRow; by: "price" | "amount" }
  | { reason: "needs_tier" | "ambiguous_tier" };

function matchTierToPrice(tiers: TierRow[], price: Stripe.Price, cycle: BillingCycle | null): TierMatch {
  const byPrice = tiers.find((t) => t.stripePriceId === price.id);
  if (byPrice) return { tier: byPrice, by: "price" };
  if (!cycle || price.unit_amount == null) return { reason: "needs_tier" };
  const byAmount = tiers.filter(
    (t) =>
      t.isActive &&
      !t.stripePriceId &&
      t.pricePence === price.unit_amount &&
      t.currency.toLowerCase() === price.currency.toLowerCase() &&
      t.billingCycle === cycle,
  );
  if (byAmount.length === 1) return { tier: byAmount[0], by: "amount" };
  return { reason: byAmount.length === 0 ? "needs_tier" : "ambiguous_tier" };
}

function skipRow(base: Omit<MigrationRow, "action" | "reason">, reason: MigrationReason): MigrationRow {
  return { ...base, action: "skip", reason };
}

async function classifyMember(
  stripe: Stripe,
  tenant: TenantForMigration,
  tiers: TierRow[],
  member: MemberRow,
  customer: CustomerLite | undefined,
  now: Date,
): Promise<MigrationRow> {
  const base: Omit<MigrationRow, "action" | "reason"> = {
    memberId: member.id,
    memberName: member.name,
    memberEmail: member.email,
    customerId: customer?.id ?? member.stripeCustomerId ?? null,
    subscriptionId: null,
    subscriptionStatus: null,
    priceId: null,
    tierId: null,
    tierName: null,
    tierMatchedBy: null,
    amountPence: null,
    currency: null,
    cycle: null,
    cycleLabel: null,
    paymentMethod: null,
    firstChargeAt: null,
  };

  if (member.stripeSubscriptionId) return skipRow(base, "already_linked");
  if (!customer) return skipRow(base, "no_customer");

  const sub = pickLiveSubscription(customer);
  if (sub) {
    const price = sub.items?.data?.[0]?.price;
    if (!price) return skipRow({ ...base, subscriptionId: sub.id, subscriptionStatus: sub.status }, "needs_tier");
    const cycle = cycleFromStripeRecurring(price.recurring);
    const withPrice = {
      ...base,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      priceId: price.id,
      amountPence: price.unit_amount,
      currency: price.currency.toUpperCase(),
      cycle,
      cycleLabel: cycle ? cycleLabel(cycle) : null,
      firstChargeAt: periodEndOf(sub)?.toISOString() ?? null,
    };
    const match = matchTierToPrice(tiers, price, cycle);
    if ("reason" in match) return skipRow(withPrice, match.reason);
    return {
      ...withPrice,
      action: "adopt",
      reason: null,
      tierId: match.tier.id,
      tierName: match.tier.name,
      tierMatchedBy: match.by,
    };
  }

  // No live subscription: create one on the saved payment method.
  const tier = member.membershipTierId ? tiers.find((t) => t.id === member.membershipTierId) ?? null : null;
  if (!tier) return skipRow(base, "no_tier");
  const withTier = {
    ...base,
    tierId: tier.id,
    tierName: tier.name,
    tierMatchedBy: "member" as const,
    amountPence: tier.pricePence,
    currency: tier.currency,
    cycle: tier.billingCycle,
    cycleLabel: cycleLabel(tier.billingCycle),
  };
  if (tier.billingCycle === "none") return skipRow(withTier, "tier_not_recurring");

  const pm = await findUsablePaymentMethod(stripe, tenant.stripeAccountId!, customer);
  if (!pm) return skipRow(withTier, "no_payment_method");
  if (pm.type === "bacs_debit" && !tenant.acceptsBacs) return skipRow({ ...withTier, paymentMethod: pm }, "bacs_not_enabled");

  if (!member.nextDueAt) return skipRow({ ...withTier, paymentMethod: pm }, "no_due_date");
  if (member.nextDueAt.getTime() < now.getTime() + MIN_ANCHOR_LEAD_MS) {
    return skipRow({ ...withTier, paymentMethod: pm, firstChargeAt: member.nextDueAt.toISOString() }, "due_date_past");
  }

  return {
    ...withTier,
    action: "create",
    reason: null,
    paymentMethod: pm,
    firstChargeAt: member.nextDueAt.toISOString(),
  };
}

function summarise(rows: MigrationRow[], unmatchedCustomers: number): MigrationPreview["summary"] {
  const skippedByReason: Partial<Record<MigrationReason, number>> = {};
  let adopt = 0, create = 0, skip = 0;
  const dates = new Set<string>();
  for (const r of rows) {
    if (r.action === "adopt") adopt += 1;
    else if (r.action === "create") create += 1;
    else {
      skip += 1;
      if (r.reason) skippedByReason[r.reason] = (skippedByReason[r.reason] ?? 0) + 1;
    }
    if (r.action !== "skip" && r.firstChargeAt) dates.add(r.firstChargeAt.slice(0, 10));
  }
  return { adopt, create, skip, skippedByReason, unmatchedCustomers, firstChargeDates: [...dates].sort() };
}

export async function previewMigration(
  stripe: Stripe,
  tenantId: string,
  now: Date = new Date(),
): Promise<MigrationPreview> {
  const tenant = await loadTenant(tenantId);
  const { tiers, members } = await loadTiersAndMembers(tenantId);
  const customers = await listCustomers(stripe, tenant.stripeAccountId!);
  const byEmail = indexCustomersByEmail(customers);

  const rows: MigrationRow[] = [];
  const matchedCustomerIds = new Set<string>();
  for (const member of members) {
    const customer = byEmail.get(member.email.trim().toLowerCase());
    if (customer) matchedCustomerIds.add(customer.id);
    rows.push(await classifyMember(stripe, tenant, tiers, member, customer, now));
  }
  const unmatched = customers.filter((c) => !matchedCustomerIds.has(c.id)).length;
  return { rows, summary: summarise(rows, unmatched) };
}

export async function applyMigration(
  stripe: Stripe,
  tenantId: string,
  memberIds: string[],
  opts: { dryRun: boolean; userId: string | null; now?: Date },
): Promise<MigrationOutcome[]> {
  const now = opts.now ?? new Date();
  // Never trust a client-supplied plan: recompute, then act only on the rows
  // the owner named AND that still classify as actionable.
  const preview = await previewMigration(stripe, tenantId, now);
  const wanted = new Set(memberIds);
  const tenant = await loadTenant(tenantId);
  const { tiers } = await loadTiersAndMembers(tenantId);
  const tierById = new Map(tiers.map((t) => [t.id, t]));

  const outcomes: MigrationOutcome[] = [];
  for (const row of preview.rows) {
    if (!wanted.has(row.memberId)) continue;
    if (row.action === "skip") {
      outcomes.push({ memberId: row.memberId, outcome: "skipped", reason: row.reason ?? "no_customer" });
      continue;
    }
    if (opts.dryRun) {
      outcomes.push({
        memberId: row.memberId,
        outcome: row.action === "adopt" ? "would_adopt" : "would_create",
        subscriptionId: row.subscriptionId,
        firstChargeAt: row.firstChargeAt,
      });
      continue;
    }
    try {
      const tier = tierById.get(row.tierId!)!;
      if (row.action === "adopt") {
        await adoptOne(tenant, row, tier, opts.userId);
        outcomes.push({ memberId: row.memberId, outcome: "adopted", subscriptionId: row.subscriptionId, firstChargeAt: row.firstChargeAt });
      } else {
        const subscriptionId = await createOne(stripe, tenant, row, tier, opts.userId);
        outcomes.push({ memberId: row.memberId, outcome: "created", subscriptionId, firstChargeAt: row.firstChargeAt });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      outcomes.push({ memberId: row.memberId, outcome: "error", message: message.slice(0, 300) });
    }
  }
  return outcomes;
}

async function adoptOne(tenant: TenantForMigration, row: MigrationRow, tier: TierRow, userId: string | null) {
  const firstChargeAt = row.firstChargeAt ? new Date(row.firstChargeAt) : null;
  const paymentStatus = row.subscriptionStatus ? subscriptionStatusToPaymentStatus(row.subscriptionStatus) : undefined;
  await withTenantContext(tenant.id, async (tx) => {
    // Compare-and-set on the link: a concurrent apply, or a webhook that
    // linked this member in the meantime, must not be overwritten.
    const linked = await tx.member.updateMany({
      where: { id: row.memberId, tenantId: tenant.id, stripeSubscriptionId: null },
      data: {
        stripeCustomerId: row.customerId,
        stripeSubscriptionId: row.subscriptionId,
        ...membershipTierWrite(tier, { currentNextDueAt: firstChargeAt ?? new Date() }),
        ...(firstChargeAt ? { nextDueAt: firstChargeAt } : {}),
        ...(paymentStatus ? { paymentStatus } : {}),
      },
    });
    if (linked.count !== 1) throw new Error("Member was linked by something else first");
    // A tier matched by amount learns its price id, so the next member on
    // that price matches directly and self-subscribe can use it.
    if (row.tierMatchedBy === "amount" && !tier.stripePriceId && row.priceId) {
      await tx.membershipTier.updateMany({
        where: { id: tier.id, tenantId: tenant.id, stripePriceId: null },
        data: { stripePriceId: row.priceId },
      });
    }
  });
  await logAudit({
    tenantId: tenant.id,
    userId,
    action: "member.subscription.migrated",
    entityType: "Member",
    entityId: row.memberId,
    metadata: { mode: "adopt", stripeCustomerId: row.customerId, stripeSubscriptionId: row.subscriptionId, tierId: tier.id, firstChargeAt: row.firstChargeAt },
  });
}

async function createOne(
  stripe: Stripe,
  tenant: TenantForMigration,
  row: MigrationRow,
  tier: TierRow,
  userId: string | null,
): Promise<string> {
  if (!row.customerId || !row.paymentMethod || !row.firstChargeAt) {
    throw new Error("Row is not ready to create a subscription");
  }
  const anchor = new Date(row.firstChargeAt);
  if (anchor.getTime() < Date.now() + MIN_ANCHOR_LEAD_MS) {
    throw new Error("The first charge date is too soon to anchor a subscription to");
  }
  const priceId = await ensureTierPrice(stripe, { id: tenant.id, stripeAccountId: tenant.stripeAccountId! }, tier);

  const subscription = await stripe.subscriptions.create(
    {
      customer: row.customerId,
      items: [{ price: priceId }],
      default_payment_method: row.paymentMethod.id,
      // First charge on the member's existing due date, and nothing before it.
      billing_cycle_anchor: Math.floor(anchor.getTime() / 1000),
      proration_behavior: "none",
      collection_method: "charge_automatically",
      // The member is not present; Stripe may use the saved method off-session.
      off_session: true,
      payment_settings: {
        payment_method_types: [row.paymentMethod.type],
        save_default_payment_method: "on_subscription",
      },
      metadata: { matflowMemberId: row.memberId, matflowTenantId: tenant.id, matflowMigration: "1" },
    },
    // Keyed on the member, not the attempt: a retried click cannot mint a
    // second live subscription for the same person.
    { stripeAccount: tenant.stripeAccountId!, idempotencyKey: `matflow_migrate_${row.memberId}` },
  );

  await withTenantContext(tenant.id, async (tx) => {
    const linked = await tx.member.updateMany({
      where: { id: row.memberId, tenantId: tenant.id, stripeSubscriptionId: null },
      data: {
        stripeCustomerId: row.customerId,
        stripeSubscriptionId: subscription.id,
        ...membershipTierWrite(tier, { currentNextDueAt: anchor }),
        nextDueAt: anchor,
        paymentStatus: "paid",
        preferredPaymentMethod: row.paymentMethod!.type,
      },
    });
    if (linked.count !== 1) throw new Error(`Subscription ${subscription.id} created but the member was linked by something else first`);
  });
  await logAudit({
    tenantId: tenant.id,
    userId,
    action: "member.subscription.migrated",
    entityType: "Member",
    entityId: row.memberId,
    metadata: { mode: "create", stripeCustomerId: row.customerId, stripeSubscriptionId: subscription.id, tierId: tier.id, firstChargeAt: row.firstChargeAt, paymentMethod: row.paymentMethod.type },
  });
  return subscription.id;
}
