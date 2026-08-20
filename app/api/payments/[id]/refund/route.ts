import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner } from "@/lib/api-authz";
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

// Money that reaches a human is money, not pence. Audit money-path P1-3: both
// over-refund errors below quoted raw integers ("only 3000 pence remaining"),
// and the route carried a second copy of this symbol logic for the refund
// email. One helper, British English, always 2dp.
function formatMoney(pence: number, currency?: string | null): string {
  const code = (currency ?? "GBP").toUpperCase();
  const symbol = code === "USD" ? "$" : code === "EUR" ? "€" : "£";
  return `${symbol}${(pence / 100).toFixed(2)}`;
}

// Thrown when the optimistic lock on Payment.refundedAmountPence matches no
// rows, i.e. a concurrent refund moved the cumulative total after this request
// read it. Distinct from a genuine DB fault so the catch below can answer 409
// rather than 500.
class RefundLedgerConflict extends Error {
  constructor() {
    super("Refund ledger changed between read and write");
    this.name = "RefundLedgerConflict";
  }
}

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

  // JSON 401/403, not a 307 to the login page: this route is called by
  // fetch(), and a redirect lands the client on HTML that .json() cannot
  // parse. On a money route that misreads as "the charge may have gone
  // through" — the drawer's outcome-unknown branch — so an expired cookie
  // would tell staff a member might have been charged when nothing happened.
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
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
  // Legacy rows: status "refunded" with no refundedAmountPence recorded means
  // a full refund under the old semantics — treat as exhausted.
  const alreadyRefundedLocal =
    payment.refundedAmountPence ?? (payment.status === "refunded" ? payment.amountPence : 0);
  const remainingPence = payment.amountPence - alreadyRefundedLocal;
  if (remainingPence <= 0) {
    return NextResponse.json({ error: "Already fully refunded" }, { status: 409 });
  }
  if (!payment.stripeChargeId && !payment.stripePaymentIntentId) {
    return NextResponse.json({ error: "No Stripe charge to refund" }, { status: 400 });
  }
  if (!tenant?.stripeAccountId) return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  // Cheap DB-only pre-check so an obviously-oversized request never costs a
  // Stripe round-trip. It is deliberately the same predicate as the
  // authoritative check further down, just against a bound that can only be
  // looser (Stripe's own amount_refunded is >= ours), so the two can never
  // disagree about what is refundable.
  if (parsed.data.amountPence && parsed.data.amountPence > remainingPence) {
    return NextResponse.json(
      {
        error: `Refund amount cannot exceed the ${formatMoney(remainingPence, payment.currency)} remaining on this charge (${formatMoney(alreadyRefundedLocal, payment.currency)} already refunded).`,
      },
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

    // ── Single source of truth for what is still refundable ──────────────
    // Stripe's own amount_refunded wins where we can read it: a refund issued
    // straight from the Stripe dashboard never touched our ledger. Our ledger
    // is the floor, so a stale or lagging Stripe read cannot widen the window.
    let alreadyRefunded = alreadyRefundedLocal;
    if (payment.stripeChargeId) {
      const charge = await stripe.charges.retrieve(payment.stripeChargeId, {}, { stripeAccount });
      alreadyRefunded = Math.max(alreadyRefundedLocal, charge.amount_refunded ?? 0);
    }
    const refundablePence = payment.amountPence - alreadyRefunded;

    // The ONE amount this request refunds. Both validations and the Stripe call
    // now derive from it. Audit money-path P1-3: the old code validated the
    // full-refund path against `payment.amountPence` while actually refunding
    // the remainder, so "refund the rest" on a part-refunded charge — exactly
    // what PaymentsTable sends, by omitting amountPence — was rejected as an
    // over-refund even though the amount it would have issued was legitimate.
    const refundAmount = parsed.data.amountPence ?? refundablePence;

    if (refundablePence <= 0) {
      return NextResponse.json(
        { error: "This payment has already been fully refunded." },
        { status: 409 },
      );
    }
    if (refundAmount > refundablePence) {
      return NextResponse.json(
        {
          error: `Refund amount cannot exceed the ${formatMoney(refundablePence, payment.currency)} remaining on this charge (${formatMoney(alreadyRefunded, payment.currency)} already refunded).`,
        },
        { status: 400 },
      );
    }

    // Idempotency key keyed on payment.id + amount + cumulative-so-far:
    // Stripe's dedup means two parallel requests with the same key return the
    // same refund object instead of issuing two refunds, while successive
    // legitimate partials (same amount, different cumulative position) get
    // distinct keys instead of silently replaying the first refund. Keyed on
    // the LOCAL cumulative figure deliberately, so it moves in lockstep with
    // the optimistic lock below, which guards on that same value.
    const idempotencyKey = `matflow_refund_${payment.id}_${refundAmount}_${alreadyRefundedLocal}`;
    const refund = await stripe.refunds.create(
      {
        ...(payment.stripePaymentIntentId ? { payment_intent: payment.stripePaymentIntentId } : { charge: payment.stripeChargeId! }),
        // Always explicit. Letting Stripe infer the remainder would let the
        // amount it refunds drift from the amount we validated and record.
        amount: refundAmount,
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

    const refundedAmount = refund.amount ?? refundAmount;

    // Read the cumulative total BACK from Stripe rather than computing
    // `alreadyRefunded + refundedAmount`.
    //
    // Why: the idempotency key is keyed on the LOCAL cumulative figure while
    // `alreadyRefunded` is max(local, Stripe). When the DB write below fails
    // (the 500 path) and an operator retries, the key is unchanged — so Stripe
    // REPLAYS and returns the original refund object without moving any money —
    // but `alreadyRefunded` has meanwhile picked up that refund from Stripe.
    // Adding `refundedAmount` on top then counts the same refund twice and puts
    // the ledger back out of step with Stripe, which is the exact class of
    // defect this route was being fixed for.
    //
    // charge.amount_refunded is Stripe's own cumulative and is replay-safe.
    const settledChargeId =
      typeof refund.charge === "string"
        ? refund.charge
        : (refund.charge?.id ?? payment.stripeChargeId ?? null);

    let newRefundedTotal = alreadyRefunded + refundedAmount;
    if (settledChargeId) {
      try {
        const settled = await stripe.charges.retrieve(settledChargeId, {}, { stripeAccount });
        if (typeof settled.amount_refunded === "number") {
          newRefundedTotal = settled.amount_refunded;
        }
      } catch (readErr) {
        // The refund itself succeeded; a failed read-back must not lose it.
        // Fall back to the computed total and say so, rather than silently
        // recording a figure we could not confirm.
        console.error("[payments/refund] could not read back the cumulative refund total", {
          paymentId: payment.id,
          chargeId: settledChargeId,
          error: readErr instanceof Error ? readErr.message : String(readErr),
        });
      }
    }
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

    // Tier 3.8: card refunds settle synchronously (refund.status === 'succeeded'),
    // but BACS / bank refunds return 'pending' and settle days later — or fail.
    // Record the ledger refund either way, but only VOID the funded class-pack
    // once the refund has actually settled. Otherwise the member loses their
    // credits the instant the owner clicks refund — before the money is returned
    // and before a possible failure. On a pending refund the pack is left intact;
    // the charge.refunded webhook (ULT-022 handler) voids it when it settles.
    const refundSettled = refund.status === "succeeded";
    let packVoided = false;
    try {
      await withTenantContext(tenantId, async (tx) => {
        // Optimistic lock. Audit money-path P1-2: this was a bare `update`
        // keyed on id alone, so the sequence read → validate → write was a
        // read-modify-write race. Two refunds admitted concurrently each
        // validated against the same stale cumulative total and the second
        // write simply overwrote the first, letting the pair exceed the
        // payment total with the ledger showing only the last one.
        //
        // updateMany guarded on the exact value we read matches zero rows if
        // anyone moved it in the meantime, and a zero count aborts the whole
        // transaction rather than clobbering the winner.
        const applied = await tx.payment.updateMany({
          where: {
            id: payment.id,
            tenantId,
            refundedAmountPence: payment.refundedAmountPence ?? null,
          },
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
        if (applied.count === 0) throw new RefundLedgerConflict();
        if (refundSettled && payment.stripePaymentIntentId) {
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
      if (dbError instanceof RefundLedgerConflict) {
        // A concurrent refund for this payment won the write. If the two
        // requests were for the same amount they shared an idempotency key and
        // Stripe returned the SAME refund to both, so nothing is lost. If they
        // differed, Stripe issued two refunds and only the winner is in our
        // ledger — hence the CRITICAL log and the refund id in the body. The
        // `charge.refunded` webhook is the eventual-consistency backstop.
        console.error(
          "[payments/refund] CRITICAL: refund ledger lock conflict — a concurrent refund updated this payment first. This refund is NOT recorded locally.",
          { stripeRefundId: refund.id, paymentId: payment.id, tenantId, refundedAmount },
        );
        return NextResponse.json(
          {
            ok: false,
            error:
              "Another refund for this payment was processed at the same time. Reload the payment to see the current position before refunding again.",
            stripeRefundId: refund.id,
          },
          { status: 409 },
        );
      }
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
          amount: formatMoney(refundedAmount, payment.currency),
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
