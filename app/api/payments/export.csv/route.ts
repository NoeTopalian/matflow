import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
// Shared cell escaper WITH the formula-injection guard — the local copy this
// route used to carry quoted delimiters but not a leading =/+/-/@, so a member
// named "=cmd()" was exported as a live formula. See lib/csv.ts.
import { csvCell } from "@/lib/csv";

export async function GET(req: Request) {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

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

  // Bulk PII egress (member names, emails, amounts) must leave a trail — who
  // exported, when, how many rows. A manager or owner can pull every member's
  // payment history off-platform; the rest of the product audits far less
  // sensitive actions, so this one must too (spec R-PII-1, 1 Oct 2026).
  await logAudit({
    tenantId,
    userId,
    action: "payments.export",
    entityType: "Payment",
    entityId: "export",
    metadata: { format: "csv", rowCount: rows.length },
    req,
  });

  // "Paid on" is when the money changed hands (a desk payment back-dated to
  // 15 Sep says 15 Sep, as the Payments screen does); "Recorded at" is when it
  // was entered. The export used to label the record time "Date" (verifier
  // lane 4, 30 Sep 2026).
  const header = ["Paid on", "Member name", "Member email", "Amount (pence)", "Currency", "Status", "Description", "Stripe invoice", "Stripe payment intent", "Refunded at", "Refunded (pence)", "Recorded at"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      (r.paidAt ?? r.createdAt).toISOString(),
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
      r.createdAt.toISOString(),
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
