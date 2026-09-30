/**
 * "Collected today £X · this month £Y" for the payments hub (decision 1,
 * 30 Sep 2026). The end-of-day owner could see "3 payments total" and no
 * money anywhere, so the till could not be reconciled against the screen.
 *
 * Computed on the server, in the CLUB's time zone: a London club's "today"
 * starts at London midnight, not at the server's (UTC on Vercel) — a £40 taken
 * at 00:30 BST belongs to today, not to yesterday. Pure, so the boundaries are
 * unit-tested; the query lives in app/api/payments/route.ts.
 */
import { zoneOffsetMs } from "@/lib/class-time";

/** The instant a wall-clock midnight occurs in `timeZone` (two-pass for DST). */
function zonedMidnight(year: number, monthIndex: number, day: number, timeZone: string): Date {
  const naive = Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
  const first = zoneOffsetMs(new Date(naive), timeZone);
  let instant = naive - first;
  const second = zoneOffsetMs(new Date(instant), timeZone);
  if (second !== first) instant = naive - second;
  return new Date(instant);
}

/** Start of the club's calendar day and calendar month containing `now`. */
export function collectionWindows(now: Date, timeZone: string): { dayStart: Date; monthStart: Date } {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return { dayStart: zonedMidnight(y, m, d, timeZone), monthStart: zonedMidnight(y, m, 1, timeZone) };
}

export type CollectedPaymentRow = {
  amountPence: number;
  status: string;
  paidAt: Date | null;
  createdAt: Date;
  refundedAmountPence?: number | null;
};

/**
 * Money actually kept: succeeded payments only (cash and card alike), less any
 * partial refund on them. A fully refunded payment is status "refunded" and
 * counts nothing; failed, pending and disputed ones were never collected.
 * The payment's date is when it was paid (`paidAt`, which the desk may
 * backdate), falling back to when the row was written.
 */
export function sumCollected(
  rows: CollectedPaymentRow[],
  windows: { dayStart: Date; monthStart: Date },
): { todayPence: number; monthPence: number } {
  let todayPence = 0;
  let monthPence = 0;
  for (const r of rows) {
    if (r.status !== "succeeded") continue;
    const at = (r.paidAt ?? r.createdAt).getTime();
    const kept = Math.max(0, r.amountPence - (r.refundedAmountPence ?? 0));
    if (at >= windows.monthStart.getTime()) monthPence += kept;
    if (at >= windows.dayStart.getTime()) todayPence += kept;
  }
  return { todayPence, monthPence };
}

function formatMoney(pence: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
}

/** "Collected today £X · this month £Y" — the line the till reconciles against. */
export function collectedLine(c: { todayPence: number; monthPence: number; currency: string }): string {
  return `Collected today ${formatMoney(c.todayPence, c.currency)} · this month ${formatMoney(c.monthPence, c.currency)}`;
}
