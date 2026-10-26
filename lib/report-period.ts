/**
 * The period a statistics page reports on (Noe, 26 Oct 2026: "include the
 * option to change the time scales" on Reports and Analysis). One selector per
 * page; every period figure and chart on it follows the same range, so two
 * cards on one page can never disagree about which months they count.
 *
 * A period is a run of whole CLUB months (lib/club-month: Tenant.timezone,
 * half-open [monthStart, nextMonthStart)), ending with this month at the
 * latest. Presets: this month (the default, today's tiles' meaning), last
 * month, the last 3, 6 or 12 months (each ending with this month, counted to
 * today), or a custom run of months up to 24 long.
 *
 * Invalid or stale URL values degrade to the default rather than throwing —
 * the same rule as the Reports class and age filters: never a phantom filter.
 *
 * Pure: no I/O, safe in client components.
 */
import { clubMonthWindow, clubMonthWindowForKey, type ClubMonthWindow } from "@/lib/club-month";
import { usableTimezone } from "@/lib/class-time";

export const REPORT_PERIOD_KEYS = ["this-month", "last-month", "3m", "6m", "12m", "custom"] as const;
export type ReportPeriodKey = (typeof REPORT_PERIOD_KEYS)[number];

export const DEFAULT_REPORT_PERIOD: ReportPeriodKey = "this-month";
/** The longest custom period, in months. */
export const MAX_CUSTOM_MONTHS = 24;
/** Monthly charts show at least this many months; a shorter period is highlighted inside them. */
export const MIN_CHART_MONTHS = 6;

export const REPORT_PERIOD_OPTIONS: { key: ReportPeriodKey; label: string }[] = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "3m", label: "Last 3 months" },
  { key: "6m", label: "Last 6 months" },
  { key: "12m", label: "Last 12 months" },
  { key: "custom", label: "Custom months" },
];

/** One stretch of time as instants (ISO): counted from `start` up to and including `at`; `end` is exclusive. */
export type ReportSpan = {
  start: string;
  end: string;
  /** The last instant counted: now for a span that reaches today, else end − 1 ms. */
  at: string;
  label: string;
};

export type ReportRange = ReportSpan & {
  key: ReportPeriodKey;
  timeZone: string;
  /** "2026-08" — the first month of the period. */
  fromMonth: string;
  /** "2026-10" — the last month of the period. */
  toMonth: string;
  /** True when the period ends with the club's current month (counted to today). */
  isCurrent: boolean;
  /** The period's months, oldest first. */
  months: ClubMonthWindow[];
  /** The months a monthly chart shows: the period's, or the MIN_CHART_MONTHS ending with it when shorter. */
  chartMonths: ClubMonthWindow[];
  /** The same number of months straight before the period (comparisons). */
  previous: ReportSpan & { fromMonth: string; toMonth: string };
};

export type ReportPeriodParams = {
  period?: string | null;
  from?: string | null;
  to?: string | null;
  /** The pre-period Reports control ("last N weeks"); honoured only when `period` is absent. */
  weeks?: string | null;
};

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthIndex(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + (m - 1);
}

function keyOf(index: number): string {
  const y = Math.floor(index / 12);
  return `${y}-${String((index % 12) + 1).padStart(2, "0")}`;
}

const SHORT = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15, 12)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
};

/** "October 2026", "Aug – Oct 2026", "Nov 2025 – Oct 2026". */
export function monthsLabel(fromMonth: string, toMonth: string, timeZone: string): string {
  const to = clubMonthWindowForKey(toMonth, timeZone)!;
  if (fromMonth === toMonth) return to.label;
  const fromYear = fromMonth.slice(0, 4);
  const toYear = toMonth.slice(0, 4);
  return fromYear === toYear ? `${SHORT(fromMonth)} – ${SHORT(toMonth)} ${toYear}` : `${SHORT(fromMonth)} ${fromYear} – ${SHORT(toMonth)} ${toYear}`;
}

function span(fromMonth: string, toMonth: string, timeZone: string, now: Date): ReportSpan {
  const first = clubMonthWindowForKey(fromMonth, timeZone)!;
  const last = clubMonthWindowForKey(toMonth, timeZone)!;
  const endMs = new Date(last.nextMonthStart).getTime();
  const atMs = Math.min(endMs - 1, now.getTime());
  return { start: first.monthStart, end: last.nextMonthStart, at: new Date(atMs).toISOString(), label: monthsLabel(fromMonth, toMonth, timeZone) };
}

function monthsBetween(fromMonth: string, toMonth: string, timeZone: string): ClubMonthWindow[] {
  const out: ClubMonthWindow[] = [];
  for (let i = monthIndex(fromMonth); i <= monthIndex(toMonth); i += 1) out.push(clubMonthWindowForKey(keyOf(i), timeZone)!);
  return out;
}

