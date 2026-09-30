/**
 * The words for `Member.paymentStatus`, defined once.
 *
 * The members list, the member profile, the family card and the member app
 * each carried their own copy of this map, and each said "Pending" for the
 * state a desk-created member now starts in. The owner's word for it is
 * "No payment yet" (decision 1, 30 Sep 2026): a member the desk has added and
 * nobody has recorded a payment against. Pure, so a client component can use
 * it.
 *
 * `paused` stays "Paused" here; the hold wording ("On hold") is a status tag
 * elsewhere, not a payment label.
 */
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  overdue: "Overdue",
  pending: "No payment yet",
  paused: "Paused",
  free: "Free",
  cancelled: "Cancelled",
};

/** The label for a stored or derived payment status; unknown values are title-cased. */
export function paymentStatusLabel(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (!s) return "—";
  return PAYMENT_STATUS_LABEL[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What a member created at the desk starts as. A free plan (a tier priced at
 * nothing) is "free"; anything else is "pending" — "No payment yet" — until
 * the desk records a payment, which moves it to "paid"
 * (app/api/payments/manual). Members TeamUp bills keep what the import gives
 * them and never come through here.
 */
export function initialDeskPaymentStatus(tier: { pricePence?: number | null } | null | undefined): "free" | "pending" {
  return tier && tier.pricePence === 0 ? "free" : "pending";
}
