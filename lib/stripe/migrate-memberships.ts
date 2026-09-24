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

/**
 * REPLACE is the default for a member whose Stripe customer already carries a
 * live subscription, and it exists because of what cancelling in TeamUp does:
 * TeamUp created that subscription, so ending the membership there very likely
 * cancels the Stripe object too. Adopting it and then telling the owner to
 * "end it in TeamUp" would destroy the thing we adopted. So instead MatFlow
 * creates ITS OWN subscription anchored to the existing one's verified
 * `current_period_end` — the one date in the whole migration that is not an
 * estimate — and the owner ends the TeamUp membership straight away, which
 * removes TeamUp's subscription and nothing of ours. ADOPT is still available
 * behind `allowAdopt` for a platform that has confirmed it can hand a
 * subscription over without cancelling it.
 */
export type MigrationAction = "adopt" | "replace" | "create" | "skip";

export type MigrationReason =
  | "already_linked"
  | "on_hold"
  | "no_customer"
  | "needs_tier"
  | "ambiguous_tier"
  | "tier_mismatch"
  | "no_tier"
  | "tier_not_recurring"
  | "no_payment_method"
  | "bacs_not_enabled"
  | "no_due_date"
  | "due_date_past"
  | "period_end_too_soon";

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
  /** ISO. Adopt/replace: the existing subscription's current period end. Create: the member's confirmed due date. */
  firstChargeAt: string | null;
  /** Replace: the TeamUp-created subscription that the owner must now end in TeamUp. */
  replacesSubscriptionId: string | null;
  /** Already-linked members only: another live subscription still on the same customer (the old one not yet ended). */
  otherLiveSubscriptionId: string | null;
  /** tier_mismatch: what the member row says versus what the subscription bills. */
  memberTierName: string | null;
};

export type MigrationPreview = {
  rows: MigrationRow[];
  summary: {
    adopt: number;
    replace: number;
    create: number;
    skip: number;
    skippedByReason: Partial<Record<MigrationReason, number>>;
    /** Stripe customers with no member of this club on that email. */
    unmatchedCustomers: number;
    firstChargeDates: string[];
    /** Linked members whose customer still carries a second live subscription — TeamUp's, not yet ended. */
    oldSubscriptionsStillLive: number;
  };
};

export type MigrationOutcome =
  | { memberId: string; outcome: "adopted" | "replaced" | "created" | "would_adopt" | "would_replace" | "would_create"; subscriptionId: string | null; firstChargeAt: string | null; replacesSubscriptionId?: string | null }
  | { memberId: string; outcome: "skipped"; reason: MigrationReason }
  | { memberId: string; outcome: "error"; message: string };

export type MigrationOptions = {
  /** Only when the previous platform has confirmed it hands subscriptions over without cancelling them. */
  allowAdopt?: boolean;
};

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
  paymentStatus: string;
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
        id: true, name: true, email: true, status: true, paymentStatus: true,
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

/** The payment method a replacement subscription should bill: the old subscription's own, else the customer's default, else any attached card. */
async function paymentMethodForReplacement(
  stripe: Stripe,
  stripeAccountId: string,
  customer: CustomerLite,
  sub: Stripe.Subscription,
): Promise<MigrationPaymentMethod | null> {
  const subPm = sub.default_payment_method;
  if (subPm && typeof subPm === "object") {
    const d = describePaymentMethod(subPm);
    if (d) return d;
  } else if (typeof subPm === "string") {
    if (customer.defaultPaymentMethod?.id === subPm) {
      const d = describePaymentMethod(customer.defaultPaymentMethod);
      if (d) return d;
    } else {
      const pm = await stripe.paymentMethods.retrieve(subPm, {}, { stripeAccount: stripeAccountId });
      const d = describePaymentMethod(pm);
      if (d) return d;
    }
  }
  return findUsablePaymentMethod(stripe, stripeAccountId, customer);
}

