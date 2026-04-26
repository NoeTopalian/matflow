import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: { id: string; type: string; account?: string; data: { object: Record<string, unknown> } };
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret) as unknown as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency: claim the event ID before processing.
  // If the unique constraint fires (P2002), Stripe is replaying — return 200 and skip.
  let claimedEventRowId: string | null = null;
  try {
    const row = await prisma.stripeEvent.create({ data: { eventId: event.id, type: event.type } });
    claimedEventRowId = row.id;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ received: true, alreadyProcessed: true });
    }
    return NextResponse.json({ error: "DB unavailable" }, { status: 500 });
  }

  // Map connected account to tenant
  const stripeAccountId = event.account;
  let tenantId: string | null = null;
  if (stripeAccountId) {
    const tenant = await prisma.tenant.findFirst({
      where: { stripeAccountId },
      select: { id: true },
    });
    tenantId = tenant?.id ?? null;
  }

  const obj = event.data.object as Record<string, unknown>;

  async function findMember(customerId: string) {
    return prisma.member.findFirst({
      where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
      select: { id: true, tenantId: true },
    });
  }

  try {
    if (event.type === "customer.subscription.deleted") {
      const customerId = obj.customer as string;
      if (customerId) {
        await prisma.member.updateMany({
          where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
          data: { paymentStatus: "cancelled", stripeSubscriptionId: null },
        });
      }
    } else if (event.type === "invoice.payment_failed") {
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        await prisma.member.update({
          where: { id: member.id },
          data: { paymentStatus: "overdue" },
        });
        await prisma.payment.upsert({
          where: { stripeInvoiceId: obj.id as string },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: obj.id as string,
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            amountPence: (obj.amount_due as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "failed",
            description: (obj.description as string) ?? null,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
          update: {
            status: "failed",
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
        });
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        await prisma.member.update({
          where: { id: member.id },
          data: { paymentStatus: "paid" },
        });
        await prisma.payment.upsert({
          where: { stripeInvoiceId: obj.id as string },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: obj.id as string,
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            amountPence: (obj.amount_paid as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "succeeded",
            description: (obj.description as string) ?? null,
            paidAt: new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000),
          },
          update: {
            status: "succeeded",
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            paidAt: new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000),
          },
        });
      }
    } else if (event.type === "charge.refunded") {
      const chargeId = obj.id as string;
      const refundedAmount = (obj.amount_refunded as number) ?? 0;
      const existing = await prisma.payment.findFirst({ where: { stripeChargeId: chargeId } });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: {
            status: "refunded",
            refundedAt: new Date(),
            refundedAmountPence: refundedAmount,
          },
        });
      }
    } else if (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated") {
      const customerId = (obj.customer as string) ?? null;
      const chargeId = (obj.charge as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      const linkedPayment = chargeId
        ? await prisma.payment.findFirst({ where: { stripeChargeId: chargeId } })
        : null;
      const status = ((): string => {
        const s = (obj.status as string) ?? "needs_response";
        if (s === "warning_needs_response" || s === "needs_response") return "needs_response";
        if (s === "warning_under_review" || s === "under_review") return "under_review";
        if (s === "won") return "won";
        if (s === "lost") return "lost";
        if (s === "charge_refunded") return "charge_refunded";
        return s;
      })();
      const evidenceDueAt = ((obj.evidence_details as { due_by?: number } | undefined)?.due_by ?? null);
      const tenantIdForRow = member?.tenantId ?? linkedPayment?.tenantId ?? tenantId;
      if (tenantIdForRow) {
        await prisma.dispute.upsert({
          where: { stripeDisputeId: obj.id as string },
          create: {
            tenantId: tenantIdForRow,
            paymentId: linkedPayment?.id ?? null,
            stripeDisputeId: obj.id as string,
            amountPence: (obj.amount as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            reason: (obj.reason as string) ?? "unknown",
            status,
            evidenceDueAt: evidenceDueAt ? new Date(evidenceDueAt * 1000) : null,
          },
          update: {
            status,
            evidenceDueAt: evidenceDueAt ? new Date(evidenceDueAt * 1000) : null,
          },
        });
        if (linkedPayment && status !== "won" && status !== "charge_refunded") {
          await prisma.payment.update({
            where: { id: linkedPayment.id },
            data: { status: "disputed" },
          });
        }
      }
    }
  } catch {
    // Roll back the idempotency claim so Stripe retries this event later.
    if (claimedEventRowId) {
      await prisma.stripeEvent.delete({ where: { id: claimedEventRowId } }).catch(() => {});
    }
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
