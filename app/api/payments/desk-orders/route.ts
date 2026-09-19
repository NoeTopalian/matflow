/**
 * GET /api/payments/desk-orders — owner + manager.
 *
 * The till's side of the club shop. A member who checks out on the "pay at the
 * desk" rail gets an `Order` at `pending` and a reference, and is told to show
 * it to staff (`app/member/shop/page.tsx`). Until this route existed there was
 * nowhere in the product a member of staff could see that order: the shop
 * advertised a thing the dashboard could not complete, and
 * `POST /api/orders/[id]/mark-paid` — which has been gated, tenant-scoped and
 * idempotent since LB-001 — had zero callers.
 *
 * Deliberately narrow:
 *   - `status: "pending"` only. Paid orders belong to history, cancelled ones
 *     are closed. This is a work queue, not a ledger.
 *   - `paymentMethod: "pay_at_desk"` only. A `stripe` order sitting at pending
 *     is a member mid-checkout, and offering staff a "mark paid" button for it
 *     would invite taking cash for a card payment that is still in flight.
 *     Stripe orders are settled by `checkout.session.completed`.
 *
 * It lives under `/api/payments/` rather than `/api/orders/` because it is the
 * payments hub's data: same gate as `/api/payments/outstanding`, same screen.
 *
 * Under the payments-page rule this is owner + manager — the same pair that may
 * record a manual payment, because marking a desk order paid IS recording one.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { apiError } from "@/lib/api-error";

/** A queue, not an archive — a club with more pending orders than this has a
 *  bigger problem than pagination, and the panel says so rather than silently
 *  truncating. */
const MAX_ROWS = 200;

export type DeskOrderItem = { name: string; quantity: number; price: number };

export type DeskOrderRow = {
  id: string;
  orderRef: string;
  memberId: string | null;
  memberName: string | null;
  items: DeskOrderItem[];
  totalPence: number;
  currency: string;
  createdAt: string;
};

/**
 * `Order.items` is a Json snapshot of the cart at order time, written by
 * `app/api/member/checkout/route.ts` as `[{id,name,price,quantity}]` where
 * `price` is in POUNDS (the route multiplies by 100 to reach `totalPence`).
 *
 * It is a `Json` column, so it is whatever was in it — including rows written
 * by an older shape. Parsed defensively: a row this cannot read is dropped
 * rather than crashing the queue, and the panel falls back to the reference and
 * the total, both of which are real columns.
 */
function parseItems(raw: unknown): DeskOrderItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskOrderItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : null;
    if (!name) continue;
    const quantity = typeof e.quantity === "number" && Number.isFinite(e.quantity) ? e.quantity : 1;
    const price = typeof e.price === "number" && Number.isFinite(e.price) ? e.price : 0;
    out.push({ name, quantity, price });
  }
  return out;
}

export async function GET() {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

  try {
    const orders = await withTenantContext(tenantId, (tx) =>
      tx.order.findMany({
        where: { tenantId, status: "pending", paymentMethod: "pay_at_desk" },
        select: {
          id: true,
          orderRef: true,
          memberId: true,
          items: true,
          totalPence: true,
          currency: true,
          createdAt: true,
          member: { select: { name: true } },
        },
        // Oldest first: the person who has been waiting longest is the one at
        // the desk. Newest-first is right for history and wrong for a queue.
        orderBy: { createdAt: "asc" },
        take: MAX_ROWS,
      }),
    );

    const rows: DeskOrderRow[] = orders.map((o) => ({
      id: o.id,
      orderRef: o.orderRef,
      memberId: o.memberId,
      memberName: o.member?.name ?? null,
      items: parseItems(o.items),
      totalPence: o.totalPence,
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    }));

    return NextResponse.json({
      orders: rows,
      total: rows.length,
      totalPence: rows.reduce((sum, r) => sum + r.totalPence, 0),
      truncated: rows.length === MAX_ROWS,
    });
  } catch (err) {
    return apiError("Couldn't load the desk orders", 500, err, "[payments.desk-orders]");
  }
}
