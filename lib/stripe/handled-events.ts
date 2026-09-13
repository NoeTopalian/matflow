/**
 * The Stripe events MatFlow actually handles.
 *
 * One list, because there were two and they had already drifted. The webhook
 * route and `lib/stripe/reconcile.ts` each kept a hand-copied copy under a
 * comment saying "keep in sync" — and `charge.dispute.closed` was in the
 * webhook's and missing from reconcile's, so a dropped dispute-resolution event
 * was invisible to the one job whose entire purpose is spotting dropped events.
 * A comment is not a mechanism.
 *
 * Membership matters in two distinct ways, and both are load-bearing:
 *
 *  * the webhook only CLAIMS the event id for types in this set. Claiming an
 *    unhandled type would permanently skip it if a future deploy added a
 *    handler, because the claim is already recorded and Stripe stops retrying
 *    after our 200;
 *  * reconciliation only reports a MISSING event for types in this set, since
 *    an unhandled type is legitimately absent from the ledger rather than
 *    dropped.
 *
 * So adding a type here without writing its handler turns every delivery of it
 * into a silent claimed-and-ignored no-op. Add the branch first.
 */
export const HANDLED_STRIPE_EVENT_TYPES = new Set<string>([
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
  "invoice.voided",
  "checkout.session.completed",
  // An abandoned cart used to sit "pending" for ever, and mark-paid accepted it.
  "checkout.session.expired",
  "payment_intent.processing",
  "payment_intent.succeeded",
  // Without this a failed ad-hoc charge stays "pending" in the ledger for ever —
  // there is no other event that resolves it.
  "payment_intent.payment_failed",
  "mandate.updated",
  "charge.refunded",
  "customer.deleted",
  "payment_method.detached",
  "charge.dispute.created",
  "charge.dispute.updated",
  // Terminal resolution — without it a dispute can stay "under_review" for ever.
  "charge.dispute.closed",
  "account.updated",
  // The gym revoked MatFlow's access from their own Stripe dashboard. Nothing
  // else tells us; the product would keep claiming it was connected.
  "account.application.deauthorized",
]);
