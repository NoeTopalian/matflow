/**
 * lg-3's expectation for the retention cron, made explicit (security campaign iteration 2, lane M2, SF-128,
 * 10 Oct 2026; authorised by Noe 10 Oct 23:29 Italy).
 *
 * The route answers a valid bearer with 503 `retention cron disabled` unless RETENTION_CRON_ENABLED is exactly
 * "true" (lane M1 v2), and `?dryRun=1` always counts and deletes nothing. The spec never opens the gate itself: it
 * reads the state from the environment it shares with the server (playwright.config.ts loads .env.test with
 * override; the e2e job sets the variable at job level, for its ephemeral database, so both processes see it). The
 * shared local .env.test carries NO gate line, so a local run against the shared TEST branch expects the named 503
 * and never triggers a live sweep (R8: that branch holds foreign soft-deleted tenants a sweep would purge).
 *
 * Pure functions, no Playwright import, so tests/unit/sec-m2-lg3-retention-matcher.test.ts can prove them against
 * the real route handler.
 */

export const RETENTION_DISABLED_ERROR = "retention cron disabled";

export type CronAnswer = { status: number; body: unknown };

/** The gate exactly as app/api/cron/retention/route.ts reads it. */
export function retentionGateOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_CRON_ENABLED === "true";
}

type Body = {
  error?: unknown;
  dryRun?: unknown;
  retentionEnabled?: unknown;
  note?: unknown;
  results?: Array<{ rule?: unknown; deleted?: unknown; skipped?: unknown; details?: Record<string, unknown> }>;
};

/**
 * A plain bearer call (no dry run). Returns null when the answer is what the gate state requires, otherwise why
 * not. Gate off: exactly the named 503 — a 200 would mean a LIVE sweep ran against a database the spec believes is
 * protected. Gate on: a live 200 with dryRun false (never a 500: a failed rule is a failure).
 */
export function retentionBearerVerdict(a: CronAnswer, gateOn: boolean): string | null {
  const b = (a.body ?? {}) as Body;
  if (!gateOn) {
    if (a.status === 503 && b.error === RETENTION_DISABLED_ERROR) return null;
    if (a.status === 200) return "gate believed OFF but the server ran a live sweep (its RETENTION_CRON_ENABLED differs)";
    return `gate OFF expects 503 "${RETENTION_DISABLED_ERROR}", got ${a.status} ${JSON.stringify(b.error ?? null)}`;
  }
  if (a.status === 503 && b.error === RETENTION_DISABLED_ERROR) {
    return "gate believed ON but the server answered disabled (its RETENTION_CRON_ENABLED differs)";
  }
  if (a.status !== 200) return `gate ON expects a 200 sweep, got ${a.status}`;
  if (b.dryRun !== false || b.retentionEnabled !== true) return "gate ON: the sweep must report dryRun false and retentionEnabled true";
  if (!Array.isArray(b.results) || b.results.length === 0) return "gate ON: the sweep reported no rules";
  return null;
}

/**
 * A `?dryRun=1` call. Returns null when it counted and deleted nothing and reported the gate truthfully.
 */
export function retentionDryRunVerdict(a: CronAnswer, gateOn: boolean): string | null {
  const b = (a.body ?? {}) as Body;
  if (a.status !== 200) return `dry run expects 200, got ${a.status}`;
  if (b.dryRun !== true) return "dry run: the body must say dryRun true";
  if (b.retentionEnabled !== gateOn) return `dry run: retentionEnabled ${String(b.retentionEnabled)} but the gate is ${gateOn ? "on" : "off"}`;
  if (!gateOn) {
    const note = typeof b.note === "string" ? b.note : "";
    if (!/retention cron disabled/i.test(note) || !/dry run/i.test(note)) return "dry run with the gate off: the note must say so";
  }
  const results = Array.isArray(b.results) ? b.results : [];
  if (results.length === 0) return "dry run: no rules reported";
  const deleting = results.filter((r) => !r.skipped && r.deleted !== 0);
  if (deleting.length > 0) return `dry run: rule(s) deleted rows: ${deleting.map((r) => String(r.rule)).join(", ")}`;
  const counted = results.some((r) =>
    ["wouldDelete", "wouldScrub", "candidates"].some((k) => typeof r.details?.[k] === "number"),
  );
  if (!counted) return "dry run: no rule reported a count";
  return null;
}
