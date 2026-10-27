/**
 * Percentage helpers shared by Reports (server) and its screens (client).
 * Pure, no imports. Multiply BEFORE dividing: n * 100 is an exact integer, so
 * an exact .5 result (29 of 200 = 14.5) is held exactly and Math.round takes
 * it half-up. The old `Math.round((n / base) * 100)` divided first and read
 * 14.499999999999998, so 29 of 200 showed "14%" (review L6).
 */

/** n ÷ total as a whole percentage, half-up; 0 when total <= 0. */
export function percent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count * 100) / total);
}

/** n ÷ base as a percentage to one decimal place, half-up; null when the base is 0. */
export function ratePct1dp(n: number, base: number): number | null {
  if (base <= 0) return null;
  return Math.round((n * 1000) / base) / 10;
}

/** n ÷ base as a whole percentage, or null when the base is 0 (never NaN, never a fake 0). */
export function wholePct(n: number, base: number): number | null {
  return base > 0 ? percent(n, base) : null;
}

/*
 * Display text. Every percentage a person reads carries its count and base
 * (required by Sean's note relayed 14 Oct and the owner instruction of 24 Oct
 * 2026): "42% (21 of 50)". These live here, not in the client-only Reports
 * primitives, so server code (the AI report prompt) prints the same text the
 * screens do. `components/dashboard/reports-primitives.tsx` re-exports them.
 */

const count = (x: number) => x.toLocaleString("en-GB");

/** The percentage half of `formatRatio` ("10%", "3.2%"), or "—" on an empty base or an undefined rate. */
export function formatPct(pct: number | null, base: number): string {
  if (base <= 0 || pct === null || !Number.isFinite(pct)) return "—";
  return `${pct.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
}

/** The counts half of `formatRatio`: "(1 of 10)". */
export function ratioCounts(n: number, base: number): string {
  return `(${count(n)} of ${count(base)})`;
}

/**
 * A rate with its count and base: "10% (1 of 10)". `pct` is the
 * already-computed percentage (it may carry one decimal). A base of 0, or a
 * null or non-finite pct, renders "—": an undefined rate is never "0%"
 * (MATFLOW-SPECIFICATION-2026-10.md:144, divide-by-zero → null). Counts use
 * en-GB grouping ("1,234").
 */
export function formatRatio(pct: number | null, n: number, base: number): string {
  const p = formatPct(pct, base);
  return p === "—" ? p : `${p} ${ratioCounts(n, base)}`;
}

/**
 * A rate behind a minimum-sample guard (the conversion funnel: a rate over
 * fewer than `MIN_TRIALS_FOR_RATE` trials is null). Two guards, both visible:
 * no base at all is "—" (never "0%" or "NaN%"); a base under the minimum is
 * "N/A · too few (1 of 2)", the counts without a percentage. Otherwise
 * `formatRatio`: "12.5% (5 of 40)".
 */
export function formatGuardedRatio(rate: number | null, n: number, base: number): string {
  if (base <= 0) return "—";
  if (rate === null || !Number.isFinite(rate)) return `N/A · too few ${ratioCounts(n, base)}`;
  return formatRatio(rate, n, base);
}

/** `formatGuardedRatio` saying what the base is when there is a percentage: "12.5% (5 of 40) of trials". */
export function formatGuardedRatioNote(rate: number | null, n: number, base: number, suffix: string): string {
  const text = formatGuardedRatio(rate, n, base);
  return base > 0 && rate !== null && Number.isFinite(rate) ? `${text} ${suffix}` : text;
}

/**
 * The change from `previous` to `current` as a whole percentage, half-up, or
 * null when there is nothing to compare against (previous is 0). Multiply
 * first, like `percent`: 229 vs 200 is +15 (an exact 14.5), where dividing
 * first read 14.499999999999998 and gave +14. Every change badge, pill and
 * stored change goes through this, so one pair of numbers reads one way.
 */
export function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) * 100) / previous);
}

/**
 * A percentage change with the two figures it compares: "+12% (56 vs 50)",
 * "-4% (48 vs 50)", "0% (50 vs 50)". With nothing to compare against
 * (previous is 0) there is no percentage: "—".
 */
export function formatChange(current: number, previous: number): string {
  const pct = pctChange(current, previous);
  if (pct === null) return "—";
  return `${pct > 0 ? "+" : ""}${pct}% (${count(current)} vs ${count(previous)})`;
}
