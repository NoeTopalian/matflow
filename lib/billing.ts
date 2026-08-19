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
  /** From the member's most recent failed Payment, when available. */
  amountPence: number | null;
  reason: string | null;
  daysOverdue: number | null;
  lastAttempt: string | null; // ISO
};

export type OutstandingInput = {
  now: Date;
  overdueMembers: { id: string; name: string; membershipType: string | null }[];
  /** memberId → the member's most recent failed Payment. */
  latestFailed: Map<string, { amountPence: number; createdAt: Date; failureReason: string | null }>;
};

function daysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

export function buildOutstandingRows(input: OutstandingInput): OutstandingRow[] {
  const rows: OutstandingRow[] = input.overdueMembers.map((m) => {
    const failed = input.latestFailed.get(m.id) ?? null;
    return {
      memberId: m.id,
      memberName: m.name,
      membershipType: m.membershipType,
      amountPence: failed?.amountPence ?? null,
      reason: failed?.failureReason ?? null,
      daysOverdue: failed ? daysBetween(input.now, failed.createdAt) : null,
      lastAttempt: failed ? failed.createdAt.toISOString() : null,
    };
  });

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