async function classifyMember(
  stripe: Stripe,
  tenant: TenantForMigration,
  tiers: TierRow[],
  member: MemberRow,
  customer: CustomerLite | undefined,
  now: Date,
  options: MigrationOptions,
): Promise<MigrationRow> {
  const memberTier = member.membershipTierId ? tiers.find((t) => t.id === member.membershipTierId) ?? null : null;
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
    replacesSubscriptionId: null,
    otherLiveSubscriptionId: null,
    memberTierName: memberTier?.name ?? null,
  };

  if (member.stripeSubscriptionId) {
    // Post-cutover check: is the old (TeamUp) subscription still alive beside ours?
    const other = customer?.subscriptions.find((s) => s.id !== member.stripeSubscriptionId && isLiveSubscriptionStatus(s.status)) ?? null;
    return skipRow({ ...base, subscriptionId: member.stripeSubscriptionId, otherLiveSubscriptionId: other?.id ?? null }, "already_linked");
  }
  // A member on hold is not billed by anyone right now; moving them would
  // either resume billing or pause a subscription we have just created. The
  // owner resumes the hold first (or handles them by hand), then re-runs.
  if (member.paymentStatus === "paused") return skipRow(base, "on_hold");
  if (!customer) return skipRow(base, "no_customer");

  const sub = pickLiveSubscription(customer);
  if (sub) {
    const price = sub.items?.data?.[0]?.price;
    if (!price) return skipRow({ ...base, subscriptionId: sub.id, subscriptionStatus: sub.status }, "needs_tier");
    const cycle = cycleFromStripeRecurring(price.recurring);
    const periodEnd = periodEndOf(sub);
    const withPrice = {
      ...base,
      subscriptionId: sub.id,
      subscriptionStatus: sub.status,
      priceId: price.id,
      amountPence: price.unit_amount,
      currency: price.currency.toUpperCase(),
      cycle,
      cycleLabel: cycle ? cycleLabel(cycle) : null,
      firstChargeAt: periodEnd?.toISOString() ?? null,
    };
    const match = matchTierToPrice(tiers, price, cycle);
    if ("reason" in match) return skipRow(withPrice, match.reason);
    // The member row's own tier (from the import) must agree with what the
    // subscription actually bills — a disagreement is reviewed, never guessed.
    if (memberTier && memberTier.id !== match.tier.id) {
      return skipRow({ ...withPrice, tierId: match.tier.id, tierName: match.tier.name, tierMatchedBy: match.by }, "tier_mismatch");
    }
    const matched = { ...withPrice, tierId: match.tier.id, tierName: match.tier.name, tierMatchedBy: match.by };

    if (options.allowAdopt) {
      return { ...matched, action: "adopt", reason: null };
    }

    // Replace at period end: our subscription starts exactly where the
    // existing one's current period ends, on the same payment method.
    if (!periodEnd || periodEnd.getTime() < now.getTime() + MIN_ANCHOR_LEAD_MS) {
      return skipRow(matched, "period_end_too_soon");
    }
    const pm = await paymentMethodForReplacement(stripe, tenant.stripeAccountId!, customer, sub);
    if (!pm) return skipRow(matched, "no_payment_method");
    if (pm.type === "bacs_debit" && !tenant.acceptsBacs) return skipRow({ ...matched, paymentMethod: pm }, "bacs_not_enabled");
    return {
      ...matched,
      action: "replace",
      reason: null,
      paymentMethod: pm,
      // The row's subscriptionId is what we create; the old one is what the owner ends.
      subscriptionId: null,
      replacesSubscriptionId: sub.id,
    };
  }

  // No live subscription: create one on the saved payment method.
  const tier = memberTier;
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
  let adopt = 0, replace = 0, create = 0, skip = 0, oldSubscriptionsStillLive = 0;
  const dates = new Set<string>();
  for (const r of rows) {
    if (r.action === "adopt") adopt += 1;
    else if (r.action === "replace") replace += 1;
    else if (r.action === "create") create += 1;
    else {
      skip += 1;
      if (r.reason) skippedByReason[r.reason] = (skippedByReason[r.reason] ?? 0) + 1;
      if (r.otherLiveSubscriptionId) oldSubscriptionsStillLive += 1;
    }
    if (r.action !== "skip" && r.firstChargeAt) dates.add(r.firstChargeAt.slice(0, 10));
  }
  return { adopt, replace, create, skip, skippedByReason, unmatchedCustomers, firstChargeDates: [...dates].sort(), oldSubscriptionsStillLive };
}

export async function previewMigration(
  stripe: Stripe,
  tenantId: string,
  now: Date = new Date(),
  options: MigrationOptions = {},
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
    rows.push(await classifyMember(stripe, tenant, tiers, member, customer, now, options));
  }
  const unmatched = customers.filter((c) => !matchedCustomerIds.has(c.id)).length;
  return { rows, summary: summarise(rows, unmatched) };
}

export async function applyMigration(
  stripe: Stripe,
  tenantId: string,
  memberIds: string[],
  opts: { dryRun: boolean; userId: string | null; now?: Date } & MigrationOptions,
): Promise<MigrationOutcome[]> {
  const now = opts.now ?? new Date();
  // Never trust a client-supplied plan: recompute, then act only on the rows
  // the owner named AND that still classify as actionable.
  const preview = await previewMigration(stripe, tenantId, now, { allowAdopt: opts.allowAdopt });
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
        outcome: row.action === "adopt" ? "would_adopt" : row.action === "replace" ? "would_replace" : "would_create",
        subscriptionId: row.subscriptionId,
        firstChargeAt: row.firstChargeAt,
        replacesSubscriptionId: row.replacesSubscriptionId,
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
        outcomes.push({
          memberId: row.memberId,
          outcome: row.action === "replace" ? "replaced" : "created",
          subscriptionId,
          firstChargeAt: row.firstChargeAt,
          replacesSubscriptionId: row.replacesSubscriptionId,
        });
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
  const opts = { stripeAccount: tenant.stripeAccountId! };

  // Durable recovery. The idempotency key below protects a retried click,
  // but Stripe keeps keys for only about a day: if a previous apply created
  // the subscription and then died before the member row was linked, a
  // retry a day later would mint a second one. The subscription itself
  // carries the member id in its metadata, so look for it first and reuse it.
  const existing = await stripe.subscriptions.list({ customer: row.customerId, status: "all", limit: 20 }, opts);
  const recovered = existing.data.find(
    (s) => s.metadata?.matflowMemberId === row.memberId && s.status !== "canceled" && s.status !== "incomplete_expired",
  );

  const subscription =
    recovered ??
    (await stripe.subscriptions.create(
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
        metadata: {
          matflowMemberId: row.memberId,
          matflowTenantId: tenant.id,
          matflowMigration: "1",
          ...(row.replacesSubscriptionId ? { matflowReplaces: row.replacesSubscriptionId } : {}),
        },
      },
      // Keyed on the member, not the attempt: a retried click cannot mint a
      // second live subscription for the same person.
      { ...opts, idempotencyKey: `matflow_migrate_${row.memberId}` },
    ));

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
    metadata: {
      mode: row.action === "replace" ? "replace" : "create",
      stripeCustomerId: row.customerId,
      stripeSubscriptionId: subscription.id,
      replacesSubscriptionId: row.replacesSubscriptionId,
      recovered: Boolean(recovered),
      tierId: tier.id,
      firstChargeAt: row.firstChargeAt,
      paymentMethod: row.paymentMethod.type,
    },
  });
  return subscription.id;
}
