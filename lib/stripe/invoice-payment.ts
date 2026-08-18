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

    let paymentIntentId: string | null = null;
    for (const entry of invoice.payments?.data ?? []) {
      const intent = entry.payment?.payment_intent;
      if (typeof intent === "string") {
        paymentIntentId = intent;
        break;
      }
      if (intent && typeof intent === "object") {
        paymentIntentId = intent.id;
        break;
      }
    }

    if (!paymentIntentId) return NO_INVOICE_PAYMENT;

    // The charge id needs a second hop: InvoicePayment carries the intent, not
    // the charge. Kept outside any DB transaction by the caller.
    const intent = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      {},
      requestOptions,
    );
    const latestCharge = intent.latest_charge;
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
