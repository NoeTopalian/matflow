// OPERATOR-RUN, READ-ONLY count of the Vercel Blob stores referenced by stored URLs (security campaign iteration 2,
// lane E2, 9 Oct 2026; answers SF-48 and part of SF-28).
//
// After the blob-store pin (lib/blob-url.ts, SF-28 fix) only URLs on the store named by BLOB_READ_WRITE_TOKEN are
// proxied or deleted. If production rows reference any OTHER store host, those rows break (images 404) and are
// skipped on erasure. This script reports, for every text/json/array column in schema `public`, how many URL
// occurrences point at each Blob store. It prints store hosts only as a 12-hex fingerprint plus the store kind
// (private / public / bare), never row data, ids, tenant names or credentials.
//
// Usage (Noe, against production, from a temporary env file OUTSIDE the repo that holds a read-capable URL):
//   node scripts/readiness/ops-blob-host-count.mjs <env-file> <expected-host-substring> [VAR=DATABASE_URL]
// The agent runs it only against the TEST branch (expected host ep-hidden-salad).
//
// Safety: shared target guard (scripts/readiness/db-target.mjs, production admitted because this is a read-only
// baseline); the pg client is built from an explicit config (buildClientConfig: TLS verification forced, TLS/target
// URL parameters and PG* environment variables refused — review R2 / lane E3); one READ ONLY transaction with a statement timeout,
// rolled back; SELECT only. RLS caveat: when the connecting role is subject to row security (not superuser, no
// BYPASSRLS, not exempt as owner under FORCE), rows hidden by policies are NOT counted — the script says so.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

export const BLOB_URL_RE_SQL = "https://([a-z0-9.-]*blob\\.vercel-storage\\.com)";
const BLOB_URL_RE_JS = /https:\/\/([a-z0-9.-]*blob\.vercel-storage\.com)/gi;

export function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Store id as Vercel writes it into the hostname: the first label, lower-cased; "(bare)" for blob.vercel-storage.com. */
export function classifyBlobHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (h === "blob.vercel-storage.com") return { storeFp: "(bare)", kind: "bare" };
  const labels = h.split(".");
  const kind = labels.includes("private") ? "private" : labels.includes("public") ? "public" : "other";
  return { storeFp: fingerprint(labels[0]), kind };
}

/** Fingerprint of a store as the Vercel API names it (`store_<Id>`), matching classifyBlobHost's form. */
export function storeIdFingerprint(storeId) {
  return fingerprint(String(storeId).replace(/^store_/, "").toLowerCase());
}

/** Pure JS twin of the SQL extraction, used by the unit test to pin the pattern. */
export function extractBlobHosts(text) {
  return [...String(text).matchAll(BLOB_URL_RE_JS)].map((m) => m[1].toLowerCase());
}

/** Query keys that steer TLS or the target. Compared after percent-decoding (repeatedly) and lower-casing. */
const TLS_KEYS = ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "sslpassword", "sslcrl", "sslcrldir", "sslsni", "sslnegotiation", "sslcompression", "requiressl", "uselibpqcompat", "gssencmode"];
const TARGET_KEYS = ["host", "hostaddr", "options", "endpoint"];

function normaliseKey(k) {
  let s = String(k);
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch { break; } }
  return s.trim().toLowerCase();
}

/**
 * The URL must not be able to weaken TLS or move the target (review R2, 9 Oct 2026). pg-connection-string applies the
 * LAST of duplicate keys and URL parameters override a `ssl` option passed next to `connectionString`, so a guard
 * that reads the first `sslmode` is defeated by `?sslmode=require&sslmode=no-verify` or `&ssl%6dode=disable`. The
 * client is therefore built from an explicit config (buildClientConfig) and this check refuses, in any case and any
 * encoding: every TLS or target key, except ONE `sslmode` whose value is `require` or `verify-full` — the standard Neon
 * URL form, inert under the explicit config — and `channel_binding`.
 */
export function assertTlsNotDowngraded(url) {
  let u;
  try { u = new URL(url); } catch { throw new TargetRefused("REFUSED: connection string is not a URL"); }
  let sslmodes = 0;
  // Raw pairs, not searchParams: the literal key text is needed to tell `sslmode` from `ssl%6dode`.
  for (const pair of u.search.replace(/^\?/, "").split("&").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    const k = normaliseKey(rawKey.replace(/\+/g, " "));
    if (TARGET_KEYS.includes(k)) throw new TargetRefused(`REFUSED: connection string carries a ${k}= parameter`);
    if (!TLS_KEYS.includes(k) && !k.startsWith("ssl")) continue;
    if (rawKey === "sslmode" && ["require", "verify-full"].includes(rawValue) && ++sslmodes === 1) continue;
    throw new TargetRefused(`REFUSED: connection string carries ${k}= (TLS parameters are not taken from the URL)`);
  }
}

