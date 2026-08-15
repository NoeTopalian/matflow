import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { sendEmail } from "@/lib/email";

// Per-tenant cap on refund operations. Caps both fat-finger UI mistakes
// and a hostile insider scripting refunds en masse if their session were
// hijacked. 30 in 5 minutes is well above any plausible legitimate burst.
const REFUND_LIMIT_MAX = 30;
const REFUND_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const schema = z.object({
  amountPence: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
  // Required when the payment is a subscription invoice (stripeInvoiceId set):
  // refunding money without deciding the subscription's fate leaves the member
  // billed again next cycle. Explicit choice, no silent default.
  subscriptionAction: z.enum(["refund_only", "cancel_at_period_end", "cancel_now"]).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Defence-in-depth: same-origin check before any work. Financial mutation
  // is the highest-value CSRF target on the staff surface.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { tenantId, userId } = await requireOwner();
  const { id } = await params;

  const rl = await checkRateLimit(
    `payment-refund:${tenantId}`,
    REFUND_LIMIT_MAX,
    REFUND_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many refund attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const { payment, tenant, member } = await withTenantContext(tenantId, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id, tenantId } });
    const t = p
      ? await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { stripeAccountId: true, name: true },
        })
      : null;
    const m = p?.memberId
      ? await tx.member.findFirst({
          where: { id: p.memberId, tenantId },
          select: { id: true, name: true, email: true, stripeSubscriptionId: true },
        })
      : null;
    return { payment: p, tenant: t, member: m };
  });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  // Partial refunds may repeat until the charge is exhausted — the old
  // status-based 409 permanently locked the remainder after the first partial.
  const alreadyRefundedLocal = payment.refundedAmountPence ?? 0;
  const remainingPence = payment.amountPence - alreadyRefundedLocal;
  if (remainingPence <= 0) {
    return NextResponse.json({ error: "Already fully refunded" }, { status: 409 });
  }
  if (!payment.stripeChargeId && !payment.stripePaymentIntentId) {
    return NextResponse.json({ error: "No Stripe charge to refund" }, { status: 400 });
  }
  if (!tenant?.stripeAccountId) return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  if (parsed.data.amountPence && parsed.data.amountPence > remainingPence) {
    return NextResponse.json(
      { error: `Refund amount cannot exceed the ${remainingPence} pence remaining on this charge (${alreadyRefundedLocal} already refunded).` },
      { status: 400 },
    );
  }

  // Subscription payments need an explicit decision about the subscription.
  const isSubscriptionPayment = !!payment.stripeInvoiceId;
  const subscriptionAction = parsed.data.subscriptionAction ?? null;
  if (isSubscriptionPayment && !subscriptionAction) {
    return NextResponse.json(
      {
        error: "This payment is a subscription invoice — choose what happens to the subscription (refund only, cancel at period end, or cancel now).",
        requiresSubscriptionAction: true,
      },
      { status: 400 },
    );
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    const stripeAccount = tenant.stripeAccountId;
    if (payment.stripeChargeId) {
      const charge = await stripe.charges.retrieve(payment.stripeChargeId, {}, { stripeAccount });
      const alreadyRefunded = charge.amount_refunded ?? 0;
      const requestedAmount = parsed.data.amountPence ?? payment.amountPence;
      if (alreadyRefunded + requestedAmount > payment.amountPence) {
        const remaining = payment.amountPence - alreadyRefunded;
        return NextResponse.json(
          { error: `Cannot refund — only ${remaining} pence remaining (already refunded ${alreadyRefunded}).` },
          { status: 400 },
        );
      }
    }

    // Idempotency key keyed on payment.id + amount + cumulative-so-far:
    // Stripe's dedup means two parallel requests with the same key return the
    // same refund object instead of issuing two refunds, while successive
    // legitimate partials (same amount, different cumulative position) get
    // distinct keys instead of silently replaying the first refund.
    const refundAmount = parsed.data.amountPence ?? remainingPence;
    const idempotencyKey = `matflow_refund_${payment.id}_${refundAmount}_${alreadyRefundedLocal}`;
    const refund = await stripe.refunds.create(
      {
        ...(payment.stripePaymentIntentId ? { payment_intent: payment.stripePaymentIntentId } : { charge: payment.stripeChargeId! }),
        ...(parsed.data.amountPence ? { amount: parsed.data.amountPence } : {}),
        // Stripe's `reason` only accepts the enum duplicate|fraudulent|
        // requested_by_customer. The owner's free-text reason is preserved in
        // refund metadata (visible in the Stripe dashboard) and the audit log.
        reason: "requested_by_customer",
        metadata: {
          paymentId: payment.id,
          ...(parsed.data.reason ? { note: parsed.data.reason } : {}),
        },
      },
      { stripeAccount: tenant.stripeAccountId, idempotencyKey },
    );

    const refundedAmount = refund.amount ?? parsed.data.amountPence ?? remainingPence;
    const newRefundedTotal = alreadyRefundedLocal + refundedAmount;
    const fullyRefunded = newRefundedTotal >= payment.amountPence;

    // Subscription fate — decided explicitly by the owner above. Executed
    // before the DB write so the ledger update and the audit log can record
    // what actually happened. Failure here must not lose the refund: we
    // record it and surface the miss to the caller instead of throwing.
    let subscriptionOutcome: string | null = null;
    if (isSubscriptionPayment && subscriptionAction && subscriptionAction !== "refund_only") {
      const subId = member?.stripeSubscriptionId;
      if (!subId) {
        subscriptionOutcome = "no_active_subscription";
      } else {
        try {
          if (subscriptionAction === "cancel_now") {
            await stripe.subscriptions.cancel(subId, undefined, { stripeAccount });
            subscriptionOutcome = "cancelled_now";
          } else {
            await stripe.subscriptions.update(subId, { cancel_at_period_end: true }, { stripeAccount });
            subscriptionOutcome = "cancels_at_period_end";
          }
        } catch (subErr) {
          console.error("[payments/refund] refund succeeded but subscription action failed", {
            paymentId: payment.id, subId, subscriptionAction, error: subErr,
          });
          subscriptionOutcome = "subscription_action_failed";
        }
      }
    } else if (isSubscriptionPayment) {
      subscriptionOutcome = "kept";
    }

    // Stripe refund has SUCCEEDED at this point. Local DB writes must not
    // drift from Stripe's view; wrap the ledger update inside withTenantContext
    // so any future write added to this flow stays atomic with the status flip.
    // Also: if this payment funded a class-pack purchase, void any unredeemed
    // credits — matches the dispute-lost handler in app/api/stripe/webhook so
    // owner-initiated refunds don't leave members with paid-then-refunded
    // credits they can still spend.
    let packVoided = false;
    try {
      await withTenantContext(tenantId, async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            // Status flips to "refunded" only when the charge is exhausted —
            // a partial leaves it "succeeded" so the remainder stays
            // refundable (the CHECK constraint has no partial value; partial
            // state rides refundedAmountPence).
            ...(fullyRefunded ? { status: "refunded" } : {}),
            refundedAt: new Date(),
            refundedAmountPence: newRefundedTotal,
          },
        });
        if (payment.stripePaymentIntentId) {
          const fundedPack = await tx.memberClassPack.findUnique({
            where: { stripePaymentIntentId: payment.stripePaymentIntentId },
          });
          if (fundedPack && fundedPack.status === "active") {
            await tx.memberClassPack.update({
              where: { id: fundedPack.id },
              data: { status: "refunded", creditsRemaining: 0 },
            });
            packVoided = true;
            console.warn(
              `[payments/refund] voided MemberClassPack ${fundedPack.id} ` +
              `(member=${fundedPack.memberId}, paymentIntentId=${payment.stripePaymentIntentId})`,
            );
          }
        }
      });
    } catch (dbError) {
      // Stripe refunded but our DB didn't. Log the refund ID so the operator
      // can reconcile manually, and surface it to the caller. The
      // `charge.refunded` webhook handler is the eventual-consistency
      // backstop (matches by stripeChargeId), but we must not return 200.
      console.error(
        "[payments/refund] CRITICAL: Stripe refund succeeded but DB sync failed. Manual reconciliation needed.",
        { stripeRefundId: refund.id, paymentId: payment.id, tenantId, error: dbError },
      );
      return NextResponse.json(
        {
          ok: false,
          error: "Refund processed at Stripe but local sync failed; the webhook will reconcile shortly.",
          stripeRefundId: refund.id,
        },
        { status: 500 },
      );
    }

    await logAudit({
      tenantId,
      userId,
      action: "payment.refund",
      entityType: "Payment",
      entityId: payment.id,
      metadata: {
        stripeRefundId: refund.id,
        amountPence: refundedAmount,
        cumulativeRefundedPence: newRefundedTotal,
        fullyRefunded,
        reason: parsed.data.reason ?? null,
        packVoided,
        subscriptionOutcome,
      },
      req,
    });

    // Tell the member — Stripe's own receipt is only sent if the gym enabled
    // it, so this is often the only notification they get. Fire-and-forget.
    if (member?.email) {
      const symbol = payment.currency?.toUpperCase() === "USD" ? "$" : payment.currency?.toUpperCase() === "EUR" ? "€" : "£";
      const subscriptionNote =
        subscriptionOutcome === "cancelled_now"
          ? "Your membership subscription has been cancelled with immediate effect."
          : subscriptionOutcome === "cancels_at_period_end"
            ? "Your membership subscription will end at the close of the current billing period."
            : "";
      sendEmail({
        tenantId,
        templateId: "refund_processed",
        to: member.email,
        vars: {
          memberName: member.name,
          gymName: tenant.name ?? "your gym",
          amount: `${symbol}${(refundedAmount / 100).toFixed(2)}`,
          subscriptionNote,
        },
      }).catch((e) => console.error("[payments/refund] member email failed", e));
    }

    return NextResponse.json({
      ok: true,
      stripeRefundId: refund.id,
      amountPence: refundedAmount,
      cumulativeRefundedPence: newRefundedTotal,
      remainingPence: payment.amountPence - newRefundedTotal,
      fullyRefunded,
      packVoided,
      subscriptionOutcome,
    });
  } catch (e) {
    // Surface caller-fixable Stripe errors (already refunded, charge disputed,
    // card declined, rate limited) with their actual message + a 4xx, instead
    // of an opaque 500. Genuine server/Stripe-outage faults still 500.
    const se = e as { type?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
    const isStripeError = typeof se?.type === "string" && se.type.startsWith("Stripe");
    if (isStripeError && typeof se.statusCode === "number" && se.statusCode >= 400 && se.statusCode < 500) {
      return NextResponse.json(
        {
          error: typeof se.message === "string" ? se.message : "Stripe rejected the refund.",
          code: typeof se.code === "string" ? se.code : null,
        },
        { status: se.statusCode },
      );
    }
    return apiError("Payment processing failed", 500, e, "[payments/refund]");
  }
}
