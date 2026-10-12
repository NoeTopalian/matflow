// READ-ONLY: how long a club's pre-generated class window lasts (12 Oct 2026, hub release assurance).
//
//   node scripts/readiness/class-window-readonly.mjs <env-file> <expected-endpoint-id> <tenant-slug> [VAR=DATABASE_URL]
//
// Prints, without any personal data (class names are timetable labels, not people):
//   - the club's timezone and "today" in that timezone
//   - active classes with active schedules, and for each: the last generated ClassInstance date
//   - the EARLIEST of those last dates = the first day on which some scheduled class has no instance
//   - days remaining until then, counted in the club's calendar
//   - instances dated today or later, total
// Exit 0 = read and printed; 1 = a query failed; 2 = refused before connecting (usage, host guard, forbidden env).
// One transaction, READ ONLY, statement timeout 15 s. No writes, no session settings beyond that transaction.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR", "PGSSLMODE", "PGPASSWORD", "PGSERVICE"]) {
  if (process.env[k]) { console.error("REFUSED: environment variable " + k + " is set"); process.exit(2); }
}
const [envFile, expectHost, slug, varArg] = process.argv.slice(2);
const varName = varArg?.startsWith("VAR=") ? varArg.slice(4) : "DATABASE_URL";
if (!envFile || !expectHost || !/^ep-[a-z0-9-]+$/.test(expectHost) || !slug || !/^[a-z0-9-]{2,64}$/.test(slug)) {
  console.error("usage: node scripts/readiness/class-window-readonly.mjs <env-file> <expected-endpoint-id> <tenant-slug> [VAR=DATABASE_URL]");
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
if (!host.startsWith(expectHost + ".") && !host.startsWith(expectHost + "-pooler.")) { console.error("REFUSED: host does not match the expected endpoint id"); process.exit(2); }
if (/[?&](host|hostaddr|options|endpoint)=/i.test(url) || /^endpoint=/i.test(String(cfg.password || ""))) { console.error("REFUSED: routing parameters in the connection string"); process.exit(2); }

const client = new Client({
  host, port: Number(cfg.port || 5432), user: cfg.user, password: cfg.password, database: cfg.database,
  ssl: { rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 10000, application_name: "class-window-readonly",
});
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
  const t = await client.query(`select id, coalesce(timezone, 'Europe/London') as tz from "Tenant" where slug = $1`, [slug]);
  if (t.rows.length !== 1) { console.log(`tenant ${slug}: not found`); await client.query("ROLLBACK"); await client.end(); process.exit(1); }
  const { id: tenantId, tz } = t.rows[0];
  const today = (await client.query(`select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz])).rows[0].d;
  const rows = (await client.query(`
    select c.id, c.name,
           (select count(*) from "ClassSchedule" s where s."classId" = c.id and s."isActive") as schedules,
           (select to_char(max(i.date)::date, 'YYYY-MM-DD') from "ClassInstance" i where i."classId" = c.id) as last_instance,
           (select count(*) from "ClassInstance" i where i."classId" = c.id and i.date::date >= $2::date) as future_instances
    from "Class" c
    where c."tenantId" = $1 and c."isActive" and c."deletedAt" is null
    order by c.name`, [tenantId, today])).rows;
  const scheduled = rows.filter((r) => Number(r.schedules) > 0);
  const toIso = (d) => (d ? String(d).slice(0, 10) : null); // dates arrive as YYYY-MM-DD text: no timezone conversion
  const todayIso = toIso(today);
  console.log(`tenant=${slug} timezone=${tz} club_today=${todayIso} active_classes=${rows.length} with_active_schedules=${scheduled.length}`);
  for (const r of scheduled) console.log(`  class ${r.id} "${String(r.name).slice(0, 40)}" schedules=${r.schedules} last_instance=${toIso(r.last_instance) ?? "none"} future_instances=${r.future_instances}`);
  const lasts = scheduled.map((r) => toIso(r.last_instance));
  if (scheduled.length === 0) { console.log("RESULT: no active scheduled classes — nothing to lapse"); }
  else if (lasts.some((x) => x === null)) { console.log("RESULT: at least one scheduled class has NO generated instance — check-in for it already fails"); }
  else {
    const earliest = lasts.sort()[0];
    const days = Math.round((Date.parse(earliest) - Date.parse(todayIso)) / 86400000);
    console.log(`RESULT: earliest last instance = ${earliest}; days remaining in the club calendar = ${days}${days < 0 ? " (ALREADY LAPSED)" : ""}`);
  }
  const fut = scheduled.reduce((a, r) => a + Number(r.future_instances), 0);
  console.log(`instances dated club_today or later = ${fut}`);
  await client.query("ROLLBACK");
  await client.end();
  process.exit(0);
} catch (e) {
  console.error("query failed: " + String(e?.code || e?.message || e).slice(0, 120));
  try { await client.end(); } catch {}
  process.exit(1);
}
