/**
 * GET /api/payments/outstanding — owner only.
 *
 * The "who owes me" / accounts-receivable feed for the payments hub: every
 * active/taster member whose paymentStatus is "overdue", enriched with their
 * most recent failed Payment (amount, when, reason) and ranked most-overdue
 * first. Shaping + ranking live in lib/billing.ts (unit-tested).
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwner } from "@/lib/authz";
import { buildOutstandingRows, totalOutstandingPence } from "@/lib/billing";

export async function GET() {
  const { tenantId } = await requireOwner();

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

  try {
    const [overdueMembers, failed] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.member.findMany({
          where: { tenantId, status: { in: ["active", "taster"] }, paymentStatus: "overdue" },
          select: { id: true, name: true, membershipType: true },
          take: 200,
        }),
        tx.payment.findMany({
          where: { tenantId, status: "failed", createdAt: { gte: ninetyDaysAgo }, memberId: { not: null } },
          select: { memberId: true, amountPence: true, createdAt: true, failureReason: true },
          orderBy: { createdAt: "desc" },
          take: 500,
        }),
      ]),
    );

    // Most-recent failed Payment per member (the list is already newest-first).
    const latestFailed = new Map<string, { amountPence: number; createdAt: Date; failureReason: string | null }>();
    for (const p of failed) {
      if (p.memberId && !latestFailed.has(p.memberId)) {
        latestFailed.set(p.memberId, { amountPence: p.amountPence, createdAt: p.createdAt, failureReason: p.failureReason });
      }
    }

    const rows = buildOutstandingRows({ now, overdueMembers, latestFailed });
    return NextResponse.json(
      { rows, total: rows.length, totalPence: totalOutstandingPence(rows) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[api/payments/outstanding] failed", err);
    return NextResponse.json({ error: "Failed to load outstanding payments" }, { status: 500 });
  }
}
