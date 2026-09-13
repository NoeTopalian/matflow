/**
 * The ways a club can record a payment it took outside Stripe.
 *
 * One list, imported by the route that validates it and by every surface that
 * offers it, because they had already drifted: `app/api/payments/manual`
 * accepts `cash | exempt | external | comp | other`, `RecordPaymentModal` kept
 * its own copy of the same five, and the member profile's drawer posted
 * `method: "manual"` — a value nothing has ever accepted, so that surface
 * returned 400 on every attempt while the payments hub worked fine. Nobody
 * noticed precisely because the other surface worked.
 *
 * Adding a method here is the only change needed; the route's enum and the
 * pickers all follow.
 */

export const MANUAL_PAYMENT_METHODS = [
  { value: "cash", label: "Cash" },
  { value: "external", label: "Bank transfer / external" },
  { value: "comp", label: "Comp (free)" },
  { value: "exempt", label: "Exempt" },
  { value: "other", label: "Other" },
] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number]["value"];

/** The bare values, for the route's Zod enum. */
export const MANUAL_PAYMENT_METHOD_VALUES = MANUAL_PAYMENT_METHODS.map((m) => m.value) as unknown as [
  ManualPaymentMethod,
  ...ManualPaymentMethod[],
];

/**
 * Comp and exempt are the two that legitimately record £0 — they say "this
 * member owes nothing", not "this member paid nothing". Everything else needs a
 * real amount, or the ledger fills with zero-value rows that look like takings.
 */
export function isFreeMethod(method: string): boolean {
  return method === "comp" || method === "exempt";
}

/**
 * "Other" is the escape hatch, so it has to say what it was — otherwise the
 * audit trail records a payment of unknown provenance.
 */
export function methodNeedsNotes(method: string): boolean {
  return method === "other";
}

/**
 * Would the route accept this form as it stands?
 *
 * Lives here rather than in a component so the button's disabled state and the
 * server's `superRefine` are literally the same three rules. A drawer that
 * offers a submit the server is certain to refuse is how the member profile
 * spent its whole life posting an invalid method and showing the owner a
 * failure toast.
 */
export function manualPaymentFormIsValid(form: {
  description: string;
  amount: string;
  method: ManualPaymentMethod;
}): boolean {
  if (methodNeedsNotes(form.method) && !form.description.trim()) return false;
  if (isFreeMethod(form.method)) return true;
  const pence = Math.round((parseFloat(form.amount) || 0) * 100);
  return pence >= 1;
}
