import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";

const querySchema = z.object({
  status: z
    .enum(["all", "succeeded", "failed", "refunded", "disputed", "pending"])
    .optional()
    .default("all"),
  memberId: z.string().optional(),
  page: z.coerce.number().int().positive().optional().default(1),
});

export async function GET(req: Request) {
  // assertSameOrigin is a no-op for GET/HEAD/OPTIONS but kept for consistency.
  const violation = assertSameOrigin(req);
  if (violation) return violation;

  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { searchParams } = new URL(req.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  const { status, memberId, page } = parsed.data;
  const PAGE_SIZE = 20;
  const skip = (page - 1) * PAGE_SIZE;

  const where = {
    tenantId,
    ...(status !== "all" ? { status } : {}),
    ...(memberId ? { memberId } : {}),
  };

  try {
    const [payments, total, openDisputeRows] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.payment.findMany({
          where,
          select: {
            id: true,
            amountPence: true,
            currency: true,
            status: true,
            description: true,
            createdAt: true,
            paidAt: true,
            refundedAt: true,
            refundedAmountPence: true,
            failureReason: true,
            stripePaymentIntentId: true,
            // Drives the refund modal's subscription-action requirement —
            // invoice-backed payments belong to a subscription.
            stripeInvoiceId: true,
            member: { select: { id: true, name: true, email: true, membershipType: true } },
          },
          orderBy: { createdAt: "desc" },
          take: PAGE_SIZE,
          skip,
        }),
        tx.payment.count({ where }),
        // Open disputes for the owner-facing panel (audit money-gap (a)):
        // previously the Dispute rows — including the evidence deadline —
        // were readable only on the platform-admin page; the gym owner
        // learnt about them solely from one email.
        tx.dispute.findMany({
          where: { tenantId, status: { in: ["needs_response", "under_review"] } },
          select: {
            id: true,
            paymentId: true,
            amountPence: true,
            currency: true,
            reason: true,
            status: true,
            evidenceDueAt: true,
            createdAt: true,
          },
          orderBy: { evidenceDueAt: "asc" },
          take: 20,
        }),
      ]),
    );

    // Resolve member names for the dispute panel in one lookup.
    const disputePaymentIds = openDisputeRows
      .map((d) => d.paymentId)
      .filter((id): id is string => !!id);
    const disputePayments = disputePaymentIds.length
      ? await withTenantContext(tenantId, (tx) =>
          tx.payment.findMany({
            where: { id: { in: disputePaymentIds }, tenantId },
            select: { id: true, member: { select: { name: true } } },
          }),
        )
      : [];
    const memberNameByPayment = new Map(
      disputePayments.map((p) => [p.id, p.member?.name ?? null]),
    );
    const openDisputes = openDisputeRows.map((d) => ({
      ...d,
      memberName: d.paymentId ? memberNameByPayment.get(d.paymentId) ?? null : null,
    }));

    return NextResponse.json(
      {
        payments,
        total,
        page,
        pages: Math.ceil(total / PAGE_SIZE),
        openDisputes,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[api/payments] query failed", err);
    return NextResponse.json({ error: "Failed to load payments" }, { status: 500 });
  }
}
