// T8b (17 Oct 2026): the target and mode guard for scripts/backfill-status-events.ts.
//
// Kept in its own module so a unit test can drive it without importing the
// script (which runs on import) and without any database connection.
//
// This back-fill NEVER runs against production from this build. The shared
// readiness guard (scripts/readiness/db-target.mjs) is called with
// allowProduction false, and the production short name or a --production flag
// are refused outright, before the URL is even parsed. A production apply is a
// separate, Noe-authorised change made after the child-branch rehearsal has
// been read (ticket T8b, Done when).
import { resolveDbTarget, TargetRefused, PRODUCTION_ENDPOINT_ID } from "./readiness/db-target.mjs";

export { TargetRefused };

/** @param {string[]} argv @param {string} name */
export function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/**
 * Resolve the database target for the back-fill, refusing production.
 * @param {string} url the DATABASE_URL
 * @param {string[]} argv the script arguments
 * @returns {string} the normalised effective host
 */
export function backfillTarget(url, argv) {
  if (argv.includes("--production")) {
    throw new TargetRefused("REFUSED: this back-fill does not run against production (no --production)");
  }
  const expectHost = argValue(argv, "--expect-host");
  if (!expectHost) throw new TargetRefused("REFUSED: --expect-host <endpoint> is required");
  const e = expectHost.toLowerCase();
  if (e === "ep-bold-wave" || e.includes(PRODUCTION_ENDPOINT_ID) || e.startsWith("ep-bold-wave")) {
    throw new TargetRefused("REFUSED: the production endpoint is never a back-fill target");
  }
  return resolveDbTarget(url, { expectHost, allowProduction: false });
}

/**
 * The run mode. Preview unless --apply or --rollback is given; never both.
 * @param {string[]} argv
 * @returns {"preview" | "apply" | "rollback"}
 */
export function backfillMode(argv) {
  const apply = argv.includes("--apply");
  const rollback = argv.includes("--rollback");
  if (apply && rollback) throw new TargetRefused("REFUSED: --apply and --rollback together");
  if (apply && argv.includes("--preview")) throw new TargetRefused("REFUSED: --apply and --preview together");
  if (rollback && argv.includes("--preview")) throw new TargetRefused("REFUSED: --rollback and --preview together");
  return apply ? "apply" : rollback ? "rollback" : "preview";
}
