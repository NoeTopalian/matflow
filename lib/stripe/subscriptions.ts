// Shared Stripe subscription helpers.
//
// Three creation surfaces in MatFlow today (F2 + F3 from the kids-billing
// plan):
//   - app/api/stripe/create-subscription (staff charging a member)
//   - app/api/member/subscriptions/start (member self-subscribe)
//   - app/api/member/subscriptions/start-for-kid (parent subscribing a kid)
//
// They all build the same Stripe call. This helper is the single source so
// the path that members touch is byte-identical to the path staff have been
// using since 2026-Q1 — same payment_behavior, same payment_settings, same
// race-safe customer-create logic. The caller's job is authorisation and
// loading the Member row; the helper handles the Stripe-side mechanics.

import { withTenantContext } from "@/lib/prisma-tenant";

export type StripeSubscriptionMember = {
  id: string;
  email: string;
  name: string;
  stripeCustomerId: string | null;
};

export type StripeSubscriptionTenant = {
  id: string;
  stripeAccountId: string;
  acceptsBacs: boolean;
};

export type CreateSubscriptionOutcome =
  | {
      ok: true;
      subscriptionId: string;
      /**
       * PaymentIntent client secret the client must confirm before the
       * subscription leaves `incomplete`. Non-nullable on purpose: a
       * subscription we cannot collect payment for is a failure, not a
       * success with a missing field. See the read path below.
       */
      clientSecret: string;
      customerId: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type CreateSubscriptionInput = {
  tenant: StripeSubscriptionTenant;
  member: StripeSubscriptionMember;
  priceId: string;
  paymentMethodType: "card" | "bacs_debit";
};

export async function createSubscriptionForMember(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionOutcome> {
  const { tenant, member, priceId, paymentMethodType } = input;

  if (paymentMethodType === "bacs_debit" && !tenant.acceptsBacs) {
    return { ok: false, status: 400, error: "Direct Debit is not enabled for this gym" };
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 503, error: "Stripe not configured" };
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia",
    });
    const stripeAccount = tenant.stripeAccountId;

    // Race-safe find-or-create. The compare-and-swap (updateMany WHERE
    // stripeCustomerId IS NULL) ensures only one concurrent caller wins the
    // assignment; the loser falls back to the winner's customer ID and
    // leaves one orphan Stripe customer behind (acceptable — one row per
    // losing race, not per request).
    let customerId = member.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: member.email, name: member.name },
        { stripeAccount },
      );
      const winnerId = await withTenantContext(tenant.id, async (tx) => {
        const u = await tx.member.updateMany({
          where: { id: member.id, stripeCustomerId: null },
          data: { stripeCustomerId: customer.id },
        });
        if (u.count === 1) return customer.id;
        const fresh = await tx.member.findUnique({
          where: { id: member.id },
          select: { stripeCustomerId: true },
        });
        return fresh?.stripeCustomerId ?? customer.id;
      });
      customerId = winnerId;
    }

    // Tier 3.10: the find-or-create above dedupes the CUSTOMER but not the
    // SUBSCRIPTION — two concurrent calls (double-click / client retry) would
    // otherwise create two live subscriptions and double-bill the member. A
    // Stripe idempotency key keyed on member+price+a 60s bucket collapses rapid
    // duplicates to one subscription, while still allowing a deliberate
    // re-subscribe after the window (e.g. a member who cancelled and returns).
    const subIdempotencyKey = `matflow_sub_${member.id}_${priceId}_${Math.floor(Date.now() / 60000)}`;
    const subscription = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: {
          payment_method_types: paymentMethodType === "bacs_debit" ? ["bacs_debit"] : ["card"],
          save_default_payment_method: "on_subscription",
        },
        // API version 2026-03-25.dahlia does NOT put a `payment_intent` on
        // Invoice — the field does not exist on the object at all. It carries
        // `confirmation_secret` instead, which holds the client_secret of the
        // PaymentIntent Stripe creates at invoice finalisation.
        //
        // Stripe accepts `latest_invoice.payment_intent` as an expand path
        // WITHOUT error and simply never populates it, so the old code read
        // undefined on every single call and handed the client a null secret.
        // Verified against test Connect account on 2026-08-18: with this
        // expand the invoice carries confirmation_secret.client_secret
        // (`pi_…_secret_…`), and that string is byte-identical to the
        // PaymentIntent's own client_secret — so the client-side
        // stripe.confirmPayment / confirmCardPayment contract is unchanged.
        //
        // The expand is REQUIRED: without it the invoice has no
        // confirmation_secret key at all (also verified).
        expand: ["latest_invoice.confirmation_secret"],
      },
      { stripeAccount, idempotencyKey: subIdempotencyKey },
    );

    // `latest_invoice` is `string | Stripe.Invoice | null` — narrow rather than
    // cast so the compiler checks the field actually exists on the pinned API
    // version. The previous `as { payment_intent?: … }` cast is what hid this
    // bug for the entire life of the feature: it invented a shape Stripe never
    // returns and TypeScript happily agreed.
    const invoice = subscription.latest_invoice;
    const clientSecret =
      invoice && typeof invoice === "object"
        ? invoice.confirmation_secret?.client_secret ?? null
        : null;

    // No secret means the client can never confirm the payment, so the
    // subscription would sit `incomplete` until Stripe expires it. Fail loudly
    // instead of reporting success with an unusable null.
    //
    // Deliberately BEFORE the member write: `hasActiveSubscription` is derived
    // from `!!member.stripeSubscriptionId`, so persisting here would show the
    // member an "Active" subscription that can never be paid. The orphaned
    // incomplete subscription is left for Stripe to auto-expire (~23h); it
    // cannot charge anyone in the meantime.
    if (!clientSecret) {
      console.error(
        "[stripe/subscriptions] no confirmation_secret on latest_invoice",
        JSON.stringify({
          subscriptionId: subscription.id,
          invoiceId: typeof invoice === "object" ? invoice?.id ?? null : invoice,
          memberId: member.id,
          tenantId: tenant.id,
        }),
      );
      return {
        ok: false,
        status: 502,
        error: "Couldn't set up payment for this subscription. Please try again, or speak to gym staff.",
      };
    }

    await withTenantContext(tenant.id, (tx) =>
      tx.member.update({
        where: { id: member.id },
        data: {
          stripeSubscriptionId: subscription.id,
          preferredPaymentMethod: paymentMethodType,
        },
      }),
    );

    return {
      ok: true,
      subscriptionId: subscription.id,
      clientSecret,
      customerId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe operation failed";
    return { ok: false, status: 500, error: message };
  }
}

