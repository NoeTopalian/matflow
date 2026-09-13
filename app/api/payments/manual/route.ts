/**
 * Owner-side manual payment marking.
 * Use cases: cash collections, exempt members (employees, comps), external payments
 * (Direct Debit collected outside MatFlow's Stripe), one-off "I just took £40 in
 * person, mark Sean paid for the month".
 *
 * Creates a Payment row with no Stripe IDs and flips Member.paymentStatus = 'paid'.
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import { advanceDueDate } from "@/lib/overdue";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import {
  MANUAL_PAYMENT_METHOD_VALUES,
  type ManualPaymentMethod,
  isFreeMethod,
  methodNeedsNotes,
} from "@/lib/payment-methods";

// The list lives in lib/payment-methods so the route, the payments hub and the
// member profile cannot disagree about what a valid method is — they already
// had: the profile posted `method: "manual"` and 400d on every attempt.
const METHODS = MANUAL_PAYMENT_METHOD_VALUES;

// Per-tenant cap. A legitimate gym taking cash at the desk during a busy
// session won't approach this. A hijacked owner session scripting fake
// payments to pollute the audit log will hit it fast.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

const schema = z
  .object({
    memberId: z.string().min(1),
    amountPence: z.number().int().min(0),
    method: z.enum(METHODS),
    notes: z.string().max(500).optional(),
    paidAt: z.string().optional(),
    currency: z.string().min(3).max(3).optional(),
    // Caller-minted, and REQUIRED. Minting one server-side would be a fresh
    // value per request — no protection at all, while looking like some. The
    // client holds it across exactly the retries that must dedupe and mints a
    // new one for a genuinely new payment, which is why a club can still take
    // two identical £40s in a day.
    requestId: z.string().min(8).max(100),
  })
  .superRefine((data, ctx) => {
    const free = isFreeMethod(data.method);
    if (!free && data.amountPence < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Amount must be at least £0.01 for this payment method",
        path: ["amountPence"],
      });
    }
    if (methodNeedsNotes(data.method) && !data.notes?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Notes are required for 'Other' payment method",
        path: ["notes"],
      });
    }
  });

// The prefix a member sees on their receipt. Deliberately NOT the picker
// labels from lib/payment-methods: "Bank transfer / external" is the right
// words in a dropdown and the wrong ones on a receipt line.
const METHOD_LABEL: Record<ManualPaymentMethod, string> = {
  cash: "Cash",
  exempt: "Exempt",
  external: "External",
  comp: "Comp",
  other: "Manual",
};

export async function POST(req: Request) {
  // Defence-in-depth: same-origin check before any work. Cash-recording is
  // financial state-mutation and deserves the same CSRF gate as refund.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(
    `payment-manual:${tenantId}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many manual payments in a short period. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { memberId, amountPence, method, notes, paidAt, currency, requestId } = parsed.data;

  const description = `${METHOD_LABEL[method]}${notes ? ` — ${notes}` : ""}`;
  const paidAtDate = paidAt ? new Date(paidAt) : new Date();

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      // The club's own currency, so a recorded cash payment is denominated the
      // same way as everything else the club charges. This used to default to
      // "GBP" from an optional client field and never read Tenant.currency,
      // which is CHECK-constrained to GBP|EUR|USD and read correctly by the
      // member checkout — so a EUR club's cash takings were logged in sterling
      // and its revenue totals silently mixed two currencies.
      const clubCurrency = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { currency: true },
      });

      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: {
          id: true,
          name: true,
          // Needed to advance the due date below. The tier owns the cycle
          // (MembershipTier.billingCycle: monthly | annual | none).
          nextDueAt: true,
          membershipTier: { select: { billingCycle: true } },
        },
      });
      if (!member) return null;
      const payment = await tx.payment.create({
        data: {
          tenantId,
          memberId: member.id,
          amountPence,
          currency: (currency ?? clubCurrency?.currency ?? "GBP").toUpperCase(),
          status: "succeeded",
          description,
          paidAt: paidAtDate,
          requestId,
        },
      });
      // Recording a payment advances the due date, so the overdue derivation
      // maintains itself instead of needing anybody to clear a flag by hand.
      // Without this, a member paid in cash would be marked "paid" once and
      // then fall overdue again the instant their old due date passed, which
      // is worse than not tracking it at all.
      //
      // Members with no tier, or a tier whose cycle is "none", get no due date:
      // there is no recurring obligation to date. `advanceDueDate` preserves
      // the day of the month rather than re-basing on today, so paying a few
      // days late does not walk a member's billing day through the month.
      const nextDueAt = member.membershipTier
        ? advanceDueDate(member.nextDueAt, member.membershipTier.billingCycle, paidAtDate)
        : member.nextDueAt;

      await tx.member.update({
        where: { id: member.id },
        data: { paymentStatus: "paid", nextDueAt },
      });
      return { payment, member, nextDueAt };
    });

    if (!result) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    const { payment, member } = result;

    await logAudit({
      tenantId,
      userId,
      action: "payment.manual",
      entityType: "Payment",
      entityId: payment.id,
      metadata: {
        memberId: member.id,
        method,
        amountPence,
        notes: notes ?? null,
        // Recorded so a club can see WHY a member's due date moved.
        nextDueAt: result.nextDueAt?.toISOString() ?? null,
      },
      req,
    });

    return NextResponse.json(payment, { status: 201 });
  } catch (e) {
    // P2002 on (tenantId, requestId): this exact submission already landed.
    // Two staff on two tills, or one member of staff whose first attempt
    // timed out and who pressed again — either way their intent was ONE
    // payment and the ledger holds exactly one. Hand back the row that
    // exists, because a 409 here would read as "it did not save" and invite
    // a third attempt.
    if ((e as { code?: string }).code === "P2002") {
      const already = await withTenantContext(tenantId, (tx) =>
        tx.payment.findFirst({ where: { tenantId, requestId } }),
      ).catch(() => null);
      if (already) return NextResponse.json(already, { status: 200 });
    }
    return apiError("Payment processing failed", 500, e, "[payments/manual]");
  }
}
