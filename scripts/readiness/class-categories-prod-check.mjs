// READ-ONLY production checks for club-managed class categories: before and after Release A's deploy, Release B's
// technical safety gate, and its observation period. docs/readiness/CLASS-CATEGORIES-RELEASE-B-2026-11-12.md §3,
// Release A evidence §6 and §13. Production runs authorised by Noe, 12 Nov 2026 ("documented read-only production
// compatibility and post-migration checks, returning only the minimum necessary results").
//
//   node scripts/readiness/class-categories-prod-check.mjs <env-file> <expected-endpoint-id> <check> [since-ISO]
//
// Checks. Each prints counts, booleans, timestamps and the database role name only: never a person's name, email or
// record id, and never a connection string.
//   pre             before Release A: the runtime role matflow_app gets new tables' rights through default
//                   privileges granted FOR ROLE neondb_owner (so it can read and write ClassCategory once the migration
//                   makes it), and has them on an existing table made by an earlier migration ("Mat"). This assumes
//                   production migrations run as neondb_owner: the owner of "Mat" is printed so that can be seen.
//   post-a          after Release A: clubs; ClassCategory rows; clubs without exactly eight starting rows; the two
//                   consistency counts; matflow_app's rights on ClassCategory
//   gate-b          after Release B: the stale-writer refusal and the every-write stamp are in the bridge function;
//                   migration 20261112120000 finished, not rolled back; the two consistency counts; and, for
//                   information (0 before activation), club-made, archived, and starting categories changed by
//                   management (renamed, archived, restored or reordered)
//   observe <since> since = the start of the current observation period (Release B's deploy, or the latest
//                   restart). O1: the latest categoryKeyWrittenAt, and whether it is later than <since>. O2: class
//                   audit rows marked categoryOldKey since <since>, and how many distinct people made them
// Row-level security is forced on these tables, so the transaction sets app.bypass_rls (transaction-local, as the
// other readiness scripts do), and refuses to report when it can see no clubs: a count of 0 must never mean "could
// not see". One transaction, REPEATABLE READ READ ONLY, statement timeout 15 s, always rolled back.
// Exit 0 = read and printed; 1 = a query failed or nothing was visible; 2 = refused before connecting.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR", "PGSSLMODE", "PGPASSWORD", "PGSERVICE"]) {
  if (process.env[k]) { console.error("REFUSED: environment variable " + k + " is set"); process.exit(2); }
}
const [envFile, expectHost, check, since] = process.argv.slice(2);
const CHECKS = ["pre", "post-a", "gate-b", "observe"];
if (!envFile || !expectHost || !/^ep-[a-z0-9-]+$/.test(expectHost) || !CHECKS.includes(check)
  || (check === "observe" && !(since && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(since)))) {
  console.error("usage: node scripts/readiness/class-categories-prod-check.mjs <env-file> <expected-endpoint-id> pre|post-a|gate-b|observe [since, UTC ISO ending Z]");
  process.exit(2);
}
let text;
try { text = fs.readFileSync(envFile, "utf8"); } catch { console.error("REFUSED: cannot read env file"); process.exit(2); }
const m = text.match(/^DATABASE_URL=(.*)$/m);
if (!m) { console.error("REFUSED: DATABASE_URL not found in the env file"); process.exit(2); }
const url = m[1].trim().replace(/^"|"$/g, "");
let cfg;
try { cfg = parse(url); } catch { console.error("REFUSED: unparsable connection string"); process.exit(2); }
const host = String(cfg.host || "");
if (!host.startsWith(expectHost + ".") && !host.startsWith(expectHost + "-pooler.")) {
  console.error("REFUSED: host does not match the expected endpoint id"); process.exit(2);
}
// As release-stage0-readonly.mjs: no routing overrides, and a client built from explicit fields with TLS verified.
if (/[?&](host|hostaddr|options|endpoint)=/i.test(url) || /^endpoint=/i.test(String(cfg.password || ""))) {
  console.error("REFUSED: routing parameters in the connection string"); process.exit(2);
}

const KEYS = ["fundamentals", "gi", "nogi", "kids", "competition", "open_mat", "private", "other"];
// Prisma stores timestamp(3) in UTC without a zone; compare and print in SQL, never through the client's local time.
const UTC_ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const count = async (c, sql, params = []) => Number((await c.query(sql, params)).rows[0].n);
const consistency = async (c) => ({
  classesWithKeyButNoReference: await count(c, `SELECT count(*)::int AS n FROM "Class" WHERE "category" IS NOT NULL AND "categoryId" IS NULL`),
  referencesWhoseKeyDiffers: await count(c,
    `SELECT count(*)::int AS n FROM "Class" k JOIN "ClassCategory" cc ON cc."id" = k."categoryId" AND cc."tenantId" = k."tenantId"
      WHERE k."category" IS DISTINCT FROM cc."legacyKey"`),
});
const appRights = async (c, table) => {
  const r = (await c.query(
    `SELECT has_table_privilege('matflow_app', $1, 'SELECT') AS s, has_table_privilege('matflow_app', $1, 'INSERT') AS i,
            has_table_privilege('matflow_app', $1, 'UPDATE') AS u, has_table_privilege('matflow_app', $1, 'DELETE') AS d`, [table])).rows[0];
  return r.s && r.i && r.u && r.d;
};

