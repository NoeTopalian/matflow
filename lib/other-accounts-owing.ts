/**
 * Inactive or cancelled accounts with a money question, loaded once for
 * Reports, the Members page and Payments → Outstanding so the three name the
 * same people (owner direction D9, Noe 23 Oct 2026; split by the owner
 * instruction of 24 Oct 2026: a failed payment is not automatically a debt).
 *
 * The rule lives in lib/overdue.ts (otherOwingCandidateWhere +
 * otherOwingEvidence). Two groups, never merged:
 * - "Other accounts owing" — a CONFIRMED debt: payment status "overdue";
 * - "Last charge failed — to reconcile" — the latest charge failed and
 *   nothing confirms a debt: check it before treating it as owed.
 * Neither is chased, neither enters "Payers overdue" or a member total; every
 * screen shows them under OTHER_OWING_COPY and FAILED_TO_RECONCILE_COPY
 * (lib/member-population.ts).
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
  /**
   * "marked_overdue": a confirmed debt (Other accounts owing).
   * "failed_charge": the latest charge failed, nothing confirms a debt (to reconcile).
   */
  evidence: "failed_charge" | "marked_overdue";
  /** The latest failed charge's amount, when there is one; never an invented amount. */
  amountPence: number | null;
  /** ISO time of the latest failed charge, when there is one. */
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
      // a successful payment after a failed one clears it.
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
    const failed = evidence.kind === "failed_charge" ? evidence : evidence.failed;
    rows.push({
      memberId: m.id,
      memberName: m.name,
      status: m.status,
      membershipType: m.membershipType ?? null,
      accountType: m.accountType ?? null,
      evidence: evidence.kind,
      amountPence: failed ? failed.amountPence : null,
      failedAt: failed ? failed.at.toISOString() : null,
      reason: failed ? failed.reason : null,
    });
  }
  // Most recent failure first, then name — stable for the screen and tests.
  rows.sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? "") || a.memberName.localeCompare(b.memberName));
  return rows;
}

/** A confirmed debt (Other accounts owing), as opposed to a failed charge to reconcile. */
export function isConfirmedDebt(r: Pick<OtherOwingRow, "evidence">): boolean {
  return r.evidence === "marked_overdue";
}

/**
 * The counts every surface prints: confirmed debts (`count`, `guardians`) and
 * failed charges to reconcile (`toReconcile`, `toReconcileGuardians`), apart.
 */
export function otherOwingTotals(rows: Pick<OtherOwingRow, "accountType" | "evidence">[]): {
  count: number;
  guardians: number;
  toReconcile: number;
  toReconcileGuardians: number;
} {
  const confirmed = rows.filter(isConfirmedDebt);
  const reconcile = rows.filter((r) => !isConfirmedDebt(r));
  return {
    count: confirmed.length,
    guardians: confirmed.filter((r) => r.accountType === "parent").length,
    toReconcile: reconcile.length,
    toReconcileGuardians: reconcile.filter((r) => r.accountType === "parent").length,
  };
}