// Cancel at end of current paid cycle. Per the deep-interview locked
// decision (2026-05-15): no refunds on self-cancel, the member keeps the
// access they already paid for. Stripe's cancel_at_period_end flag handles
// the actual rollover; our webhook handler flips Member.status to cancelled
// when the period closes.
export type CancelSubscriptionOutcome =
  | { ok: true; cancelAt: number | null }
  | { ok: false; status: number; error: string };

export async function cancelSubscriptionAtPeriodEnd(input: {
  tenant: { stripeAccountId: string };
  stripeSubscriptionId: string;
}): Promise<CancelSubscriptionOutcome> {
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ok: false, status: 503, error: "Stripe not configured" };
  }
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia",
    });
    const sub = await stripe.subscriptions.update(
      input.stripeSubscriptionId,
      { cancel_at_period_end: true },
      { stripeAccount: input.tenant.stripeAccountId },
    );
    // `cancel_at` IS still returned on 2026-03-25.dahlia — verified live
    // 2026-08-18 (came back as a unix timestamp alongside
    // cancel_at_period_end: true). Note for anyone extending this: the
    // subscription-level `current_period_end` was REMOVED in dahlia and now
    // lives on `sub.items.data[i].current_period_end`. Nothing reads it today.
    return { ok: true, cancelAt: sub.cancel_at ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe cancel failed";
    return { ok: false, status: 500, error: message };
  }
}
