// Logical export of a NON-PRODUCTION database for an isolated restore drill (security campaign, iteration 2,
// lane F2, SF-19 / SEC-085 / SEC-086). Read-only. pg_dump is not installed on this machine and the weekly pg_dump
// workflow has never succeeded, so this script is the permitted export path for the TEST branch.
//
//   node scripts/readiness/backup-export.mjs <env-file> <expected-host-substring> <VAR> <out-dir>
//
// - Production is refused unconditionally (no override flag exists here); so are host=/hostaddr=/options=/endpoint=
//   URL parameters (db-target.mjs) and PGOPTIONS/PGHOST/PGHOSTADDR in the environment.
// - <out-dir> must be OUTSIDE the repository: the export holds row data (on the TEST branch that may include the
//   rehearsal import) and must never be committed. It is refused if it exists and is not empty.
// - ONE connection, ONE `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction: the baseline fingerprint
//   (restore-verify takeFingerprint, with content hashes) and every exported row come from the same snapshot, so a
//   restore can be compared against the exact instant it claims to represent (now() of that transaction = the
//   recovery point). Every table's exported row count is checked against the fingerprint inside the transaction.
// Output: <out-dir>/data/<Table>.ndjson (row_to_json per row), <out-dir>/baseline-fingerprint.json and
// <out-dir>/manifest.json (recovery point, per-table rows / bytes / sha256, column types, grants, sequence values,
// roles and their flags — the "globals" a pg_dump --no-owner --no-privileges archive leaves out). Prints a one-line
// JSON summary (counts, timings, hashes — no row data).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";
import { takeFingerprint, readEnvFile, refuseConnectionEnv } from "./restore-verify.mjs";

const JSON_NULL_SENTINEL = "__matflow_backup_json_null__";
const jsonNulls = {};
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const [envFile, expectHost, varName, outDirArg] = process.argv.slice(2);
if (!envFile || !expectHost || !varName || !outDirArg) die("usage: backup-export.mjs <env-file> <expected-host-substring> <VAR> <out-dir>");
const outDir = path.resolve(outDirArg);
if ((outDir + path.sep).toLowerCase().startsWith((REPO + path.sep).toLowerCase())) die("REFUSED: <out-dir> is inside the repository");
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) die("REFUSED: <out-dir> exists and is not empty");
const url = readEnvFile(envFile)[varName];
if (!url) die(`no ${varName} in ${envFile}`);
let host;
try {
  refuseConnectionEnv();
  host = resolveDbTarget(url, { expectHost, allowProduction: false });
} catch (e) {
  die(e instanceof TargetRefused ? e.message : `REFUSED: ${String(e)}`);
}

