/**
 * Calendar-month windows for the Analysis page (T2c, 17 Oct 2026).
 *
 * Every window is HALF-OPEN: `gte start, lt nextStart`, the same shape
 * Reports uses for its months. The Analysis page used to close last month at
 * `lte <00:00 on its last day>`, so anyone who joined (or checked in) after
 * midnight on the last day of the previous month fell out of both months.
 *
 * Built from the server's local calendar fields, as before; the reporting
 * clock and zone are T2d's (it moves this helper into lib/report-clock.ts).
 * Pure: no I/O, so the boundaries are unit-testable with synthetic instants.
 */
export type MonthWindows = {
  /** 00:00 on the 1st of the current month. */
  startOfMonth: Date;
  /** 00:00 on the 1st of the previous month. Last month = [startOfLastMonth, startOfMonth). */
  startOfLastMonth: Date;
  /** 00:00 on the 1st of the month five months back: the six-month trend starts here. */
  sixMonthsAgo: Date;
};

export function monthWindows(now: Date): MonthWindows {
  const y = now.getFullYear();
  const m = now.getMonth();
  return {
    startOfMonth: new Date(y, m, 1),
    startOfLastMonth: new Date(y, m - 1, 1),
    sixMonthsAgo: new Date(y, m - 5, 1),
  };
}
