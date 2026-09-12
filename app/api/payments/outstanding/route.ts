/**
 * GET /api/payments/outstanding — owner only.
 *
 * The "who owes me" / accounts-receivable feed for the payments hub: every
 * active/taster member who is behind — either Stripe said so, or their due date
 * has passed with nothing recorded against it (lib/overdue.ts) — enriched with their
 * most recent failed Payment (amount, when, reason) and ranked most-overdue
 * first. Shaping + ranking live in lib/billing.ts (unit-tested).
 */
import { NextResponse } from "next/server";
import { overdueClause } from "@/lib/overdue";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { buildOutstandingRows, totalOutstandingPence } from "@/lib/billing";

export async function GET() {
  // requireApiOwnerOrManager, not the PAGE helper requireOwner.
  //
  // Two changes in one. The page helper REDIRECTS on refusal, so a fetch from
  // the browser followed the 307 to /login and got HTML — the caller's
  // res.json() then threw "Unexpected token '<'", which is a parse error
  // wearing the costume of a server fault. An API route must answer 403.
  //
  // And owner+manager rather than owner: POST /api/payments/manual is already
  // owner+manager, so recording a payment and seeing who owes were at two
  // different levels — a manager could tick someone off a list they were not
  // allowed to look at.
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);

  try {
    const [overdueMembers, failed] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.member.findMany({
          // Overdue is DERIVED, not only pushed. This used to read
          // `paymentStatus: "overdue"` alone, a value written at exactly two
          // lines in the codebase, both inside the Stripe webhook — so a club
          // collecting cash or by standing order generated no events and this
          // list was permanently empty. See lib/overdue.ts; the dashboard's
          // action list imports the same clause so the two cannot disagree.
          where: { tenantId, status: { in: ["active", "taster"] }, OR: overdueClause(now) },
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
