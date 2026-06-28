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
import { checkRateLimit } from "@/lib/rate-limit";
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

  // Tier 3.7: cap ad-hoc charges per member so a hijacked session / runaway
  // script can't drain a saved card, and so a fat-finger burst is throttled.
  const rl = await checkRateLimit(`charge:adhoc:${memberId}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many charge attempts for this member. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

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
    // Tier 3.7: a Stripe idempotency key keyed on member+amount+a 30s bucket
    // means a double-click / client retry within the window returns the SAME
    // PaymentIntent instead of charging the saved card twice. A deliberate
    // repeat charge after the window still goes through.
    const idempotencyKey = `matflow_charge_${memberId}_${amountPence}_${Math.floor(Date.now() / 30000)}`;
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
      { stripeAccount: tenant.stripeAccountId, idempotencyKey },
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
        // Tier 4.18: store uppercase to match every webhook-written Payment row
        // (the Stripe API call above legitimately uses lowercase). Mixed casing
        // otherwise breaks the member billing tab's currency-symbol lookup.
        currency: currency.toUpperCase(),
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
