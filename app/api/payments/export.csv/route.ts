import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { requireOwnerOrManager } from "@/lib/authz";
import { checkRateLimit } from "@/lib/rate-limit";

function csvCell(v: string | number | null | undefined) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(req: Request) {
  const { tenantId } = await requireOwnerOrManager();

  const rl = await checkRateLimit(`payments:export:${tenantId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many exports. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const rows = await withTenantContext(tenantId, (tx) =>
    tx.payment.findMany({
      where: { tenantId },
      include: { member: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 5000,
    }),
  );

  const header = ["Date", "Member name", "Member email", "Amount (pence)", "Currency", "Status", "Description", "Stripe invoice", "Stripe payment intent", "Refunded at", "Refunded (pence)"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      r.createdAt.toISOString(),
      r.member?.name ?? "",
      r.member?.email ?? "",
      r.amountPence,
      r.currency,
      r.status,
      r.description ?? "",
      r.stripeInvoiceId ?? "",
      r.stripePaymentIntentId ?? "",
      r.refundedAt?.toISOString() ?? "",
      r.refundedAmountPence ?? "",
    ].map(csvCell).join(","));
  }

  const csv = lines.join("\r\n");
  const filename = `matflow-payments-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
