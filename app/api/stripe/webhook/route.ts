import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";

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

  // Only claim the eventId for event types we actually handle. Claiming for
  // unknown types is a footgun: if a future deploy adds a handler for that type,
  // it would be permanently skipped because we already recorded the claim and
  // Stripe stops retrying after our 200 ack.
  const HANDLED_EVENT_TYPES = new Set([
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "invoice.voided",
    "checkout.session.completed",
    "payment_intent.processing",
    "payment_intent.succeeded",
    "mandate.updated",
    "charge.refunded",
    "customer.deleted",
    "payment_method.detached",
    "charge.dispute.created",
    "charge.dispute.updated",
  ]);
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    // Ack but don't claim — preserves the option to handle this type later.
    return NextResponse.json({ received: true, ignored: true, type: event.type });
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
  if (!stripeAccountId) {
    console.warn("[stripe-webhook] event.account missing", { eventId: event.id, type: event.type });
    // Roll back the StripeEvent claim so we don't block legit retries.
    if (claimedEventRowId) {
      await prisma.stripeEvent.delete({ where: { id: claimedEventRowId } }).catch(() => {});
    }
    return NextResponse.json({ error: "Event missing connected account" }, { status: 400 });
  }
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
        const memberFull = await prisma.member.findUnique({
          where: { id: member.id },
          select: { name: true, email: true, tenant: { select: { name: true } } },
        });
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
        if (memberFull?.email) {
          const amountPence = (obj.amount_due as number) ?? 0;
          const currency = ((obj.currency as string) ?? "gbp").toUpperCase();
          const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
          const portalUrl = `${process.env.NEXTAUTH_URL ?? ""}/member/profile`;
          sendEmail({
            tenantId: member.tenantId,
            templateId: "payment_failed",
            to: memberFull.email,
            vars: {
              memberName: memberFull.name,
              gymName: memberFull.tenant.name,
              portalUrl,
              amount: `${symbol}${(amountPence / 100).toFixed(2)}`,
            },
          }).catch(() => {});
        }
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
    } else if (event.type === "checkout.session.completed") {
      // One-off purchases (class packs etc.) flagged via metadata.matflowKind
      const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
      if (metadata.matflowKind === "class_pack" && metadata.packId && metadata.memberId && metadata.tenantId) {
        const pack = await prisma.classPack.findFirst({
          where: { id: metadata.packId, tenantId: metadata.tenantId },
        });
        if (pack) {
          const expiresAt = new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000);
          const paymentIntentId = (obj.payment_intent as string) ?? null;
          // Mirror as a Payment row so the ledger is complete
          const amountPence = (obj.amount_total as number) ?? pack.pricePence;
          try {
            await prisma.$transaction([
              prisma.memberClassPack.create({
                data: {
                  tenantId: metadata.tenantId,
                  memberId: metadata.memberId,
                  packId: pack.id,
                  creditsRemaining: pack.totalCredits,
                  expiresAt,
                  stripePaymentIntentId: paymentIntentId,
                  status: "active",
                },
              }),
              prisma.payment.upsert({
                where: paymentIntentId
                  ? { stripePaymentIntentId: paymentIntentId }
                  : { id: "__never__" },
                create: {
                  tenantId: metadata.tenantId,
                  memberId: metadata.memberId,
                  stripePaymentIntentId: paymentIntentId,
                  amountPence,
                  currency: ((obj.currency as string) ?? pack.currency).toUpperCase(),
                  status: "succeeded",
                  description: `Class pack: ${pack.name}`,
                  paidAt: new Date(),
                },
                update: {
                  status: "succeeded",
                  paidAt: new Date(),
                },
              }),
            ]);
          } catch (e: unknown) {
            // Idempotent on stripePaymentIntentId @unique — duplicate replays are fine
            if ((e as { code?: string }).code !== "P2002") throw e;
          }
        }
      }
    } else if (event.type === "payment_intent.processing") {
      // BACS Direct Debit takes ~4 working days to settle. Show "pending" state in the UI.
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        await prisma.member.update({
          where: { id: member.id },
          data: { paymentStatus: "pending" },
        });
      }
    } else if (event.type === "mandate.updated") {
      // BACS mandate status flipped (active / inactive / pending). Track on member preferredPaymentMethod.
      const status = (obj.status as string) ?? "";
      const customerId = (obj.customer as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      if (member && status === "inactive") {
        await prisma.member.update({
          where: { id: member.id },
          data: { paymentStatus: "overdue", preferredPaymentMethod: "card" },
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
    } else if (event.type === "customer.subscription.updated") {
      // Sprint 5 US-503: keep Member.stripeSubscriptionId + paymentStatus in sync
      // when the subscription status flips (active → past_due, paused → active, etc.)
      const customerId = obj.customer as string;
      const status = (obj.status as string) ?? "";
      const subscriptionId = obj.id as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        const paymentStatus =
          status === "active" || status === "trialing" ? "paid"
          : status === "past_due" ? "overdue"
          : status === "paused" ? "paused"
          : status === "canceled" || status === "incomplete_expired" ? "cancelled"
          : undefined; // leave unchanged for unrecognised statuses
        await prisma.member.update({
          where: { id: member.id },
          data: {
            stripeSubscriptionId: status === "canceled" ? null : subscriptionId,
            ...(paymentStatus ? { paymentStatus } : {}),
          },
        });
      }
    } else if (event.type === "invoice.voided") {
      // Sprint 5 US-503: void = invoice cancelled before / after payment.
      // Flip the matching Payment row to refunded so the ledger reflects reality.
      const invoiceId = obj.id as string;
      const existing = await prisma.payment.findFirst({ where: { stripeInvoiceId: invoiceId } });
      if (existing) {
        await prisma.payment.update({
          where: { id: existing.id },
          data: { status: "refunded", refundedAt: new Date() },
        });
      }
    } else if (event.type === "payment_intent.succeeded") {
      // Sprint 5 US-503: standalone payment_intent (not via invoice). Mirrors
      // invoice.payment_succeeded but keys off the PaymentIntent. The unique
      // stripePaymentIntentId on Payment makes the upsert idempotent.
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      const paymentIntentId = obj.id as string;
      if (member && paymentIntentId) {
        await prisma.payment.upsert({
          where: { stripePaymentIntentId: paymentIntentId },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripePaymentIntentId: paymentIntentId,
            stripeChargeId: ((obj.latest_charge as string) ?? null),
            amountPence: (obj.amount_received as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "succeeded",
            description: (obj.description as string) ?? null,
            paidAt: new Date(),
          },
          update: {
            status: "succeeded",
            stripeChargeId: ((obj.latest_charge as string) ?? null),
            paidAt: new Date(),
          },
        });
      }
    } else if (event.type === "customer.deleted") {
      // Sprint 5 US-503: customer record deleted at Stripe — null the FK on Member
      // so future payments don't try to attach to a dead Stripe customer.
      const customerId = obj.id as string;
      if (customerId) {
        await prisma.member.updateMany({
          where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
          data: { stripeCustomerId: null },
        });
      }
    } else if (event.type === "payment_method.detached") {
      // Sprint 5 US-503: payment method removed (card expired or member deleted it
      // from the Stripe portal). No DB column to update, but log it to AuditLog so
      // the owner has visibility for billing-support investigations.
      const customerId = (obj.customer as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      if (member && tenantId) {
        await logAudit({
          tenantId,
          userId: null,
          action: "stripe.payment_method.detached",
          entityType: "Member",
          entityId: member.id,
          metadata: {
            paymentMethodId: obj.id as string,
            type: (obj.type as string) ?? null,
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
        if (linkedPayment) {
          if (status === "won") {
            await prisma.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "succeeded" },
            });
          } else if (status === "charge_refunded") {
            await prisma.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "refunded" },
            });
          } else {
            await prisma.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "disputed" },
            });
          }
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
