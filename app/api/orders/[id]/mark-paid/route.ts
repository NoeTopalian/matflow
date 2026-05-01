import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

/**
 * POST /api/orders/[id]/mark-paid
 *
 * Owner / manager flips a pay-at-desk Order from pending to paid after
 * collecting cash/card at the front desk. Idempotent: a second call
 * against an already-paid order is a no-op (returns the existing row).
 *
 * Requires a `reason` body field (3..200 chars) so the audit trail records
 * WHY each manual payment was recorded — stops cash-skimming + reconciles
 * to physical receipts later.
 */
const schema = z.object({
  reason: z.string().trim().min(3).max(200),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id } = await params;

  // Tenant-scope guard — confirm the order belongs to this tenant before
  // touching it. Otherwise an owner of gym A could mark gym B's orders paid.
  const existing = await prisma.order.findFirst({
    where: { id, tenantId },
    select: { id: true, status: true, paidAt: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Idempotency: already paid → return current row, no second write.
  if (existing.status === "paid") {
    const row = await prisma.order.findUnique({ where: { id } });
    return NextResponse.json(row);
  }

  if (existing.status === "cancelled") {
    return NextResponse.json({ error: "Cannot mark a cancelled order as paid" }, { status: 409 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Reason is required (3–200 characters)", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: "paid",
        paidAt: new Date(),
        paidByUserId: userId,
      },
    });

    await logAudit({
      tenantId,
      userId,
      action: "order.mark_paid",
      entityType: "Order",
      entityId: id,
      metadata: { reason: parsed.data.reason, previousStatus: existing.status },
      req,
    });

    return NextResponse.json(updated);
  } catch (err) {
    return apiError("Failed to mark order paid", 500, err, "[orders.mark-paid]");
  }
}
