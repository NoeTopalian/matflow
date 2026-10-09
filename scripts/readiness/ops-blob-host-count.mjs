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
// baseline); TLS verification cannot be downgraded by the URL; one READ ONLY transaction with a statement timeout,
// rolled back; SELECT only. RLS caveat: when the connecting role is subject to row security (not superuser, no
// BYPASSRLS, not exempt as owner under FORCE), rows hidden by policies are NOT counted — the script says so.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
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

/** The URL must not be able to switch TLS verification off: pg lets connection-string parameters override `ssl`. */
export function assertTlsNotDowngraded(url) {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode !== null && !["require", "verify-full"].includes(mode)) throw new TargetRefused(`REFUSED: sslmode=${mode}`);
  for (const k of ["uselibpqcompat", "sslrootcert", "sslcert", "sslkey", "ssl"]) {
    if (u.searchParams.has(k)) throw new TargetRefused(`REFUSED: connection string carries ${k}=`);
  }
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
  let host;
  try {
    host = resolveDbTarget(url, { expectHost, allowProduction: true });
    assertTlsNotDowngraded(url);
  } catch (e) {
    console.error(e instanceof TargetRefused ? e.message : "REFUSED: connection string rejected");
    return 2;
  }
  console.log(JSON.stringify({ target: host.split(".")[0], pooler: host.includes("-pooler") }));
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true }, application_name: "matflow-ops-blob-host-count" });
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