/** The pre-period `?weeks=N` link, mapped to the nearest preset so old bookmarks keep working. */
function presetForWeeks(weeks: string | null | undefined): ReportPeriodKey | null {
  if (weeks == null || weeks === "") return null;
  const n = Number(weeks);
  if (!Number.isFinite(n)) return null;
  if (n <= 5) return "this-month";
  if (n <= 13) return "3m";
  return "6m";
}

/** Resolve the URL's period in the club's zone. Never throws; anything invalid is the default. */
export function resolveReportPeriod(params: ReportPeriodParams, now: Date, timeZoneRaw: string | null | undefined): ReportRange {
  const timeZone = usableTimezone(timeZoneRaw);
  const current = clubMonthWindow(now, timeZone).monthKey;
  const ci = monthIndex(current);

  let key: ReportPeriodKey =
    params.period && (REPORT_PERIOD_KEYS as readonly string[]).includes(params.period)
      ? (params.period as ReportPeriodKey)
      : (!params.period && presetForWeeks(params.weeks)) || DEFAULT_REPORT_PERIOD;

  let fromMonth = current;
  let toMonth = current;
  switch (key) {
    case "last-month":
      fromMonth = toMonth = keyOf(ci - 1);
      break;
    case "3m":
    case "6m":
    case "12m":
      fromMonth = keyOf(ci - (Number(key.slice(0, -1)) - 1));
      break;
    case "custom": {
      const from = params.from && MONTH_KEY.test(params.from) ? params.from : null;
      const to = params.to && MONTH_KEY.test(params.to) ? params.to : null;
      const fi = from ? monthIndex(from) : NaN;
      const ti = to ? monthIndex(to) : NaN;
      const ok = from && to && fi <= ti && ti <= ci && ti - fi + 1 <= MAX_CUSTOM_MONTHS;
      if (ok) {
        fromMonth = from;
        toMonth = to;
      } else {
        key = DEFAULT_REPORT_PERIOD;
      }
      break;
    }
    default:
      break;
  }

  const fi = monthIndex(fromMonth);
  const ti = monthIndex(toMonth);
  const length = ti - fi + 1;
  const chartFrom = length >= MIN_CHART_MONTHS ? fromMonth : keyOf(ti - (MIN_CHART_MONTHS - 1));
  return {
    key,
    timeZone,
    fromMonth,
    toMonth,
    isCurrent: toMonth === current,
    ...span(fromMonth, toMonth, timeZone, now),
    months: monthsBetween(fromMonth, toMonth, timeZone),
    chartMonths: monthsBetween(chartFrom, toMonth, timeZone),
    previous: { ...span(keyOf(fi - length), keyOf(fi - 1), timeZone, now), fromMonth: keyOf(fi - length), toMonth: keyOf(fi - 1) },
  };
}

/**
 * The period's part of a cache key, normalised without the club's zone: a
 * preset by name (an old `weeks` value mapped to its preset), a custom run as
 * "custom:FROM:TO" when both are months, otherwise the default. Two links for
 * the same preset share one entry; a custom run the resolver later refuses
 * (it ends after this month) just keys its own entry for the default figures.
 */
export function reportPeriodCacheKey(params: ReportPeriodParams): string {
  if (params.period === "custom") {
    return params.from && params.to && MONTH_KEY.test(params.from) && MONTH_KEY.test(params.to)
      ? `custom:${params.from}:${params.to}`
      : DEFAULT_REPORT_PERIOD;
  }
  if (params.period && (REPORT_PERIOD_KEYS as readonly string[]).includes(params.period)) return params.period;
  return (!params.period && presetForWeeks(params.weeks)) || DEFAULT_REPORT_PERIOD;
}

/**
 * The period as one month-shaped window (the Members drill-through's window):
 * start of its first month to the end of its last, labelled with its months.
 * A one-month period is that month; `isCurrent` ("this month" in the slice's
 * words) only for the current month on its own, never for a run.
 */
export function rangeAsMonthWindow(range: ReportRange): ClubMonthWindow & { isCurrent: boolean } {
  if (range.fromMonth === range.toMonth) return { ...range.months[0], isCurrent: range.isCurrent };
  return { timeZone: range.timeZone, monthStart: range.start, nextMonthStart: range.end, monthKey: range.toMonth, label: range.label, isCurrent: false };
}

/** True when `monthKey` is one of the period's months (charts highlight these). */
export function inReportRange(range: Pick<ReportRange, "fromMonth" | "toMonth">, monthKey: string): boolean {
  return monthKey >= range.fromMonth && monthKey <= range.toMonth;
}

/** The URL parameters that select `range` (the page links and the selector write these). */
export function reportPeriodParams(range: Pick<ReportRange, "key" | "fromMonth" | "toMonth">): Record<string, string> {
  if (range.key === "custom") return { period: "custom", from: range.fromMonth, to: range.toMonth };
  return { period: range.key };
}
