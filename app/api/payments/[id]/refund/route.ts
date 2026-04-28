import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

const schema = z.object({
  amountPence: z.number().int().positive().optional(),
  reason: z.string().max(200).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwner();
  const { id } = await params;

  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const payment = await prisma.payment.findFirst({ where: { id, tenantId } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  if (payment.status === "refunded") return NextResponse.json({ error: "Already refunded" }, { status: 409 });
  if (!payment.stripeChargeId && !payment.stripePaymentIntentId) {
    return NextResponse.json({ error: "No Stripe charge to refund" }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeAccountId: true },
  });
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

    const refund = await stripe.refunds.create(
      {
        ...(payment.stripePaymentIntentId ? { payment_intent: payment.stripePaymentIntentId } : { charge: payment.stripeChargeId! }),
        ...(parsed.data.amountPence ? { amount: parsed.data.amountPence } : {}),
        reason: "requested_by_customer",
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    const refundedAmount = refund.amount ?? parsed.data.amountPence ?? payment.amountPence;
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "refunded",
        refundedAt: new Date(),
        refundedAmountPence: refundedAmount,
      },
    });

    await logAudit({
      tenantId,
      userId,
      action: "payment.refund",
      entityType: "Payment",
      entityId: payment.id,
      metadata: { stripeRefundId: refund.id, amountPence: refundedAmount, reason: parsed.data.reason ?? null },
      req,
    });

    return NextResponse.json({ ok: true, stripeRefundId: refund.id, amountPence: refundedAmount });
  } catch (e) {
    return apiError("Payment processing failed", 500, e, "[payments/refund]");
  }
}
