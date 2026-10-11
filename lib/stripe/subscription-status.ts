/**
 * How a Stripe subscription status reads as `Member.paymentStatus`, defined
 * once. The webhook's `customer.subscription.updated` branch and the migration
 * that adopts an existing subscription must agree, or a member could be
 * "overdue" on arrival and "paid" the moment Stripe next speaks.
 *
 * Returns `undefined` for a status this product does not map (`incomplete`,
 * `unpaid`, `incomplete_expired`) so callers can leave the column alone rather
 * than guess.
 *
 * `incomplete_expired` used to map to "cancelled", and the webhook then
 * cancelled the whole member: an abandoned first payment on a new subscription
 * cancelled a person who might be paying at the desk (audit 11 Oct 2026, §11
 * and §16). It means only "this subscription never started": the webhook ends
 * that subscription's mapping and clears the member's pointer if it was the
 * active one, and the payment state it already had stays.
 *
 * The result is PAYMENT state only. Nothing here decides `Member.status` —
 * membership is MatFlow's (staff action), not Stripe's.
 */
export function subscriptionStatusToPaymentStatus(
  status: string,
): "paid" | "overdue" | "paused" | "cancelled" | undefined {
  if (status === "active" || status === "trialing") return "paid";
  if (status === "past_due") return "overdue";
  if (status === "paused") return "paused";
  if (status === "canceled") return "cancelled";
  return undefined;
}

/** Statuses under which a subscription is still the member's live plan. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused"] as const;

export function isLiveSubscriptionStatus(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}
