/**
 * Accounts-receivable ("who owes me") shaping for the payments hub.
 *
 * Turns the raw overdue-member + failed-payment data into a ranked list of
 * outstanding rows (most overdue / largest first). Pure + deterministic so the
 * ranking + day math are unit-tested; the Prisma queries live in
 * app/api/payments/outstanding/route.ts and feed this builder. The same data
 * powers the dashboard "money" action items.
 *
 * Rows are PAYERS (review L2, 23 Oct 2026): any account that owes, guardians
 * who pay included, and the panel says so.
 */
import { payerGuardianNote, payersLabel, payersOverdueLabel } from "@/lib/member-population";

export type OutstandingRow = {
  memberId: string;
  memberName: string;
  membershipType: string | null;
  /**
   * The most recent failed Payment's amount, or — for a member overdue by due
   * date (cash, standing order) with no failed charge — their plan's price.
   */
  amountPence: number | null;
  /** Where amountPence came from, so the screen can say so. */
  amountSource: "failed_charge" | "plan_price" | null;
  reason: string | null;
  daysOverdue: number | null;
  lastAttempt: string | null; // ISO
  /** Who collects this member's money ("teamup" during the bridge, readiness spec v3 §7). */
  billedBy?: string;
  /**
   * "no_payment_yet": a member on a plan with nothing ever recorded (decision
   * 1, 30 Sep 2026). Not overdue — the screen says "No payment yet" instead of
   * a count of days.
   */
  kind?: "overdue" | "no_payment_yet";
  /** A parent or guardian account that pays (review L2) — counted, and named as such in the summary. */
  payerIsGuardian?: boolean;
};

/** The reason a "No payment yet" row carries, shown beside the plan name. */
export const NO_PAYMENT_YET_REASON = "No payment yet";

export type OutstandingInput = {
  now: Date;
  overdueMembers: { id: string; name: string; membershipType: string | null; nextDueAt?: Date | null; planPricePence?: number | null; billedBy?: string; accountType?: string | null }[];
  /** memberId → the member's most recent failed Payment. */
  latestFailed: Map<string, { amountPence: number; createdAt: Date; failureReason: string | null }>;
  /**
   * Members on a plan with "No payment yet" (paymentStatus "pending"),
   * MatFlow-billed only — TeamUp's members are TeamUp's to chase.
   */
  noPaymentYetMembers?: { id: string; name: string; membershipType: string | null; planPricePence?: number | null; billedBy?: string; accountType?: string | null }[];
};

function daysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

export function buildOutstandingRows(input: OutstandingInput): OutstandingRow[] {
  const noPaymentYet = (input.noPaymentYetMembers ?? []).filter((m) => m.billedBy !== "teamup");
  const pendingIds = new Set(noPaymentYet.map((m) => m.id));
  // One row per member. A "No payment yet" member whose tier-seeded due date
  // has also passed matches the overdue rule too; "No payment yet" always
  // wins, failed charge or not (round-3 review M1, 23 Oct 2026). Reports and
  // the Members page split payers the same way (lib/overdue
  // overduePayerWhere), so the three split lines cannot contradict each
  // other. A failed charge still shows: its amount, reason, date and age stay
  // on the No-payment-yet row.
  const overdue = input.overdueMembers.filter((m) => !pendingIds.has(m.id));
  const rows: OutstandingRow[] = overdue.map((m) => {
    const failed = input.latestFailed.get(m.id) ?? null;
    return {
      memberId: m.id,
      memberName: m.name,
      membershipType: m.membershipType,
      amountPence: failed?.amountPence ?? m.planPricePence ?? null,
      amountSource: failed ? "failed_charge" : m.planPricePence != null ? "plan_price" : null,
      reason: failed?.failureReason ?? null,
      // Age from the failed charge, else from the missed due date (verifier
      // lane 4, 30 Sep 2026: date-derived rows showed "— Overdue", £0.00).
      daysOverdue: failed ? daysBetween(input.now, failed.createdAt) : m.nextDueAt ? daysBetween(input.now, m.nextDueAt) : null,
      lastAttempt: failed ? failed.createdAt.toISOString() : null,
      ...(m.billedBy ? { billedBy: m.billedBy } : {}),
      ...(m.accountType === "parent" ? { payerIsGuardian: true } : {}),
      kind: "overdue",
    };
  });

  for (const m of noPaymentYet) {
    const failed = input.latestFailed.get(m.id) ?? null;
    rows.push({
      memberId: m.id,
      memberName: m.name,
      membershipType: m.membershipType,
      amountPence: failed?.amountPence ?? m.planPricePence ?? null,
      amountSource: failed ? "failed_charge" : m.planPricePence != null ? "plan_price" : null,
      reason: failed?.failureReason ?? NO_PAYMENT_YET_REASON,
      daysOverdue: failed ? daysBetween(input.now, failed.createdAt) : null,
      lastAttempt: failed ? failed.createdAt.toISOString() : null,
      ...(m.billedBy ? { billedBy: m.billedBy } : {}),
      ...(m.accountType === "parent" ? { payerIsGuardian: true } : {}),
      kind: "no_payment_yet",
    });
  }

  // Most overdue first; rows with a known age rank above bare "overdue" rows;
  // ties broken by amount, then name (stable, deterministic).
  rows.sort((a, b) => {
    const ad = a.daysOverdue ?? -1;
    const bd = b.daysOverdue ?? -1;
    if (ad !== bd) return bd - ad;
    const aa = a.amountPence ?? 0;
    const ba = b.amountPence ?? 0;
    if (aa !== ba) return ba - aa;
    return a.memberName.localeCompare(b.memberName);
  });

  return rows;
}

