// Shared database-target guard for every readiness script (security campaign, review of lane F, 9 Oct 2026).
//
// A guard that looks only at `new URL(url).hostname` can be bypassed while pg still connects to production:
// an UPPER-CASE host (not lower-cased for the postgres: scheme), a `?host=` query parameter (pg-connection-string
// uses it as the real host), a `?hostaddr=`, or `?options=endpoint=<id>` naming a different Neon endpoint on the
// TEST hostname. This module resolves the target the way pg does, refuses the override parameters outright, and
// compares case-insensitively. Every script that opens a database connection must go through it.
import { parse } from "pg-connection-string";

export const PRODUCTION_ENDPOINT_ID = "ep-bold-wave-abt39t7x";
export const TEST_ENDPOINT_ID = "ep-hidden-salad-abom7cg4";

export class TargetRefused extends Error {}

// Positive allowlist (lane E3, review R2: expectHost was a caller-supplied substring, so `ep-hidden-salad-<anything>`
// or the TEST id on a foreign domain passed). The two short names every script and runbook uses map to their EXACT
// endpoint ids; any other expectHost must itself be a whole Neon endpoint id (a restore branch). The effective host
// must then be exactly that endpoint, pooled or direct, in the project's region.
const KNOWN_ENDPOINTS = { "ep-hidden-salad": TEST_ENDPOINT_ID, "ep-bold-wave": PRODUCTION_ENDPOINT_ID };
const WHOLE_ENDPOINT_ID = /^ep-[a-z]+-[a-z]+-[a-z0-9]{8}$/;
const NEON_HOST_SUFFIX = ".eu-west-2.aws.neon.tech";

/** The exact hosts admitted for an expectHost, or null when it names no endpoint. @param {string} expectHost */
export function allowedHostsFor(expectHost) {
  const e = String(expectHost).toLowerCase();
  const id = KNOWN_ENDPOINTS[e] ?? (WHOLE_ENDPOINT_ID.test(e) ? e : null);
  return id ? [`${id}${NEON_HOST_SUFFIX}`, `${id}-pooler${NEON_HOST_SUFFIX}`] : null;
}

/**
 * @param {string} url
 * @param {{ expectHost?: string, allowProduction?: boolean }} [opts]
 * @returns {string}
 * Resolve and vet a connection string.
 * - `expectHost` (required): `ep-hidden-salad`, `ep-bold-wave` or a whole Neon endpoint id; the EFFECTIVE host must
 *   contain it AND be exactly that endpoint (pooled or direct) — positive allowlist, see allowedHostsFor (lane E3).
 * - `allowProduction`: only a script that is explicitly authorised for a read-only production baseline passes true.
 * Returns the normalised effective host. Throws TargetRefused on any override parameter, a mismatch, or an
 * unauthorised production target.
 */
export function resolveDbTarget(url, { expectHost, allowProduction = false } = {}) {
  if (typeof url !== "string" || url.length === 0) throw new TargetRefused("no connection string");
  // pg applies PGOPTIONS (and PGHOST/PGHOSTADDR when the URL lacks them) from the environment, so an
  // `endpoint=<id>` in PGOPTIONS can route a TEST hostname to another Neon endpoint without touching the URL
  // (lane F2 review of b871619, 9 Oct 2026). Refuse rather than resolve.
  for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR"]) {
    if (process.env[k]) throw new TargetRefused(`REFUSED: ${k} is set in the environment`);
  }
  let u;
  try { u = new URL(url); } catch { throw new TargetRefused("connection string is not a URL"); }
  // Override parameters that make the effective target differ from the URL host are refused, never resolved.
  for (const key of ["host", "hostaddr", "options", "endpoint"]) {
    if (u.searchParams.has(key)) throw new TargetRefused(`REFUSED: connection string carries a ${key}= parameter`);
  }
  let parsed;
  try { parsed = parse(url); } catch { throw new TargetRefused("connection string could not be parsed"); }
  // Neon also routes on the PASSWORD field: `endpoint=<id>$<password>` (or `;`) selects the endpoint for clients
  // without SNI, so a TEST hostname could carry another endpoint's id there (review R8, SF-129; lane M2, 10 Oct 2026).
  // Refused, never resolved — whatever the letter case or percent-encoding.
  if (/^\s*endpoint=/i.test(String(parsed.password ?? ""))) {
    throw new TargetRefused("REFUSED: the password field carries an endpoint= routing option");
  }
  const effective = String(parsed.host ?? "").trim().toLowerCase();
  const urlHost = u.hostname.toLowerCase();
  if (!effective || effective !== urlHost) throw new TargetRefused("REFUSED: the effective host differs from the URL host");
  if (typeof expectHost !== "string" || expectHost.length === 0) throw new TargetRefused("REFUSED: no expectHost given");
  if (!effective.includes(expectHost.toLowerCase())) {
    throw new TargetRefused(`REFUSED: host does not contain ${expectHost}`);
  }
  if (effective.includes(PRODUCTION_ENDPOINT_ID) && !allowProduction) {
    throw new TargetRefused("REFUSED: production endpoint; this script is not authorised for a production target");
  }
  const allowed = allowedHostsFor(expectHost);
  if (!allowed) {
    throw new TargetRefused(`REFUSED: expectHost must be ep-hidden-salad, ep-bold-wave or a whole Neon endpoint id (ep-<word>-<word>-<8>)`);
  }
  if (!allowed.includes(effective)) throw new TargetRefused("REFUSED: host is not the allowlisted endpoint for expectHost");
  return effective;
}
