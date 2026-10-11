import type { Prisma } from "@prisma/client";
import type { StripeKeyMode } from "@/lib/stripe/key-mode";

type TxClient = Prisma.TransactionClient;

/**
 * The verified member ↔ Stripe subscription mapping (payments lane PC, 11 Oct
 * 2026; audit §11, §13, §17).
 *
 * The webhook used to find "the member" by Stripe customer and let ANY
 * subscription or invoice on that customer move them. In the TeamUp replace
 * window one customer carries two live subscriptions, so TeamUp's could
 * re-point or cancel the member while MatFlow's replacement kept billing (F4),
 * and a late invoice.payment_failed overwrote a success (F5). The mapping is
 * the one record that says "this subscription is MatFlow's, for this member":
 * it is written only where MatFlow creates, migrates or adopts a subscription,
 * in the same transaction as the Stripe id, and never from a webhook payload.
 */

export type MappingSource = "app" | "migration" | "adopted";

export type SubscriptionMapping = {
  id: string;
  tenantId: string;
  memberId: string;
  stripeSubscriptionId: string;
  status: string;
  lastEventCreated: number | null;
  endedAt: Date | null;
  requiresActionInvoiceId?: string | null;
};

/** Statuses a Stripe subscription can never leave. */
const TERMINAL = new Set(["canceled", "incomplete_expired"]);

export function isTerminalSubscriptionStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL.has(status);
}

/**
 * Write (or confirm) the mapping row for a subscription MatFlow has just
 * created, migrated or adopted. Call it inside the same transaction that
 * stores the Stripe id on the member, BEFORE the member's pointer is set, so
 * the pointer is only ever set from a mapping row.
 *
 * Idempotent for a retried create (the same subscription for the same member
 * returns the existing row untouched — the mapping is immutable). A
 * subscription already mapped to a DIFFERENT member is refused: two members
 * must never be moved by one subscription's events.
 */
export async function recordSubscriptionMapping(
  tx: TxClient,
  input: {
    tenantId: string;
    memberId: string;
    stripeAccountId: string;
    stripeSubscriptionId: string;
    source: MappingSource;
    status: string;
    currentPeriodEnd: Date | null;
  },
): Promise<{ id: string }> {
  const row = await tx.memberSubscription.upsert({
    where: { stripeSubscriptionId: input.stripeSubscriptionId },
    create: {
      tenantId: input.tenantId,
      memberId: input.memberId,
      stripeAccountId: input.stripeAccountId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      source: input.source,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd,
    },
    update: {},
    select: { id: true, tenantId: true, memberId: true },
  });
  if (!row || row.tenantId !== input.tenantId || row.memberId !== input.memberId) {
    throw new Error(`Subscription ${input.stripeSubscriptionId} is already mapped to another member`);
  }
  return { id: row.id };
}

/**
 * The subscription an invoice belongs to. On the pinned API version
 * (2026-03-25.dahlia) the id lives at `parent.subscription_details.subscription`;
 * the top-level `subscription` field is read as a fallback for older payload
 * shapes only.
 */
export function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
  const fromParent = parent?.subscription_details?.subscription;
  if (typeof fromParent === "string") return fromParent;
  if (fromParent && typeof fromParent === "object" && typeof (fromParent as { id?: unknown }).id === "string") {
    return (fromParent as { id: string }).id;
  }
  const legacy = invoice.subscription;
  if (typeof legacy === "string") return legacy;
  return null;
}

/**
 * current_period_end moved from the subscription to its items in dahlia.
 * Read the first item's value, falling back to the old top-level field.
 */
export function subscriptionCurrentPeriodEnd(sub: Record<string, unknown>): Date | null {
  const items = (sub.items as { data?: Array<{ current_period_end?: unknown }> } | undefined)?.data ?? [];
  const fromItem = items.find((i) => typeof i.current_period_end === "number")?.current_period_end;
  const secs = typeof fromItem === "number" ? fromItem : typeof sub.current_period_end === "number" ? sub.current_period_end : null;
  return secs === null ? null : new Date(secs * 1000);
}

/**
 * Whether an event can be applied to a mapping without asking Stripe first.
 *
 * Stripe does not guarantee delivery order and `created` has one-second
 * granularity, so: an event strictly older than the last applied one is stale;
 * an event from the same second, or any event for a mapping that has never had
 * one applied (the backfilled rows), is decided by retrieving the subscription
 * fresh from the club's account.
 */
export function orderingVerdict(
  mapping: Pick<SubscriptionMapping, "lastEventCreated" | "status">,
  eventCreated: number | null | undefined,
): "stale" | "fetch_fresh" | "apply" {
  if (typeof eventCreated !== "number") return "fetch_fresh";
  if (mapping.lastEventCreated === null) return "fetch_fresh";
  if (eventCreated < mapping.lastEventCreated) return "stale";
  if (eventCreated === mapping.lastEventCreated) return "fetch_fresh";
  return "apply";
}

/**
 * A verified event must be of the same mode as the key this deployment runs
 * on: a production Connect endpoint receives BOTH live and test events, and
 * Stripe recommends checking `livemode` (docs/payments/evidence/S3 §12.4).
 * A key whose mode cannot be read, or an event with no boolean livemode, fails
 * closed.
 */
export function livemodeMatchesKey(livemode: unknown, keyMode: StripeKeyMode): boolean {
  if (typeof livemode !== "boolean") return false;
  if (keyMode === "unknown") return false;
  return livemode === (keyMode === "live");
}
