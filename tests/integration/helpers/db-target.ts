/**
 * Database-target classification for suites that are Neon-TEST-branch-specific by design (big fixtures, the demo
 * rotation tool). Decided once, from the URL string alone (no connection):
 *
 *   "none"   - no DATABASE_URL: the suite is skipped, as every DB suite is.
 *   "skip"   - a recognised local / CI target (localhost, loopback, or a single-label service host such as the CI
 *              Postgres service): the suite SKIPS with a visible reason. It is not a failure.
 *   "run"    - the Neon TEST branch (ep-hidden-salad): the suite RUNS.
 *   "refuse" - anything else: any other Neon endpoint (production is ep-bold-wave), any unrecognised remote host,
 *              an unparseable URL, or a URL that mentions the production endpoint anywhere. The suite THROWS.
 */
export const TEST_ENDPOINT = "ep-hidden-salad";
export const PRODUCTION_ENDPOINT = "ep-bold-wave";

export type DbTargetKind = "none" | "skip" | "run" | "refuse";

export function classifyDbTarget(url: string | undefined | null): DbTargetKind {
  const raw = (url ?? "").trim();
  if (!raw) return "none";
  // The production endpoint anywhere in the string (host, or Neon's endpoint=<id>$password routing form) is a refusal.
  if (raw.toLowerCase().includes(PRODUCTION_ENDPOINT)) return "refuse";
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "refuse";
  }
  if (!host) return "refuse";
  if (host.endsWith(".neon.tech")) return host.includes(TEST_ENDPOINT) ? "run" : "refuse";
  if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return "skip";
  // A single-label host (no dots) is a container-network service name, e.g. the CI Postgres service.
  if (!host.includes(".") && !host.includes(":")) return "skip";
  return "refuse";
}

/** Why a suite is skipped, for the describe title; empty when it is not skipped. */
export function skipReason(kind: DbTargetKind): string {
  if (kind === "none") return "no DATABASE_URL";
  if (kind === "skip") return "needs the Neon TEST branch; skipped on local/CI database";
  return "";
}

/** Call from beforeAll: throws unless the target is the TEST branch. A skip-class target never reaches here. */
export function assertTestBranch(url: string | undefined | null): void {
  const kind = classifyDbTarget(url);
  if (kind !== "run") throw new Error(`REFUSED: DATABASE_URL is not the Neon TEST branch (${TEST_ENDPOINT}); target class "${kind}".`);
}