/**
 * Explicit pg config for the vetted URL: host, port, user, password, database and ssl { rejectUnauthorized: true } —
 * never a connection string, so no URL parameter reaches the driver. node-postgres fills empty fields (and `options`)
 * from PG* environment variables, so any PG* variable is refused, and a URL without user/password/database is refused.
 * @param {string} url
 * @param {{ expectHost: string, env?: Record<string, string | undefined> }} opts
 */
export function buildClientConfig(url, { expectHost, env = process.env }) {
  const pgEnv = Object.keys(env).filter((k) => /^PG[A-Z_]*$/i.test(k) && env[k] !== undefined && env[k] !== "");
  if (pgEnv.length) throw new TargetRefused(`REFUSED: PG* environment variables are set (${pgEnv.join(", ")}); node-postgres would apply them`);
  assertTlsNotDowngraded(url);
  const host = resolveDbTarget(url, { expectHost, allowProduction: true });
  const p = parsePg(url);
  if (!p.user || !p.password || !p.database) throw new TargetRefused("REFUSED: the connection string lacks a user, password or database");
  return {
    host,
    port: p.port ? Number(p.port) : 5432,
    user: p.user,
    password: p.password,
    database: p.database,
    ssl: { rejectUnauthorized: true, servername: host },
    application_name: "matflow-ops-blob-host-count",
  };
}

/** Double-quote a Postgres identifier taken from the catalogue. */
export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function columnQuery(table, column) {
  return (
    `select lower(m[1]) as host, count(*)::int as n from public.${quoteIdent(table)} t, ` +
    `lateral regexp_matches(cast(t.${quoteIdent(column)} as text), '${BLOB_URL_RE_SQL}', 'gi') m group by 1`
  );
}

function readEnv(file, name) {
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (m && m[1] === name) return m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

async function main(argv) {
  const [envFile, expectHost, varName = "DATABASE_URL"] = argv;
  if (!envFile || !expectHost) { console.error("usage: node scripts/readiness/ops-blob-host-count.mjs <env-file> <expected-host-substring> [VAR]"); return 2; }
  const url = readEnv(envFile, varName);
  if (!url) { console.error(`no ${varName} in env file`); return 2; }
  let config;
  try {
    // buildClientConfig runs assertTlsNotDowngraded(url) and the shared guard (allowProduction: true — read-only baseline).
    config = buildClientConfig(url, { expectHost });
  } catch (e) {
    console.error(e instanceof TargetRefused ? e.message : "REFUSED: connection string rejected");
    return 2;
  }
  const host = config.host;
  console.log(JSON.stringify({ target: host.split(".")[0], pooler: host.includes("-pooler") }));
  const client = new pg.Client(config);
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const who = await client.query(
      "select current_user as role, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user",
    );
    const cols = await client.query(
      `select c.table_name, c.column_name, cl.relrowsecurity as rls, cl.relforcerowsecurity as force_rls,
              pg_get_userbyid(cl.relowner) = current_user as is_owner
         from information_schema.columns c
         join pg_class cl on cl.relname = c.table_name
         join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
        where c.table_schema = 'public' and cl.relkind = 'r'
          and (c.data_type in ('text','character varying','json','jsonb') or (c.data_type = 'ARRAY' and c.udt_name in ('_text','_varchar')))
        order by 1, 2`,
    );
    const { rolsuper, rolbypassrls } = who.rows[0] ?? {};
    const rows = [];
    const hiddenRisk = new Set();
    for (const c of cols.rows) {
      const r = await client.query(columnQuery(c.table_name, c.column_name));
      if (c.rls && !rolsuper && !rolbypassrls && !(c.is_owner && !c.force_rls)) hiddenRisk.add(c.table_name);
      for (const x of r.rows) rows.push({ column: `${c.table_name}.${c.column_name}`, ...classifyBlobHost(x.host), occurrences: x.n });
    }
    await client.query("ROLLBACK");
    const byStore = {};
    for (const r of rows) byStore[`${r.kind}:${r.storeFp}`] = (byStore[`${r.kind}:${r.storeFp}`] ?? 0) + r.occurrences;
    console.log(JSON.stringify({ role: { superuser: !!rolsuper, bypassrls: !!rolbypassrls }, columnsScanned: cols.rows.length, byStore, rows }, null, 1));
    if (hiddenRisk.size) {
      console.log(`WARNING: row security applies to this role on ${hiddenRisk.size} table(s) (${[...hiddenRisk].join(", ")}); rows hidden by policy were NOT counted. Re-run as the table owner / a BYPASSRLS read-only role for a complete count.`);
    }
    console.log(Object.keys(byStore).length <= 1 ? "RESULT: at most one Blob store is referenced" : `RESULT: ${Object.keys(byStore).length} distinct Blob stores are referenced`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => {
    // pg errors carry no connection string; print the message and code only.
    console.error(`FAILED: ${e?.code ?? ""} ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
