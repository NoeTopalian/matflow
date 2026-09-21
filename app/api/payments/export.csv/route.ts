import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { checkRateLimit } from "@/lib/rate-limit";
// Shared cell escaper WITH the formula-injection guard — the local copy this
// route used to carry quoted delimiters but not a leading =/+/-/@, so a member
// named "=cmd()" was exported as a live formula. See lib/csv.ts.
import { csvCell } from "@/lib/csv";

export async function GET(req: Request) {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

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
