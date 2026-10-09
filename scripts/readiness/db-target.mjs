// Shared database-target guard for every readiness script (security campaign, review of lane F, 9 Oct 2026).
//
// A guard that looks only at `new URL(url).hostname` can be bypassed while pg still connects to production:
// an UPPER-CASE host (not lower-cased for the postgres: scheme), a `?host=` query parameter (pg-connection-string
// uses it as the real host), a `?hostaddr=`, or `?options=endpoint=<id>` naming a different Neon endpoint on the
// TEST hostname. This module resolves the target the way pg does, refuses the override parameters outright, and
// compares case-insensitively. Every script that opens a database connection must go through it.
import { parse } from "pg-connection-string";

export const PRODUCTION_ENDPOINT_ID = "ep-bold-wave-abt39t7x";

export class TargetRefused extends Error {}

/**
 * @param {string} url
 * @param {{ expectHost?: string, allowProduction?: boolean }} [opts]
 * @returns {string}
 * Resolve and vet a connection string.
 * - `expectHost`: substring (case-insensitive) that the EFFECTIVE host must contain.
 * - `allowProduction`: only a script that is explicitly authorised for a read-only production baseline passes true.
 * Returns the normalised effective host. Throws TargetRefused on any override parameter, a mismatch, or an
 * unauthorised production target.
 */
export function resolveDbTarget(url, { expectHost, allowProduction = false } = {}) {
  if (typeof url !== "string" || url.length === 0) throw new TargetRefused("no connection string");
  let u;
  try { u = new URL(url); } catch { throw new TargetRefused("connection string is not a URL"); }
  // Override parameters that make the effective target differ from the URL host are refused, never resolved.
  for (const key of ["host", "hostaddr", "options", "endpoint"]) {
    if (u.searchParams.has(key)) throw new TargetRefused(`REFUSED: connection string carries a ${key}= parameter`);
  }
  let parsed;
  try { parsed = parse(url); } catch { throw new TargetRefused("connection string could not be parsed"); }
  const effective = String(parsed.host ?? "").trim().toLowerCase();
  const urlHost = u.hostname.toLowerCase();
  if (!effective || effective !== urlHost) throw new TargetRefused("REFUSED: the effective host differs from the URL host");
  if (typeof expectHost === "string" && expectHost.length > 0 && !effective.includes(expectHost.toLowerCase())) {
    throw new TargetRefused(`REFUSED: host does not contain ${expectHost}`);
  }
  if (effective.includes(PRODUCTION_ENDPOINT_ID) && !allowProduction) {
    throw new TargetRefused("REFUSED: production endpoint; this script is not authorised for a production target");
  }
  return effective;
}
