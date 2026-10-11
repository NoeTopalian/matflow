// GET /api/stripe/subscriptions/[id]/status[?invoice=in_…]
//
// Payments lane PB (11 Oct 2026): polled by the payment form after Stripe.js
// reports a confirmation, until MatFlow has recorded what Stripe says. Reads
// MatFlow's own rows only (no Stripe call, no secrets):
//
//   subscription — lane PC's mapping: Stripe's subscription status as last
//                  applied by the webhook, whether it has ended, and whether a
//                  renewal is waiting on the payer's authentication
//   payment      — the Payment row the webhook wrote for this subscription's
//                  invoice (the named invoice, else the newest since the
//                  subscription was created), or null when none has arrived
//   billing      — the member's paymentStatus as MatFlow holds it
//
// These are three separate facts and the response keeps them separate: a
// confirmed card is not yet a recorded payment, and neither is the person's
// membership record (Member.status is not read or returned here).
//
// Same callers as /confirmation (lib/stripe/subscription-payer.ts).

import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { resolveSubscriptionPayer } from "@/lib/stripe/subscription-payer";

const INVOICE_ID = /^in_[A-Za-z0-9_]{1,200}$/;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const { id } = await params;
  const access = await resolveSubscriptionPayer(session, id);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status, headers: { "Cache-Control": "no-store" } });
  }
  const { mapping, tenantId } = access;

  const invoiceParam = new URL(req.url).searchParams.get("invoice");
  const invoiceId = invoiceParam && INVOICE_ID.test(invoiceParam) ? invoiceParam : null;

  const [payment, member] = await withTenantContext(tenantId, async (tx) => {
    const p = await tx.payment.findFirst({
      where: invoiceId
        ? { tenantId, memberId: mapping.memberId, stripeInvoiceId: invoiceId }
        : { tenantId, memberId: mapping.memberId, stripeInvoiceId: { not: null }, createdAt: { gte: mapping.createdAt } },
      orderBy: { createdAt: "desc" },
      select: { status: true, amountPence: true, currency: true, paidAt: true, failureReason: true },
    });
    const m = await tx.member.findFirst({
      where: { id: mapping.memberId, tenantId },
      select: { paymentStatus: true, stripeSubscriptionId: true },
    });
    return [p, m] as const;
  });

  return NextResponse.json(
    {
      subscription: {
        status: mapping.status,
        ended: !!mapping.endedAt,
        // Is this still the member's current subscription in MatFlow?
        current: member?.stripeSubscriptionId === mapping.stripeSubscriptionId,
        requiresAction: !!mapping.requiresActionInvoiceId,
      },
      payment: payment
        ? {
            status: payment.status,
            amountPence: payment.amountPence,
            currency: payment.currency,
            paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
            failureReason: payment.failureReason,
          }
        : null,
      billing: { paymentStatus: member?.paymentStatus ?? null },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
