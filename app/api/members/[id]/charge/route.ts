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

// How a failed attempt ended, from the client's point of view:
//
//   "declined" — the card issuer said no. Stripe reached a verdict, no money
//                moved. Safe for the client to discard its idempotency key.
//   "rejected" — the request never reached the card (bad params, bad key,
//                wrong account scope). Also terminal, also key-safe.
//   "unknown"  — we never learned the outcome: connection reset, timeout,
//                Stripe 5xx, or a PaymentIntent still in flight. The member
//                MAY have been charged. The client must replay the SAME
//                requestId so the idempotency key below dedupes at Stripe
//                instead of taking the money a second time.
//
// Audit money-path P0-3: this split is the whole fix. The previous code
// collapsed every throw into one 402 "failed" path, so a network blip looked
// exactly like a decline, the client binned its idempotency key, and a staff
// retry charged the member twice.
type ChargeOutcome = "succeeded" | "declined" | "rejected" | "unknown";

// Stripe error types where the request provably did not result in a charge.
// Anything not listed here — StripeConnectionError, StripeAPIError,
// StripeRateLimitError, StripeUnknownError, a raw timeout, a non-Stripe throw —
// falls through to "unknown", because guessing "it failed" is the expensive
// direction to be wrong in.
const TERMINAL_STRIPE_ERROR_TYPES = new Set([
  "StripeInvalidRequestError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeIdempotencyError",
]);

// PaymentIntent statuses that are a settled "no". Everything else a
// non-succeeded PI can be (processing, requires_action, requires_confirmation,
// requires_capture) is still in flight and must not be reported as a failure.
const TERMINAL_PI_STATUSES = new Set(["requires_payment_method", "canceled"]);

function classifyStripeFailure(err: unknown): Exclude<ChargeOutcome, "succeeded"> {
  const type = (err as { type?: unknown } | null | undefined)?.type;
  if (type === "StripeCardError") return "declined";
  if (typeof type === "string" && TERMINAL_STRIPE_ERROR_TYPES.has(type)) return "rejected";
  return "unknown";
}

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

  // Carries the flag explicitly: it is a 5xx, but nothing reached Stripe, so
  // the drawer must show a plain error rather than "this may have gone through".
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { ok: false, outcomeUnknown: false, error: "Stripe not configured" },
      { status: 503 },
    );
  }

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
  let outcome: ChargeOutcome = "unknown";
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
      {
        stripeAccount: tenant.stripeAccountId,
        idempotencyKey: `matflow_adhoc_${memberId}_${requestId}`,
      },
    );

    paymentIntentId = pi.id;
    if (pi.status === "succeeded") {
      outcome = "succeeded";
    } else {
      outcome = TERMINAL_PI_STATUSES.has(pi.status) ? "declined" : "unknown";
      failureReason = pi.last_payment_error?.message ?? `Payment ${pi.status}`;
    }
  } catch (err: unknown) {
    outcome = classifyStripeFailure(err);
    failureReason = (err as { message?: string })?.message ?? "Stripe error";
    if (outcome === "unknown") {
      // Not a decline — we simply never learned whether the member's card was
      // charged. Loud, because it is the one case an operator may need to
      // reconcile against Stripe by hand if the webhook does not land.
      console.error("[members/charge] charge outcome UNKNOWN — may have succeeded at Stripe", {
        tenantId, memberId, amountPence, requestId, error: err,
      });
    }
  }

  // Ledger status. "pending" is a real, rendered payment status across the
  // dashboard, and it is the honest one for a PaymentIntent still in flight —
  // recording it as "failed" would tell staff no money moved when it may have.
  const ledgerStatus: "succeeded" | "failed" | "pending" =
    outcome === "succeeded" ? "succeeded" : outcome === "unknown" ? "pending" : "failed";

  // Record Payment row whenever we have something true to record. Upsert on the
  // unique PI id so an idempotent Stripe replay (client retried an
  // unknown-outcome attempt) can't double-write the ledger or P2002 after a
  // successful charge.
  //
  // Deliberately NO row when the outcome is unknown and we never got a PI id:
  // there is nothing to key it to, so it could never be reconciled or deduped,
  // and writing a "failed" row we cannot stand behind is exactly what made the
  // ledger disagree with Stripe. The `payment_intent.succeeded` webhook
  // (app/api/stripe/webhook) upserts the row if the charge did in fact land.
  if (paymentIntentId) {
    await withTenantContext(tenantId, async (tx) => {
      await tx.payment.upsert({
        where: { stripePaymentIntentId: paymentIntentId! },
        create: {
          tenantId,
          memberId,
          amountPence,
          currency: currency.toUpperCase(),
          status: ledgerStatus,
          description,
          failureReason,
          stripePaymentIntentId: paymentIntentId!,
          paidAt: outcome === "succeeded" ? new Date() : undefined,
        },
        update: {
          status: ledgerStatus,
          failureReason,
          paidAt: outcome === "succeeded" ? new Date() : undefined,
        },
      });
    });
  } else if (outcome !== "unknown") {
    await withTenantContext(tenantId, async (tx) => {
      await tx.payment.create({
        data: {
          tenantId,
          memberId,
          amountPence,
          currency: currency.toUpperCase(),
          status: ledgerStatus,
          description,
          failureReason,
        },
      });
    });
  }

  await logAudit({
    tenantId,
    userId,
    action: "payment.adhoc.charge",
    entityType: "Member",
    entityId: memberId,
    metadata: { amountPence, description, status: ledgerStatus, outcome, paymentIntentId, failureReason },
    req,
  });

  if (outcome === "unknown") {
    // 502, not 402: nothing was declined — the upstream never gave us an
    // answer. `outcomeUnknown` is the contract the drawer keys off to hold on
    // to its requestId, so a retry replays the same Stripe idempotency key.
    // Raw Stripe/transport messages stay in the log (UI-RULES §7).
    return NextResponse.json(
      {
        ok: false,
        outcomeUnknown: true,
        error:
          "We couldn't confirm this charge with Stripe. It may still have gone through — check the member's payments before charging again. Retrying here is safe: it reuses the same request, so the member cannot be charged twice.",
        paymentIntentId,
      },
      { status: 502 },
    );
  }

  if (outcome !== "succeeded") {
    return NextResponse.json(
      { ok: false, outcomeUnknown: false, error: failureReason ?? "Charge failed" },
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
