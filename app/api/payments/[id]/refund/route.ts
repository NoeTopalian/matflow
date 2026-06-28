import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";

// Per-tenant cap on refund operations. Caps both fat-finger UI mistakes
// and a hostile insider scripting refunds en masse if their session were
// hijacked. 30 in 5 minutes is well above any plausible legitimate burst.
const REFUND_LIMIT_MAX = 30;
const REFUND_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const schema = z.object({
  amountPence: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
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

  const { payment, tenant } = await withTenantContext(tenantId, async (tx) => {
    const p = await tx.payment.findFirst({ where: { id, tenantId } });
    const t = p
      ? await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { stripeAccountId: true },
        })
      : null;
    return { payment: p, tenant: t };
  });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.status === "refunded") return NextResponse.json({ error: "Already refunded" }, { status: 409 });
  if (!payment.stripeChargeId && !payment.stripePaymentIntentId) {
    return NextResponse.json({ error: "No Stripe charge to refund" }, { status: 400 });
  }
  if (!tenant?.stripeAccountId) return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  if (parsed.data.amountPence && parsed.data.amountPence > payment.amountPence) {
    return NextResponse.json(
      { error: `Refund amount cannot exceed original charge of ${payment.amountPence} pence.` },
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

    // Idempotency key keyed on payment.id + amount: Stripe's own dedup
    // means two parallel requests with the same key return the same refund
    // object instead of issuing two refunds. Closes the race where two
    // tabs (or a hijacked session firing parallel) could double-refund
    // and leave our DB out of sync with Stripe.
    const refundAmount = parsed.data.amountPence ?? payment.amountPence;
    const idempotencyKey = `matflow_refund_${payment.id}_${refundAmount}`;
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

    const refundedAmount = refund.amount ?? parsed.data.amountPence ?? payment.amountPence;

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
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: "refunded",
            refundedAt: new Date(),
            refundedAmountPence: refundedAmount,
          },
        });
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
        reason: parsed.data.reason ?? null,
        packVoided,
      },
      req,
    });

    return NextResponse.json({ ok: true, stripeRefundId: refund.id, amountPence: refundedAmount, packVoided });
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
