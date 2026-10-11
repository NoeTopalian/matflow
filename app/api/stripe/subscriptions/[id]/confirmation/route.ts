// GET /api/stripe/subscriptions/[id]/confirmation
//
// Payments lane PB (11 Oct 2026), audit F1: hands the browser what Stripe.js
// needs to confirm a MatFlow subscription's first payment on the club's own
// connected account — the PaymentIntent client secret and the connected
// account id (direct charges: Stripe.js must be loaded with `stripeAccount`).
//
// Used for the first confirmation AND for "Resume": the secret is re-read from
// Stripe each time, so a payer who closed the form, or whose card was
// declined, carries on with the SAME PaymentIntent.
//
// Only for a subscription MatFlow mapped (lane PC's MemberSubscription) that
// Stripe still reports `incomplete`. Anything else answers 409 with a `state`
// and no secret:
//   ended         — the mapping ended (incomplete_expired / canceled): start again
//   already_paid  — Stripe reports the subscription live; nothing to pay
//   not_payable   — any other Stripe status (past_due, unpaid, paused…)
// Callers: staff of the club, the member, or the member's confirmed guardian
// (lib/stripe/subscription-payer.ts); anyone else gets 404.
//
// Reads only. Never writes Member.status, paymentStatus or the mapping: those
// move through the webhook (lane PC) when Stripe reports the payment.

import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { clubAccountOrRefusal } from "@/lib/stripe/club-account";
import { resolveSubscriptionPayer } from "@/lib/stripe/subscription-payer";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  const access = await resolveSubscriptionPayer(session, id);
  if (!access.ok) return json({ error: access.error }, access.status);
  const { mapping, audience, tenantId } = access;

  if (mapping.endedAt || mapping.status === "incomplete_expired" || mapping.status === "canceled") {
    return json(
      {
        state: "ended",
        error:
          "This sign-up expired before the first payment was made, so nothing was taken. Start the membership again to pay.",
      },
      409,
    );
  }

  // Payments lane PA: the first payment is money in, so the club's account must
  // be connected, verifiable and able to take charges.
  const club = await clubAccountOrRefusal(tenantId, "subscription_start", { audience });
  if (!club.ok) return club.response;
  const stripeAccount = club.account.stripeAccountId;

  // The subscription lives on the account it was created on. If the club has
  // since connected a different account, this one cannot be paid from here.
  if (mapping.stripeAccountId !== stripeAccount) {
    return json(
      {
        state: "not_payable",
        error:
          audience === "staff"
            ? "This sign-up was made on a Stripe account the club is no longer connected to. Start the membership again."
            : "This sign-up can no longer be paid here. Please speak to the gym.",
      },
      409,
    );
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return json({ error: "Card payments are not available right now." }, 503);

  let subscription: {
    status: string;
    latest_invoice: unknown;
  };
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(secretKey, { apiVersion: "2026-03-25.dahlia" });
    subscription = (await stripe.subscriptions.retrieve(
      mapping.stripeSubscriptionId,
      // dahlia: the invoice carries confirmation_secret (not payment_intent);
      // it is only present when expanded (lib/stripe/subscriptions.ts).
      { expand: ["latest_invoice.confirmation_secret"] },
      { stripeAccount },
    )) as unknown as typeof subscription;
  } catch (err) {
    console.error("[stripe/subscriptions/confirmation] retrieve failed", {
      tenantId,
      subscriptionId: mapping.stripeSubscriptionId,
      message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Couldn't reach Stripe to load the payment form. Please try again." }, 502);
  }

  if (subscription.status === "active" || subscription.status === "trialing") {
    return json({ state: "already_paid", subscriptionStatus: subscription.status }, 409);
  }
  if (subscription.status === "incomplete_expired" || subscription.status === "canceled") {
    return json(
      {
        state: "ended",
        error:
          "This sign-up expired before the first payment was made, so nothing was taken. Start the membership again to pay.",
      },
      409,
    );
  }
  if (subscription.status !== "incomplete") {
    return json(
      {
        state: "not_payable",
        subscriptionStatus: subscription.status,
        error: "There is no first payment to take for this membership.",
      },
      409,
    );
  }

  const invoice =
    subscription.latest_invoice && typeof subscription.latest_invoice === "object"
      ? (subscription.latest_invoice as {
          id?: string;
          amount_due?: number;
          currency?: string;
          confirmation_secret?: { client_secret?: string | null } | null;
        })
      : null;
  const clientSecret = invoice?.confirmation_secret?.client_secret ?? null;
  if (!invoice || !clientSecret) {
    console.error("[stripe/subscriptions/confirmation] no confirmation_secret on latest_invoice", {
      tenantId,
      subscriptionId: mapping.stripeSubscriptionId,
    });
    return json({ error: "Couldn't load the payment form for this membership. Please try again." }, 502);
  }

  return json({
    state: "requires_payment",
    clientSecret,
    stripeAccount,
    invoiceId: invoice.id ?? null,
    amountDue: typeof invoice.amount_due === "number" ? invoice.amount_due : null,
    currency: typeof invoice.currency === "string" ? invoice.currency.toUpperCase() : null,
  });
}
