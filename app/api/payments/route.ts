import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
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

  const { tenantId } = await requireOwner();
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
    const [payments, total] = await withTenantContext(tenantId, (tx) =>
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
      ]),
    );

    return NextResponse.json(
      {
        payments,
        total,
        page,
        pages: Math.ceil(total / PAGE_SIZE),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[api/payments] query failed", err);
    return NextResponse.json({ error: "Failed to load payments" }, { status: 500 });
  }
}
