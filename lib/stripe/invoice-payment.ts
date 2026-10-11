import type Stripe from "stripe";

export type InvoicePaymentIds = {
  paymentIntentId: string | null;
  chargeId: string | null;
};

export const NO_INVOICE_PAYMENT: InvoicePaymentIds = {
  paymentIntentId: null,
  chargeId: null,
};

/**
 * Resolve the PaymentIntent + Charge behind an invoice (P0-1).
 *
 * On the pinned API version (2026-03-25.dahlia) the Invoice object has NO
 * `charge` field and NO `payment_intent` field. This is not a docs reading —
 * it was verified against live test mode on a fully PAID invoice
 * (`status: "paid"`, `amount_paid: 3300`):
 *
 *     inv.charge         -> undefined
 *     inv.payment_intent -> undefined
 *     inv.payments[0].payment -> { payment_intent: "pi_…", type: "payment_intent" }
 *
 * The webhook previously read those two non-existent fields through
 * `Record<string, unknown>` casts. A cast to `unknown` silences the one check
 * that would have caught this, so the reads compiled, returned `undefined`,
 * and every subscription payment was written with null Stripe ids — leaving
 * `charge.refunded`, `invoice.voided` and dispute linking with nothing to
 * match on.
 *
 * Returns nulls rather than throwing: a webhook that cannot resolve the ids
 * must still record the payment and ack, or Stripe retries forever. The caller
 * gets the same shape either way and the failure is logged.
 */
export async function resolveInvoicePaymentIds(
  stripe: Stripe,
  invoiceId: string,
  stripeAccount: string,
): Promise<InvoicePaymentIds> {
  const requestOptions = { stripeAccount };
  try {
    const invoice = await stripe.invoices.retrieve(
      invoiceId,
      { expand: ["payments"] },
      requestOptions,
    );

    // `invoice.payments` is ordered NEWEST-FIRST and can carry entries in
    // non-paid states (a `canceled` attempt still has a payment_intent). Taking
    // the first entry blindly therefore risks recording a cancelled or
    // superseded attempt against a paid invoice — on a split-paid invoice that
    // stores an id worth less than amount_paid, and a later full refund is then
    // rejected by Stripe. Prefer a paid entry; fall back to the newest only if
    // none is paid.
    const entries = invoice.payments?.data ?? [];
    const preferred = entries.find((e) => e.status === "paid") ?? entries[0];

    const intent = preferred?.payment?.payment_intent;
    const paymentIntentId =
      typeof intent === "string" ? intent : (intent?.id ?? null);

    if (!paymentIntentId) return NO_INVOICE_PAYMENT;

    // The charge id needs a second hop: InvoicePayment carries the intent, not
    // the charge. Kept outside any DB transaction by the caller.
    const paymentIntent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {},
      requestOptions,
    );
    const latestCharge = paymentIntent.latest_charge;
    const chargeId =
      typeof latestCharge === "string" ? latestCharge : (latestCharge?.id ?? null);

    return { paymentIntentId, chargeId };
  } catch (err) {
    console.error("[stripe-webhook] could not resolve invoice payment ids", {
      invoiceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NO_INVOICE_PAYMENT;
  }
}

/**
 * Resolve the customer behind a `mandate.updated` event (P1-5b).
 *
 * The Mandate object has NO `customer` field — `Stripe.Mandate["customer"]` is
 * a type error against the pinned SDK, which is how this was found. The webhook
 * read `obj.customer`, always got `undefined`, and so never located a member:
 * the BACS mandate-failure path has never fired. Mandate does carry
 * `payment_method`, and that PaymentMethod carries the customer.
 *
 * Returns null rather than throwing, for the same reason as above: the webhook
 * must still ack.
 */
export async function resolveMandateCustomerId(
  stripe: Stripe,
  paymentMethodId: string,
  stripeAccount: string,
): Promise<string | null> {
  try {
    const method = await stripe.paymentMethods.retrieve(
      paymentMethodId,
      {},
      { stripeAccount },
    );
    const customer = method.customer;
    if (typeof customer === "string") return customer;
    return customer?.id ?? null;
  } catch (err) {
    console.error("[stripe-webhook] could not resolve mandate customer", {
      paymentMethodId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The subscriptions on a customer that collect through one payment method
 * (lane PC, 11 Oct 2026). A `mandate.updated` going inactive concerns the
 * payment method, not the customer: in the TeamUp replace window the same
 * customer can also carry another platform's subscription. The webhook maps
 * the returned ids through MemberSubscription and acts only on MatFlow's.
 *
 * A subscription with no default payment method of its own collects through
 * the customer's invoice default; it is matched only when that default is the
 * same method. Returns [] rather than throwing, for the same reason as above.
 */
export async function resolveSubscriptionsUsingPaymentMethod(
  stripe: Stripe,
  customerId: string,
  paymentMethodId: string,
  stripeAccount: string,
): Promise<string[]> {
  const idOf = (v: unknown): string | null =>
    typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;
  try {
    const subs = await stripe.subscriptions.list(
      { customer: customerId, status: "all", limit: 100, expand: ["data.customer"] },
      { stripeAccount },
    );
    return subs.data
      .filter((s) => {
        const own = idOf(s.default_payment_method);
        if (own) return own === paymentMethodId;
        const customer = s.customer as unknown as { invoice_settings?: { default_payment_method?: unknown } } | string;
        const fallback = typeof customer === "object" ? idOf(customer.invoice_settings?.default_payment_method) : null;
        return fallback === paymentMethodId;
      })
      .map((s) => s.id);
  } catch (err) {
    console.error("[stripe-webhook] could not list subscriptions for a mandate's payment method", {
      customerId,
      paymentMethodId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
