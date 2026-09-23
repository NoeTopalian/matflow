/**
 * How a Stripe subscription status reads as `Member.paymentStatus`, defined
 * once. The webhook's `customer.subscription.updated` branch and the migration
 * that adopts an existing subscription must agree, or a member could be
 * "overdue" on arrival and "paid" the moment Stripe next speaks.
 *
 * Returns `undefined` for a status this product does not map (`incomplete`,
 * `unpaid`) so callers can leave the column alone rather than guess.
 */
export function subscriptionStatusToPaymentStatus(
  status: string,
): "paid" | "overdue" | "paused" | "cancelled" | undefined {
  if (status === "active" || status === "trialing") return "paid";
  if (status === "past_due") return "overdue";
  if (status === "paused") return "paused";
  if (status === "canceled" || status === "incomplete_expired") return "cancelled";
  return undefined;
}

/** Statuses under which a subscription is still the member's live plan. */
export const LIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused"] as const;

export function isLiveSubscriptionStatus(status: string): boolean {
  return (LIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}