/**
 * The Outstanding panel's summary, in the payer words Reports and the Members
 * page use (review L2): "3 payers", "2 payers overdue · 1 with no payment
 * yet", and the guardian note. Overdue and "No payment yet" partition the
 * rows, so the two always add up to the total.
 */
export function outstandingPayerSummary(rows: Pick<OutstandingRow, "kind" | "payerIsGuardian">[]): {
  payers: number;
  overdue: number;
  noPaymentYet: number;
  guardians: number;
  headline: string;
  split: string;
  guardianNote: string;
} {
  const noPaymentYet = rows.filter((r) => r.kind === "no_payment_yet").length;
  const overdue = rows.length - noPaymentYet;
  const guardians = rows.filter((r) => r.payerIsGuardian).length;
  return {
    payers: rows.length,
    overdue,
    noPaymentYet,
    guardians,
    headline: payersLabel(rows.length),
    split: `${payersOverdueLabel(overdue)} · ${noPaymentYet.toLocaleString("en-GB")} with no payment yet`,
    guardianNote: payerGuardianNote(guardians),
  };
}

/** Total outstanding amount we can quantify (known failed amounts only). */
export function totalOutstandingPence(rows: OutstandingRow[]): number {
  return rows.reduce((sum, r) => sum + (r.amountPence ?? 0), 0);
}

/**
 * The sentence under Reports → Payment Health. "All payments are in good
 * standing" only when nobody is overdue, nothing failed AND nobody is on "No
 * payment yet" — Payments → Outstanding lists those members, so Reports must
 * not say everyone is fine (end-user check, 30 Sep 2026). "Overdue" keeps its
 * meaning; "No payment yet" is counted beside it.
 */
export function paymentHealthLine(h: {
  overdueCount: number;
  noPaymentYetCount?: number;
  /** D9: inactive or cancelled accounts that still owe. Never "all in good standing" while any do. */
  otherOwingCount?: number;
  /** Inactive or cancelled accounts whose last charge failed, to reconcile. Not owing, but not "good standing" either. */
  failedToReconcileCount?: number;
  failedLast30Days: number;
}): { tone: "good" | "owed"; text: string } | null {
  const noPaymentYet = h.noPaymentYetCount ?? 0;
  if (noPaymentYet > 0) {
    // Payer words (review L2), the same as Outstanding and the Members tile.
    return { tone: "owed", text: `${payersOverdueLabel(h.overdueCount)} · ${NO_PAYMENT_YET_REASON} ${noPaymentYet}` };
  }
  if (h.overdueCount === 0 && h.failedLast30Days === 0 && (h.otherOwingCount ?? 0) === 0 && (h.failedToReconcileCount ?? 0) === 0) {
    return { tone: "good", text: "All payments are in good standing." };
  }
  return null;
}
