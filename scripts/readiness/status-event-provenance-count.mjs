// READ-ONLY count for review finding F1 on PR #39 (23 Oct 2026): how many status events written by the TeamUp
// refresh/rollback carry no provenance (reason 'import' with a fromStatus), per club — aggregates only.
// Usage: node scripts/readiness/status-event-provenance-count.mjs <env-file> <expected-host-substring> [VAR=DATABASE_URL]
// One connection (URL parsed, TLS verification forced), one READ ONLY transaction, a statement timeout; prints no
// credentials and no row data. Only columns that exist before migration 20261017022302 are read.
import fs from "node:fs";
import pg from "pg";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const envFile = process.argv[2];
const expectHost = process.argv[3];
const varName = process.argv[4] ?? "DATABASE_URL";
if (!envFile || !expectHost) { console.error("usage: node status-event-provenance-count.mjs <env-file> <expected-host-substring> [VAR]"); process.exit(2); }
const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
  }),
);
const url = env[varName];
if (!url) { console.error(`no ${varName} in env file`); process.exit(2); }
let host;
// Production is admissible as a read-only baseline (the db-role-inspect.mjs pattern): counts only.
try { host = resolveDbTarget(url, { expectHost, allowProduction: true }); } catch (e) { console.error(e instanceof TargetRefused ? e.message : String(e)); process.exit(2); }
const parsed = parsePg(url);
const client = new pg.Client({
  host: parsed.host, port: parsed.port ? Number(parsed.port) : 5432, user: parsed.user, password: parsed.password, database: parsed.database,
  ssl: { rejectUnauthorized: true }, application_name: "matflow-readonly-provenance-count",
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '20s'");
  const exists = (await client.query(`select to_regclass('"MemberStatusEvent"') as t`)).rows[0].t;
  if (!exists) { console.log(JSON.stringify({ host: host.replace(/^[^.]*\./, "…."), table: "MemberStatusEvent", exists: false })); }
  else {
    const cols = (await client.query(`select column_name from information_schema.columns where table_name = 'MemberStatusEvent' order by 1`)).rows.map((r) => r.column_name);
    const rows = (await client.query(
      `select t.slug, count(*) filter (where e.reason = 'import')::int as "importEvents",
              count(*) filter (where e.reason = 'import' and e."fromStatus" is not null)::int as "importWithFromStatus",
              count(*)::int as "allEvents"
         from "MemberStatusEvent" e join "Tenant" t on t.id = e."tenantId" group by t.slug order by t.slug`)).rows;
    console.log(JSON.stringify({ host: host.replace(/^[^.]*\./, "…."), table: "MemberStatusEvent", exists: true, hasSourceAction: cols.includes("sourceAction"), perClub: rows, at: new Date().toISOString() }, null, 1));
  }
  await client.query("COMMIT");
} finally {
  await client.end().catch(() => {});
}
