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
import { overdueClause, noPaymentYetPayerWhere } from "@/lib/overdue";
import { CHASEABLE_PAYER } from "@/lib/member-population";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { buildOutstandingRows, totalOutstandingPence } from "@/lib/billing";
import { loadOtherAccountsOwing } from "@/lib/other-accounts-owing";

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
    const [overdueMembers, failed, noPaymentYet, otherOwing] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.member.findMany({
          // Overdue is DERIVED, not only pushed. This used to read
          // `paymentStatus: "overdue"` alone, a value written at exactly two
          // lines in the codebase, both inside the Stripe webhook — so a club
          // collecting cash or by standing order generated no events and this
          // list was permanently empty. See lib/overdue.ts; the dashboard's
          // action list imports the same clause so the two cannot disagree.
          // PAYERS (review L2): active and taster accounts of any type — a
          // guardian who pays is listed, never dropped. The builder below takes
          // "No payment yet" out of overdue, as Reports and the Members tile do.
          where: { tenantId, ...CHASEABLE_PAYER, OR: overdueClause(now) },
          select: { id: true, name: true, membershipType: true, nextDueAt: true, billedBy: true, accountType: true, membershipTier: { select: { pricePence: true } } },
          take: 200,
        }),
        tx.payment.findMany({
          where: { tenantId, status: "failed", createdAt: { gte: ninetyDaysAgo }, memberId: { not: null } },
          select: { memberId: true, amountPence: true, createdAt: true, failureReason: true },
          orderBy: { createdAt: "desc" },
          take: 500,
        }),
        // Decision 1 (30 Sep 2026): a member on a plan whom nobody has ever
        // recorded a payment for owes the plan price — "No payment yet".
        // MatFlow-billed only: TeamUp's members are TeamUp's to collect.
        tx.member.findMany({
          where: { tenantId, ...noPaymentYetPayerWhere() },
          select: { id: true, name: true, membershipType: true, billedBy: true, accountType: true, membershipTier: { select: { pricePence: true } } },
          take: 200,
        }),
        // D9 (23 Oct 2026): inactive or cancelled accounts that still owe.
        // Returned beside the chase list, never inside it: they are not
        // chased and not in `total` or `totalPence`.
        loadOtherAccountsOwing(tx, tenantId),
      ]),
    );

    // Most-recent failed Payment per member (the list is already newest-first).
    const latestFailed = new Map<string, { amountPence: number; createdAt: Date; failureReason: string | null }>();
    for (const p of failed) {
      if (p.memberId && !latestFailed.has(p.memberId)) {
        latestFailed.set(p.memberId, { amountPence: p.amountPence, createdAt: p.createdAt, failureReason: p.failureReason });
      }
    }

    const rows = buildOutstandingRows({
      now,
      overdueMembers: overdueMembers.map((m) => ({ id: m.id, name: m.name, membershipType: m.membershipType, nextDueAt: m.nextDueAt, planPricePence: m.membershipTier?.pricePence ?? null, billedBy: m.billedBy, accountType: m.accountType })),
      latestFailed,
      noPaymentYetMembers: noPaymentYet.map((m) => ({ id: m.id, name: m.name, membershipType: m.membershipType, planPricePence: m.membershipTier?.pricePence ?? null, billedBy: m.billedBy, accountType: m.accountType })),
    });
    return NextResponse.json(
      { rows, total: rows.length, totalPence: totalOutstandingPence(rows), otherOwing },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    console.error("[api/payments/outstanding] failed", err);
    return NextResponse.json({ error: "Failed to load outstanding payments" }, { status: 500 });
  }
}
