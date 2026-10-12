// READ-ONLY Stage 0 facts for a release (12 Oct 2026, hub release decision §5).
//
//   node scripts/readiness/release-stage0-readonly.mjs <env-file> <expected-endpoint-id> [VAR=DATABASE_URL]
//
// Prints, without any secret or address value:
//   - the host it connected to and the role name
//   - migrations applied on that database versus the migration folders in THIS checkout
//     (missing on the database = would be applied by a deploy; extra on the database = ahead of this checkout)
//   - any migration rows marked failed / rolled back / in progress
//   - AuditLog row count (for the index-build decision)
//   - Operator rows: id, role, masked email, authenticator enrolled (yes/no)
// Exit 0 = read and printed; 1 = a query failed; 2 = refused before connecting (usage, host guard, forbidden env).
// Never runs a migration. One transaction, READ ONLY, statement timeout 15 s.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR", "PGSSLMODE", "PGPASSWORD", "PGSERVICE"]) {
  if (process.env[k]) { console.error("REFUSED: environment variable " + k + " is set"); process.exit(2); }
}
const [envFile, expectHost, varArg] = process.argv.slice(2);
const varName = varArg?.startsWith("VAR=") ? varArg.slice(4) : "DATABASE_URL";
if (!envFile || !expectHost || !/^ep-[a-z0-9-]+$/.test(expectHost)) {
  console.error("usage: node scripts/readiness/release-stage0-readonly.mjs <env-file> <expected-endpoint-id e.g. ep-bold-wave-abt39t7x> [VAR=DATABASE_URL]");
  process.exit(2);
}
let text;
try { text = fs.readFileSync(envFile, "utf8"); } catch { console.error("REFUSED: cannot read env file"); process.exit(2); }
const m = text.match(new RegExp("^" + varName + "=(.*)$", "m"));
if (!m) { console.error("REFUSED: " + varName + " not found in the env file"); process.exit(2); }
const url = m[1].trim().replace(/^"|"$/g, "");
let cfg;
try { cfg = parse(url); } catch { console.error("REFUSED: unparsable connection string"); process.exit(2); }
const host = String(cfg.host || "");
if (!host.startsWith(expectHost + ".") && !host.startsWith(expectHost + "-pooler.")) {
  console.error("REFUSED: host does not match the expected endpoint id"); process.exit(2);
}
if (/[?&](host|hostaddr|options|endpoint)=/i.test(url) || /^endpoint=/i.test(String(cfg.password || ""))) {
  console.error("REFUSED: routing parameters in the connection string"); process.exit(2);
}
const dir = path.resolve("prisma/migrations");
const local = fs.readdirSync(dir).filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(dir, d, "migration.sql"))).sort();

const client = new Client({
  host, port: Number(cfg.port || 5432), user: cfg.user, password: cfg.password, database: cfg.database,
  ssl: { rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 10000, application_name: "release-stage0-readonly",
});
const mask = (e) => { const s = String(e || ""); const at = s.indexOf("@"); return at < 0 ? "***" : s.slice(0, 2) + "***" + s.slice(at); };
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const who = await client.query("select current_user as role, current_database() as db");
  console.log(`host=${host.includes("-pooler") ? "pooled" : "direct"} endpoint=${expectHost} role=${who.rows[0].role} db=${who.rows[0].db}`);
  const mig = await client.query(`select migration_name, finished_at is not null as finished, rolled_back_at is not null as rolled_back, started_at from _prisma_migrations order by started_at`);
  const applied = new Set(mig.rows.filter((r) => r.finished && !r.rolled_back).map((r) => r.migration_name));
  const bad = mig.rows.filter((r) => !r.finished || r.rolled_back);
  const missing = local.filter((n) => !applied.has(n));
  const extra = [...applied].filter((n) => !local.includes(n)).sort();
  console.log(`migrations: applied_on_db=${applied.size} in_checkout=${local.length} missing_on_db=${missing.length} extra_on_db=${extra.length} failed_or_in_progress=${bad.length}`);
  for (const n of missing) console.log("  WOULD APPLY: " + n);
  for (const n of extra) console.log("  AHEAD OF CHECKOUT: " + n);
  for (const r of bad) console.log(`  PROBLEM ROW: ${r.migration_name} finished=${r.finished} rolled_back=${r.rolled_back}`);
  const al = await client.query(`select count(*)::bigint as n from "AuditLog"`);
  console.log(`AuditLog rows=${al.rows[0].n}`);
  const ops = await client.query(`select id, role, email, ("totpSecret" is not null) as authenticator from "Operator" order by id`).catch(async () => {
    return client.query(`select id, role, email, false as authenticator from "Operator" order by id`);
  });
  for (const r of ops.rows) console.log(`operator id=${r.id} role=${r.role} email=${mask(r.email)} authenticator=${r.authenticator ? "yes" : "no/unknown"}`);
  await client.query("ROLLBACK");
  await client.end();
  process.exit(0);
} catch (e) {
  console.error("query failed: " + String(e?.code || e?.message || e).slice(0, 120));
  try { await client.end(); } catch {}
  process.exit(1);
}