const client = new Client({
  host, port: Number(cfg.port || 5432), user: cfg.user, password: cfg.password, database: cfg.database,
  ssl: { rejectUnauthorized: true, servername: host }, connectionTimeoutMillis: 10000, application_name: "class-categories-prod-check",
});
const out = { check, endpoint: expectHost };
// A dropped connection is reported as a failure, never an unhandled crash (round 2, B-R11).
client.on("error", (e) => { console.error("FAILED: connection error: " + String(e?.message ?? e).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>")); process.exit(1); });
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
  const who = (await client.query(`SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`)).rows[0];
  out.role = who.role;
  out.roleHasBypassRls = who.bypass === true;
  out.clubs = await count(client, `SELECT count(*)::int AS n FROM "Tenant"`);
  if (out.clubs === 0) throw new Error("no clubs visible: row-level security or the wrong database; nothing reported");
  // After Release A every club has category rows: none visible means the wrong database or no visibility (B-R13).
  if (check === "gate-b" || check === "observe") {
    if ((await count(client, `SELECT count(*)::int AS n FROM "ClassCategory"`)) === 0) throw new Error("no categories visible; nothing reported");
  }
  if (check === "pre") {
    const acl = (await client.query(
      `SELECT count(*)::int AS n FROM pg_default_acl d JOIN pg_namespace ns ON ns.oid = d.defaclnamespace
        WHERE ns.nspname = 'public' AND d.defaclobjtype = 'r' AND pg_get_userbyid(d.defaclrole) = 'neondb_owner'
          AND array_to_string(d.defaclacl, ',') LIKE '%matflow_app=arwd%'`)).rows[0].n;
    out.defaultPrivilegesGiveMatflowAppNewTables = acl > 0;
    out.matflowAppHasRightsOnMat = await appRights(client, 'public."Mat"');
    out.ownerOfMat = (await client.query(`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Mat'`)).rows[0]?.tableowner ?? null;
  } else if (check === "post-a") {
    out.categoryRows = await count(client, `SELECT count(*)::int AS n FROM "ClassCategory"`);
    if (out.categoryRows < out.clubs * 8) out.warning = "fewer than eight category rows per club";
    out.clubsWithoutExactlyEightStartingRows = await count(client,
      `SELECT count(*)::int AS n FROM "Tenant" t WHERE (SELECT count(*) FROM "ClassCategory" cc
         WHERE cc."tenantId" = t."id" AND cc."legacyKey" = ANY($1::text[])) <> 8`, [KEYS]);
    Object.assign(out, await consistency(client));
    out.matflowAppHasRightsOnClassCategory = await appRights(client, 'public."ClassCategory"');
  } else if (check === "gate-b") {
    const fn = (await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'matflow_class_category_bridge'`)).rows;
    out.bridgeFunctions = fn.length;
    out.staleWriterRefusalPresent = fn.length === 1 && fn[0].prosrc.includes("MF_CLASS_CATEGORY_STALE_WRITER");
    const stampAt = fn.length === 1 ? fn[0].prosrc.indexOf('"categoryKeyWrittenAt" := CURRENT_TIMESTAMP') : -1;
    const unchangedAt = fn.length === 1 ? fn[0].prosrc.indexOf("IF NOT key_changed") : -1;
    out.everyOldKeyWriteStamped = stampAt >= 0 && unchangedAt >= 0 && stampAt < unchangedAt;
    const mig = (await client.query(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations
        WHERE migration_name = '20261112120000_class_category_stale_writer'`)).rows;
    out.migrationRows = mig.length;
    out.migrationFinished = mig.some((r) => r.finished === true && r.rolled_back === false);
    out.migrationRolledBack = mig.some((r) => r.rolled_back === true);
    Object.assign(out, await consistency(client));
    const cat = (await client.query(
      `SELECT count(*) FILTER (WHERE "legacyKey" IS NULL)::int AS made, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS archived,
              count(*) FILTER (WHERE "legacyKey" IS NOT NULL AND "version" > 0)::int AS changed_starting FROM "ClassCategory"`)).rows[0];
    out.info = { clubMadeCategories: cat.made, archivedCategories: cat.archived, startingCategoriesChangedByManagement: cat.changed_starting };
  } else {
    const o1 = (await client.query(
      `SELECT to_char(max("categoryKeyWrittenAt"), ${UTC_ISO}) AS t,
              coalesce(max("categoryKeyWrittenAt") > ($1::timestamptz AT TIME ZONE 'UTC'), false) AS after FROM "Class"`, [since])).rows[0];
    out.since = since;
    out.o1LatestKeyStamp = o1.t;
    out.o1StampAfterSince = o1.after === true;
    const o2 = (await client.query(
      `SELECT count(*)::int AS n, count(DISTINCT coalesce("userId", "metadata"->>'actorId'))::int AS people FROM "AuditLog"
        WHERE "action" IN ('class.updated', 'class.created') AND "createdAt" > ($1::timestamptz AT TIME ZONE 'UTC')
          AND ("metadata"->>'categoryOldKey') = 'true'`, [since])).rows[0];
    out.o2OldPageCategoryChanges = o2.n;
    out.o2DistinctPeople = o2.people;
  }
  await client.query("ROLLBACK");
  console.log(JSON.stringify(out, null, 2));
  await client.end();
} catch (e) {
  console.error("FAILED: " + String(e?.message ?? e).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>"));
  try { await client.end(); } catch { /* closing after a failure */ }
  process.exit(1);
}
