/**
 * "Other accounts owing" (owner direction D9, Noe 23 Oct 2026): inactive or
 * cancelled accounts that still owe, loaded once for Reports, the Members
 * page and Payments → Outstanding so the three name the same people.
 *
 * The rule lives in lib/overdue.ts (otherOwingCandidateWhere +
 * otherOwingEvidence): a failed latest charge, or a stored "overdue". These
 * accounts are NOT chased and never enter "Payers overdue" or a member total;
 * every screen shows them under OTHER_OWING_COPY (lib/member-population.ts).
 *
 * Call inside withTenantContext with the same `tenantId`; the where carries it
 * explicitly (RLS is the backstop only).
 */
import type { Prisma } from "@prisma/client";
import { otherOwingCandidateWhere, otherOwingEvidence } from "@/lib/overdue";

export type OtherOwingRow = {
  memberId: string;
  memberName: string;
  /** "inactive" or "cancelled". */
  status: string;
  membershipType: string | null;
  accountType: string | null;
  /** A failed latest charge, or a payment status of "overdue" with no failed charge on record. */
  evidence: "failed_charge" | "marked_overdue";
  /** The failed charge's amount; null when marked overdue (no amount is invented). */
  amountPence: number | null;
  /** ISO time of the failed charge, when that is the evidence. */
  failedAt: string | null;
  reason: string | null;
};

/** Enough of a transaction client for the one read below (tests pass an in-memory fake). */
type MemberReader = { member: Pick<Prisma.TransactionClient["member"], "findMany"> };

/** The candidate scan is bounded; a club with more than this many has bigger problems than a total. */
const TAKE = 500;

export async function loadOtherAccountsOwing(tx: MemberReader, tenantId: string): Promise<OtherOwingRow[]> {
  const candidates = await tx.member.findMany({
    where: { tenantId, ...otherOwingCandidateWhere() },
    select: {
      id: true,
      name: true,
      status: true,
      paymentStatus: true,
      membershipType: true,
      accountType: true,
      // The latest SETTLED payment decides (lib/overdue otherOwingEvidence):
      // a successful payment after a failed one clears the debt.
      payments: {
        where: { tenantId, status: { in: ["succeeded", "failed"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, createdAt: true, amountPence: true, failureReason: true },
      },
    },
    take: TAKE,
  });
  if (candidates.length === TAKE) console.warn("[other-accounts-owing] candidate scan truncated", { tenantId, take: TAKE });

  const rows: OtherOwingRow[] = [];
  for (const m of candidates) {
    const evidence = otherOwingEvidence(m);
    if (!evidence) continue;
    rows.push({
      memberId: m.id,
      memberName: m.name,
      status: m.status,
      membershipType: m.membershipType ?? null,
      accountType: m.accountType ?? null,
      evidence: evidence.kind,
      amountPence: evidence.kind === "failed_charge" ? evidence.amountPence : null,
      failedAt: evidence.kind === "failed_charge" ? evidence.at.toISOString() : null,
      reason: evidence.kind === "failed_charge" ? evidence.reason : null,
    });
  }
  // Most recent failure first, then name — stable for the screen and tests.
  rows.sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? "") || a.memberName.localeCompare(b.memberName));
  return rows;
}

/** The count and the guardian count every surface prints. */
export function otherOwingTotals(rows: Pick<OtherOwingRow, "accountType">[]): { count: number; guardians: number } {
  return { count: rows.length, guardians: rows.filter((r) => r.accountType === "parent").length };
}
