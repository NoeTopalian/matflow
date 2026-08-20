import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin", "coach"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const rows = await withTenantContext(session.user.tenantId, (tx) =>
    tx.payment.findMany({
      where: { memberId: id, tenantId: session.user.tenantId },
      orderBy: { paidAt: "desc" },
      take: 100,
      select: {
        id: true,
        amountPence: true,
        currency: true,
        status: true,
        description: true,
        paidAt: true,
        createdAt: true,
        // Selected only to derive `method` below — the raw Stripe ids are
        // stripped from the response, they never reach the client.
        stripePaymentIntentId: true,
        stripeInvoiceId: true,
      },
    }),
  );

  // The profile's payments table shows how the money arrived. There is no
  // `method` column on Payment, so rather than invent one (UI-RULES §7 — never
  // render fabricated data) it is derived from what the row genuinely holds:
  // a Stripe intent/invoice id means the card rails, anything else was booked
  // by staff through /api/payments/manual.
  const payments = rows.map(({ stripePaymentIntentId, stripeInvoiceId, ...p }) => ({
    ...p,
    method: stripePaymentIntentId || stripeInvoiceId ? "card" : "manual",
  }));

  return NextResponse.json({ payments });
}
