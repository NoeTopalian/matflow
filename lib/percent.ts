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
