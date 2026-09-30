/**
 * Accounts-receivable ("who owes me") shaping for the payments hub.
 *
 * Turns the raw overdue-member + failed-payment data into a ranked list of
 * outstanding rows (most overdue / largest first). Pure + deterministic so the
 * ranking + day math are unit-tested; the Prisma queries live in
 * app/api/payments/outstanding/route.ts and feed this builder. The same data
 * powers the dashboard "money" action items.
 */

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
};

/** The reason a "No payment yet" row carries, shown beside the plan name. */
export const NO_PAYMENT_YET_REASON = "No payment yet";

export type OutstandingInput = {
  now: Date;
  overdueMembers: { id: string; name: string; membershipType: string | null; nextDueAt?: Date | null; planPricePence?: number | null; billedBy?: string }[];
  /** memberId → the member's most recent failed Payment. */
  latestFailed: Map<string, { amountPence: number; createdAt: Date; failureReason: string | null }>;
  /**
   * Members on a plan with "No payment yet" (paymentStatus "pending"),
   * MatFlow-billed only — TeamUp's members are TeamUp's to chase.
   */
  noPaymentYetMembers?: { id: string; name: string; membershipType: string | null; planPricePence?: number | null; billedBy?: string }[];
};

function daysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

export function buildOutstandingRows(input: OutstandingInput): OutstandingRow[] {
  const noPaymentYet = (input.noPaymentYetMembers ?? []).filter((m) => m.billedBy !== "teamup");
  const pendingIds = new Set(noPaymentYet.map((m) => m.id));
  // One row per member. A "No payment yet" member whose tier-seeded due date
  // has also passed would match the overdue rule too; the plainer reason wins
  // unless a real failed charge says more.
  const overdue = input.overdueMembers.filter((m) => !pendingIds.has(m.id) || input.latestFailed.has(m.id));
  const overdueIds = new Set(overdue.map((m) => m.id));
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
      kind: "overdue",
    };
  });

  for (const m of noPaymentYet) {
    if (overdueIds.has(m.id)) continue;
    rows.push({
      memberId: m.id,
      memberName: m.name,
      membershipType: m.membershipType,
      amountPence: m.planPricePence ?? null,
      amountSource: m.planPricePence != null ? "plan_price" : null,
      reason: NO_PAYMENT_YET_REASON,
      daysOverdue: null,
      lastAttempt: null,
      ...(m.billedBy ? { billedBy: m.billedBy } : {}),
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

/** Total outstanding amount we can quantify (known failed amounts only). */
export function totalOutstandingPence(rows: OutstandingRow[]): number {
  return rows.reduce((sum, r) => sum + (r.amountPence ?? 0), 0);
}
