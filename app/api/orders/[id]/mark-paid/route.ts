import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

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
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  // Tenant-scope guard — confirm the order belongs to this tenant before
  // touching it. Otherwise an owner of gym A could mark gym B's orders paid.
  const existing = await withTenantContext(tenantId, (tx) =>
    tx.order.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, paidAt: true },
    }),
  );
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Idempotency: already paid → return current row, no second write.
  if (existing.status === "paid") {
    const row = await withTenantContext(tenantId, (tx) =>
      tx.order.findFirst({ where: { id, tenantId } }),
    );
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
    // The idempotency check above is a READ. Two tills (or one double-tap, or
    // the retry of a request whose response was lost) both read `pending`,
    // both fall through, and an unconditional `update` then runs twice: the
    // second overwrites `paidAt`/`paidByUserId` with the wrong staff member
    // and, worse, writes a SECOND `order.mark_paid` audit row — so the
    // reconciliation trail says the club collected the money twice.
    //
    // `updateMany` with the status in the WHERE clause makes the transition
    // itself the lock: Postgres serialises the two updates on the row, the
    // loser matches nothing and gets `count: 0`, and it returns the settled
    // row without a second write or a second audit entry. `tenantId` stays in
    // the clause so this can never widen past the guard above.
    const { count } = await withTenantContext(tenantId, (tx) =>
      tx.order.updateMany({
        where: { id, tenantId, status: "pending" },
        data: {
          status: "paid",
          paidAt: new Date(),
          paidByUserId: userId,
        },
      }),
    );

    if (count === 0) {
      // Someone else settled it between our read and our write. Same answer as
      // the already-paid branch: the current row, no audit entry of our own.
      const row = await withTenantContext(tenantId, (tx) =>
        tx.order.findFirst({ where: { id, tenantId } }),
      );
      if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(row);
    }

    const updated = await withTenantContext(tenantId, (tx) =>
      tx.order.findFirst({ where: { id, tenantId } }),
    );

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
