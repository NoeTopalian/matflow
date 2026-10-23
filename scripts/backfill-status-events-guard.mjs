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
import { createHash } from "node:crypto";
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
 *
 * Review F6 (23 Oct 2026): a rollback follows the same preview-then-act rule
 * as an apply. `--rollback` alone only previews (the events it would delete,
 * per club, and a rollback digest); `--rollback --confirm-digest <digest>`
 * deletes, and only when the digest still matches.
 * @param {string[]} argv
 * @returns {"preview" | "apply" | "rollback_preview" | "rollback"}
 */
export function backfillMode(argv) {
  const apply = argv.includes("--apply");
  const rollback = argv.includes("--rollback");
  const confirm = argv.includes("--confirm-digest");
  if (apply && rollback) throw new TargetRefused("REFUSED: --apply and --rollback together");
  if (apply && argv.includes("--preview")) throw new TargetRefused("REFUSED: --apply and --preview together");
  if (rollback && argv.includes("--preview")) throw new TargetRefused("REFUSED: --rollback and --preview together");
  if (confirm && !rollback) throw new TargetRefused("REFUSED: --confirm-digest is the --rollback gate; the apply gate is --plan-digest");
  if (rollback && argv.includes("--plan-digest")) throw new TargetRefused("REFUSED: --plan-digest is the --apply gate; a rollback takes --confirm-digest");
  if (confirm && !argValue(argv, "--confirm-digest")) throw new TargetRefused("REFUSED: --confirm-digest needs the digest the rollback preview printed");
  if (apply) return "apply";
  if (rollback) return confirm ? "rollback" : "rollback_preview";
  return "preview";
}

// ── Digests (review F6) ──────────────────────────────────────────────────────

const KINDS = ["start", "rejoin", "cancelled", "completed_course"];

/** @param {Date | string} v @returns {string} */
function iso(v) {
  return new Date(v).toISOString();
}

/** @param {Record<string, Record<string, number>>} byMonth */
function monthsByKind(byMonth) {
  return Object.keys(byMonth)
    .sort()
    .map((month) => [month, ...KINDS.map((k) => byMonth[month]?.[k] ?? 0)]);
}

/** @param {unknown} value */
function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * The apply gate's digest: everything the preview prints for each club (the
 * event count, the events per month BY KIND, the exception counts and the
 * exceptions by ledger row id) plus every planned event as (member,
 * occurredAt, toStatus). A plan whose members, dates or exception rows moved
 * no longer matches, even when its month totals and counts did not.
 * Order-independent: rows and months are sorted before hashing.
 *
 * @param {Array<{
 *   tenantId: string;
 *   alreadyApplied: boolean;
 *   inputs: Array<{ memberId: string; occurredAt: Date | string; toStatus: string }>;
 *   byMonth: Record<string, Record<string, number>>;
 *   exceptions: Array<{ kind: string; ledgerRowIds: string[] }>;
 *   exceptionCounts: Record<string, number>;
 * }>} plans
 * @returns {string} 16 hex characters
 */
export function backfillPlanDigest(plans) {
  return digest(
    [...plans]
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
      .map((p) => ({
        tenantId: p.tenantId,
        alreadyApplied: p.alreadyApplied,
        events: p.inputs.length,
        byMonth: monthsByKind(p.byMonth),
        exceptionCounts: Object.keys(p.exceptionCounts).sort().map((k) => [k, p.exceptionCounts[k]]),
        exceptions: p.exceptions.map((e) => `${e.kind}:${[...e.ledgerRowIds].sort().join(",")}`).sort(),
        inputs: p.inputs.map((i) => `${i.memberId}|${iso(i.occurredAt)}|${i.toStatus}`).sort(),
      })),
  );
}

/**
 * The rollback gate's digest: per club, the exact back-filled event ids the
 * preview found and their months by kind (what the preview prints). Clubs
 * with nothing to remove are left out. Order-independent.
 *
 * @param {Array<{ tenantId: string; eventIds: string[]; byMonth: Record<string, Record<string, number>> }>} previews
 * @returns {string} 16 hex characters
 */
export function backfillRollbackDigest(previews) {
  return digest(
    previews
      .filter((p) => p.eventIds.length > 0)
      .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
      .map((p) => ({ tenantId: p.tenantId, events: p.eventIds.length, byMonth: monthsByKind(p.byMonth), eventIds: [...p.eventIds].sort() })),
  );
}
