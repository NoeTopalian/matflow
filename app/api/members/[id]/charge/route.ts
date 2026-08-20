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
import { sendEmail } from "@/lib/email";
import { z } from "zod";
import Stripe from "stripe";

const bodySchema = z.object({
  amountPence: z.number().int().positive().max(1_000_000), // max £10,000
  description: z.string().min(1).max(200),
  // Client-minted per-attempt UUID. Reused verbatim when the client retries an
  // attempt whose outcome it never learned (network drop), so Stripe dedupes
  // the PaymentIntent instead of charging twice.
  requestId: z.string().min(8).max(64),
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
  const { amountPence, description, requestId } = parsed.data;

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
      select: { id: true, name: true, email: true, stripeCustomerId: true },
    });
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true, currency: true, name: true },
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

  // Record Payment row regardless of outcome. Upsert on the unique PI id so an
  // idempotent Stripe replay (client retried an unknown-outcome attempt) can't
  // double-write the ledger or P2002 after a successful charge.
  await withTenantContext(tenantId, async (tx) => {
    const data = {
      tenantId,
      memberId,
      amountPence,
      currency: currency.toUpperCase(),
      status: chargeStatus,
      description,
      failureReason,
      paidAt: chargeStatus === "succeeded" ? new Date() : undefined,
    };
    if (paymentIntentId) {
      await tx.payment.upsert({
        where: { stripePaymentIntentId: paymentIntentId },
        create: { ...data, stripePaymentIntentId: paymentIntentId },
        update: { status: chargeStatus, failureReason, paidAt: data.paidAt },
      });
    } else {
      await tx.payment.create({ data });
    }
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

  // Receipt (money-gap (b)): MatFlow previously sent nothing on a successful
  // charge — Stripe's own receipt fires only if the gym enabled it. Fire and
  // forget after the ledger write; a mail failure never fails the charge.
  if (member.email) {
    const symbol = currency.toUpperCase() === "USD" ? "$" : currency.toUpperCase() === "EUR" ? "€" : "£";
    sendEmail({
      tenantId,
      templateId: "receipt",
      to: member.email,
      vars: {
        memberName: member.name,
        gymName: tenant.name ?? "your gym",
        amount: `${symbol}${(amountPence / 100).toFixed(2)}`,
        description: description ?? "Payment",
        paidDate: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
      },
    }).catch((e) => console.error("[members/charge] receipt email failed", e));
  }

  return NextResponse.json({ ok: true, amountPence, paymentIntentId });
}
