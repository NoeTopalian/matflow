// TEST-branch-only connection resolver for the SF-62 boundary harness (security campaign iteration 2, lane B).
//
// Positive allowlist, not string matching: the effective host is resolved the way pg resolves it (shared guard
// db-target.mjs refuses host=/hostaddr=/options=/endpoint= overrides and case tricks), then it must match ONE exact
// pattern — the ep-hidden-salad TEST endpoint, pooled or direct. Any PG* environment variable is refused outright,
// because node-postgres falls back to PGHOST / PGOPTIONS / PGUSER ... whenever a config field is empty, so an
// inherited PGOPTIONS=endpoint=<other> would silently retarget the connection. The returned configs are explicit
// objects (host, port, user, password, database, ssl with servername), never a connection string, so no URL
// parameter reaches the driver. Nothing here prints a credential; describe() returns host + user only.
import fs from "node:fs";
import path from "node:path";
import { parse } from "pg-connection-string";
import { resolveDbTarget, TargetRefused, PRODUCTION_ENDPOINT_ID } from "./db-target.mjs";

export { TargetRefused };

// The only admissible target. Region-qualified Neon host, optionally the -pooler alias of the same endpoint.
export const TEST_HOST_RE = /^ep-hidden-salad-[a-z0-9]+(-pooler)?\.eu-west-2\.aws\.neon\.tech$/;
export const RUNTIME_ROLE = "matflow_app";

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

function refuseInheritedPgEnv() {
  const set = Object.keys(process.env).filter((k) => /^PG[A-Z_]*$/.test(k) && process.env[k] !== undefined && process.env[k] !== "");
  if (set.length > 0) throw new TargetRefused(`REFUSED: PG* environment variables are set (${set.join(", ")}); they can retarget node-postgres`);
}

/**
 * Vet one URL and turn it into an explicit pg config. `direct` swaps the -pooler alias for the direct host.
 * @param {string} url
 * @param {{ direct?: boolean, expectUser?: string }} [opts]
 */
export function vetTestUrl(url, opts = {}) {
  const { direct = false, expectUser } = opts;
  refuseInheritedPgEnv();
  const effective = resolveDbTarget(url, { expectHost: "ep-hidden-salad" });
  if (effective.includes(PRODUCTION_ENDPOINT_ID)) throw new TargetRefused("REFUSED: production endpoint");
  if (!TEST_HOST_RE.test(effective)) throw new TargetRefused("REFUSED: host is not the allowlisted TEST endpoint");
  const p = parse(url);
  if (!p.user || !p.password || !p.database) throw new TargetRefused("REFUSED: incomplete connection string");
  if (expectUser && p.user !== expectUser) throw new TargetRefused(`REFUSED: expected login role ${expectUser}`);
  const host = direct ? effective.replace("-pooler.", ".") : effective;
  if (!TEST_HOST_RE.test(host)) throw new TargetRefused("REFUSED: derived host is not allowlisted");
  return {
    host,
    port: p.port ? Number(p.port) : 5432,
    user: p.user,
    password: p.password,
    database: p.database,
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: "matflow-secB2-rls",
    connectionTimeoutMillis: 20_000,
  };
}

/** The owner (TEST_DATABASE_URL) and runtime (RESTRICTED_DATABASE_URL) identities on the TEST branch. */
export function loadTestTargets(repoRoot = process.cwd()) {
  const env = readEnvFile(path.join(repoRoot, ".env.test"));
  const ownerUrl = env.TEST_DATABASE_URL;
  const appUrl = env.RESTRICTED_DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new TargetRefused("REFUSED: .env.test lacks TEST_DATABASE_URL or RESTRICTED_DATABASE_URL");
  const ownerUser = parse(ownerUrl).user;
  if (ownerUser === RUNTIME_ROLE) throw new TargetRefused("REFUSED: TEST_DATABASE_URL logs in as the runtime role");
  return {
    ownerPooled: vetTestUrl(ownerUrl),
    ownerDirect: vetTestUrl(ownerUrl, { direct: true }),
    appPooled: vetTestUrl(appUrl, { expectUser: RUNTIME_ROLE }),
    appDirect: vetTestUrl(appUrl, { direct: true, expectUser: RUNTIME_ROLE }),
  };
}

export const describeTarget = (cfg) => ({ host: cfg.host, user: cfg.user, pooler: cfg.host.includes("-pooler") });

/**
 * For tests that must hold session state privately (a session-level SET through the shared -pooler alias would leak
 * to other clients of the PgBouncer): the same vetted URL with the DIRECT endpoint host. Returns a connection string
 * for Prisma; the caller must never print it.
 */
/** @param {string} url @param {{ expectUser?: string }} [opts] */
export function directTestUrl(url, opts = {}) {
  const cfg = vetTestUrl(url, { direct: true, expectUser: opts.expectUser });
  const u = new URL(url);
  u.hostname = cfg.host;
  return u.toString();
}