const killer = setTimeout(() => die("ABORTED: 600 s ceiling reached", 3), 600_000);
const t0 = Date.now();
fs.mkdirSync(path.join(outDir, "data"), { recursive: true });
const client = new pg.Client({ connectionString: url, application_name: "matflow-backup-export-readonly" });
await client.connect();
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const manifest = { tool: "scripts/readiness/backup-export.mjs", node: process.version, jsonNullSentinel: JSON_NULL_SENTINEL, hostPrefix: host.slice(0, 16), tables: {} };
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '120s'");
  const fp = await takeFingerprint(client, { contentHash: true });
  await client.query("SET LOCAL statement_timeout = '120s'");
  manifest.recoveryPoint = fp.takenAt instanceof Date ? fp.takenAt.toISOString() : fp.takenAt;
  manifest.role = fp.role;
  manifest.pgMajor = fp.pgMajor;
  manifest.roles = fp.roles;
  manifest.schemaPublic = fp.schemaPublic;
  // Grants on public tables/sequences and functions, as (object, grantee, privilege) triples; owners excluded.
  manifest.tableGrants = await q(`select c.relname obj, c.relkind::text kind, pg_get_userbyid(a.grantee) grantee, a.privilege_type priv
                                    from pg_class c join pg_namespace n on n.oid=c.relnamespace, aclexplode(c.relacl) a
                                   where n.nspname='public' and c.relacl is not null and a.grantee <> c.relowner and a.grantee <> 0
                                   order by 1,3,4`);
  manifest.functionGrants = await q(`select p.oid::regprocedure::text obj, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end grantee, a.privilege_type priv
                                       from pg_proc p join pg_namespace n on n.oid=p.pronamespace, aclexplode(p.proacl) a
                                      where n.nspname='public' and p.proacl is not null and a.grantee <> p.proowner order by 1,2,3`);
  manifest.sequences = await q(`select c.relname seq from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='S' order by 1`);
  for (const s of manifest.sequences) {
    const r = (await q(`select last_value::text v, is_called from public."${s.seq.replace(/"/g, "")}"`))[0];
    s.lastValue = r.v; s.isCalled = r.is_called;
  }
  for (const t of Object.keys(fp.tables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`unexpected table name ${t}`);
    const cols = await q(`select a.attname n, format_type(a.atttypid, a.atttypmod) ty from pg_attribute a
                           where a.attrelid = ('public."' || $1 || '"')::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t]);
    const file = path.join(outDir, "data", `${t}.ndjson`);
    const fd = fs.openSync(file, "w");
    const hash = crypto.createHash("sha256");
    let rows = 0, bytes = 0;
    // Keyset paging by ctid would not be stable across pages in every case; the TEST branch is small (~115k rows),
    // so each table is read in one query inside the snapshot.
    // JSON null versus SQL NULL: row_to_json writes both as `null` and json_populate_recordset reads `null` back as
    // SQL NULL, so a jsonb column holding the JSON value null (Prisma.JsonNull — 6 User.totpRecoveryCodes rows on
    // TEST, 9 Oct 2026) would silently become SQL NULL (Prisma.DbNull) in the restore. The first drill's content
    // hash caught exactly that. A JSON null is exported as the sentinel string below and turned back by the restore;
    // a source value that already equals the sentinel is refused.
    const jsonCols = cols.filter((c) => c.ty === "jsonb" || c.ty === "json").map((c) => c.n);
    for (const c of jsonCols) {
      const clash = (await q(`select count(*)::int n from public."${t}" where "${c}"::jsonb = to_jsonb($1::text)`, [JSON_NULL_SENTINEL]))[0].n;
      if (clash > 0) throw new Error(`sentinel collision in ${t}.${c}`);
    }
    const sel = cols.map((c) => (jsonCols.includes(c.n)
      ? `case when jsonb_typeof("${c.n}"::jsonb) = 'null' then to_jsonb('${JSON_NULL_SENTINEL}'::text) else "${c.n}"::jsonb end as "${c.n}"`
      : `"${c.n}"`)).join(", ");
    const res = await client.query(`select row_to_json(x)::text j from (select ${sel} from public."${t}") x`);
    jsonNulls[t] = {};
    for (const c of jsonCols) jsonNulls[t][c] = (await q(`select count(*)::int n from public."${t}" where jsonb_typeof("${c}"::jsonb) = 'null'`))[0].n;
    for (const r of res.rows) {
      const line = r.j + "\n";
      fs.writeSync(fd, line); hash.update(line); rows += 1; bytes += Buffer.byteLength(line);
    }
    fs.closeSync(fd);
    if (rows !== fp.tables[t].rows) throw new Error(`row count mismatch on ${t}: exported ${rows}, fingerprint ${fp.tables[t].rows}`);
    manifest.tables[t] = { rows, bytes, sha256: hash.digest("hex"), columns: cols.map((c) => `${c.n}:${c.ty}`), jsonNulls: jsonNulls[t] };
  }
  await client.query("ROLLBACK");
  fs.writeFileSync(path.join(outDir, "baseline-fingerprint.json"), JSON.stringify(fp, null, 1));
  manifest.baselineFingerprintSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(outDir, "baseline-fingerprint.json"))).digest("hex");
} finally {
  clearTimeout(killer);
  await client.end();
}
manifest.exportMs = Date.now() - t0;
manifest.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
const totalRows = Object.values(manifest.tables).reduce((s, t) => s + t.rows, 0);
const totalBytes = Object.values(manifest.tables).reduce((s, t) => s + t.bytes, 0);
console.log(JSON.stringify({ verdict: "EXPORTED", recoveryPoint: manifest.recoveryPoint, role: manifest.role, tables: Object.keys(manifest.tables).length, totalRows, totalBytes, exportMs: manifest.exportMs, node: process.version }));
