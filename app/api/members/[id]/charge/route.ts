// POST /api/members/[id]/charge
// Creates an off-session PaymentIntent against the member's saved card.
// Auth: requireOwner
// Body: { amountPence: number (positive int), description: string (max 200) }

import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";
import Stripe from "stripe";

const bodySchema = z.object({
  amountPence: z.number().int().positive().max(1_000_000), // max £10,000
  description: z.string().min(1).max(200),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { tenantId, userId } = await requireOwner();
  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 400);
  const { amountPence, description } = parsed.data;

  if (!process.env.STRIPE_SECRET_KEY) return apiError("Stripe not configured", 503);

  const { member, tenant, currency } = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, name: true, stripeCustomerId: true },
    });
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, currency: true },
    });
    return { member, tenant, currency: tenant?.currency ?? "GBP" };
  });

  if (!member) return apiError("Member not found", 404);
  if (!member.stripeCustomerId) return apiError("Member has no saved payment method", 402);
  if (!tenant?.stripeAccountId) return apiError("Stripe not connected for this gym", 402);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2026-03-25.dahlia",
  });

  let paymentIntentId: string | null = null;
  let chargeStatus: "succeeded" | "failed" = "failed";
  let failureReason: string | null = null;

  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: amountPence,
        currency: currency.toLowerCase(),
        customer: member.stripeCustomerId,
        off_session: true,
        confirm: true,
        description,
        metadata: { tenantId, memberId, type: "adhoc" },
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    paymentIntentId = pi.id;
    chargeStatus = pi.status === "succeeded" ? "succeeded" : "failed";
    if (pi.status !== "succeeded") {
      failureReason = pi.last_payment_error?.message ?? "Payment failed";
    }
  } catch (err: unknown) {
    const stripeErr = err as { message?: string };
    failureReason = stripeErr.message ?? "Stripe error";
  }

  // Record Payment row regardless of outcome
  await withTenantContext(tenantId, async (tx) => {
    await tx.payment.create({
      data: {
        tenantId,
        memberId,
        amountPence,
        currency: currency.toLowerCase(),
        status: chargeStatus,
        description,
        failureReason,
        stripePaymentIntentId: paymentIntentId ?? undefined,
        paidAt: chargeStatus === "succeeded" ? new Date() : undefined,
      },
    });
  });

  await logAudit({
    tenantId,
    userId,
    action: "payment.adhoc.charge",
    entityType: "Member",
    entityId: memberId,
    metadata: { amountPence, description, status: chargeStatus, paymentIntentId, failureReason },
    req,
  });

  if (chargeStatus === "failed") {
    return NextResponse.json(
      { ok: false, error: failureReason ?? "Charge failed" },
      { status: 402 },
    );
  }

  return NextResponse.json({ ok: true, amountPence, paymentIntentId });
}
