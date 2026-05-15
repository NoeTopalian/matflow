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
      clientSecret: string | null;
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

    const subscription = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: {
          payment_method_types: paymentMethodType === "bacs_debit" ? ["bacs_debit"] : ["card"],
          save_default_payment_method: "on_subscription",
        },
        expand: ["latest_invoice.payment_intent"],
      },
      { stripeAccount },
    );

    await withTenantContext(tenant.id, (tx) =>
      tx.member.update({
        where: { id: member.id },
        data: {
          stripeSubscriptionId: subscription.id,
          preferredPaymentMethod: paymentMethodType,
        },
      }),
    );

    const invoice = subscription.latest_invoice as
      | { payment_intent?: { client_secret?: string } }
      | null;

    return {
      ok: true,
      subscriptionId: subscription.id,
      clientSecret: invoice?.payment_intent?.client_secret ?? null,
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
    return { ok: true, cancelAt: sub.cancel_at ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stripe cancel failed";
    return { ok: false, status: 500, error: message };
  }
}
