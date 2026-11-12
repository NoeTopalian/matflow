// READ-ONLY production checks for club-managed class categories (Release A post-deploy; Release B safety gate and
// observation period). docs/readiness/CLASS-CATEGORIES-RELEASE-B-2026-11-12.md §3, Release A evidence §6 and §13.
//
//   node scripts/readiness/class-categories-prod-check.mjs <env-file> <expected-endpoint-id> <check> [since-ISO]
//
// Checks (each prints counts, booleans and timestamps only: never a name, email, id or connection string):
//   post-a          clubs; ClassCategory rows; clubs without exactly eight starting rows; the two consistency counts
//   gate-b          the stale-writer refusal is in the bridge function; migration 20261112120000 finished, not rolled
//                   back; the two consistency counts; club-made, renamed and archived category counts (expected 0
//                   before activation)
//   observe <since> O1 the latest categoryKeyWrittenAt, and whether it is later than <since>; O2 class audit rows
//                   marked categoryOldKey since <since>, and how many distinct people made them
// One transaction, READ ONLY, statement timeout 15 s. Exit 0 = read and printed; 1 = a query failed; 2 = refused
// before connecting (usage, host guard, forbidden environment).
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { parse } = require("pg-connection-string");

for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR", "PGSSLMODE", "PGPASSWORD", "PGSERVICE"]) {
  if (process.env[k]) { console.error("REFUSED: environment variable " + k + " is set"); process.exit(2); }
}
const [envFile, expectHost, check, since] = process.argv.slice(2);
const CHECKS = ["post-a", "gate-b", "observe"];
if (!envFile || !expectHost || !/^ep-[a-z0-9-]+$/.test(expectHost) || !CHECKS.includes(check)
  || (check === "observe" && !(since && !Number.isNaN(Date.parse(since))))) {
  console.error("usage: node scripts/readiness/class-categories-prod-check.mjs <env-file> <expected-endpoint-id> post-a|gate-b|observe [since-ISO]");
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

const KEYS = ["fundamentals", "gi", "nogi", "kids", "competition", "open_mat", "private", "other"];
const consistency = async (c) => ({
  classesWithKeyButNoReference: Number((await c.query(`SELECT count(*)::int AS n FROM "Class" WHERE "category" IS NOT NULL AND "categoryId" IS NULL`)).rows[0].n),
  referencesWhoseKeyDiffers: Number((await c.query(
    `SELECT count(*)::int AS n FROM "Class" k JOIN "ClassCategory" cc ON cc."id" = k."categoryId" AND cc."tenantId" = k."tenantId"
      WHERE k."category" IS DISTINCT FROM cc."legacyKey"`)).rows[0].n),
});

const client = new Client({ connectionString: url, application_name: "class-categories-prod-check" });
const out = { check, host: expectHost };
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  out.role = (await client.query("SELECT current_user AS u")).rows[0].u;
  if (check === "post-a") {
    out.clubs = Number((await client.query(`SELECT count(*)::int AS n FROM "Tenant"`)).rows[0].n);
    out.categoryRows = Number((await client.query(`SELECT count(*)::int AS n FROM "ClassCategory"`)).rows[0].n);
    out.clubsWithoutExactlyEightStartingRows = Number((await client.query(
      `SELECT count(*)::int AS n FROM "Tenant" t WHERE (SELECT count(*) FROM "ClassCategory" cc
         WHERE cc."tenantId" = t."id" AND cc."legacyKey" = ANY($1::text[])) <> 8`, [KEYS])).rows[0].n);
    Object.assign(out, await consistency(client));
  } else if (check === "gate-b") {
    const fn = (await client.query(`SELECT prosrc FROM pg_proc WHERE proname = 'matflow_class_category_bridge'`)).rows;
    out.bridgeFunctions = fn.length;
    out.staleWriterRefusalPresent = fn.length === 1 && fn[0].prosrc.includes("MF_CLASS_CATEGORY_STALE_WRITER");
    const mig = (await client.query(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations
        WHERE migration_name = '20261112120000_class_category_stale_writer'`)).rows;
    out.migrationRows = mig.length;
    out.migrationFinished = mig.length === 1 && mig[0].finished === true;
    out.migrationRolledBack = mig.some((r) => r.rolled_back === true);
    Object.assign(out, await consistency(client));
    const cat = (await client.query(
      `SELECT count(*) FILTER (WHERE "legacyKey" IS NULL)::int AS made, count(*) FILTER (WHERE "archivedAt" IS NOT NULL)::int AS archived,
              count(*) FILTER (WHERE "legacyKey" IS NOT NULL AND "version" > 0)::int AS changed_starting FROM "ClassCategory"`)).rows[0];
    out.clubMadeCategories = cat.made;
    out.archivedCategories = cat.archived;
    out.startingCategoriesChangedByManagement = cat.changed_starting;
  } else {
    const o1 = (await client.query(`SELECT max("categoryKeyWrittenAt") AS t FROM "Class"`)).rows[0].t;
    out.since = new Date(since).toISOString();
    out.o1LatestKeyStamp = o1 ? new Date(o1).toISOString() : null;
    out.o1StampAfterSince = !!o1 && new Date(o1) > new Date(since);
    const o2 = (await client.query(
      `SELECT count(*)::int AS n, count(DISTINCT coalesce("userId", "metadata"->>'actorId'))::int AS people FROM "AuditLog"
        WHERE "action" IN ('class.updated', 'class.created') AND ("metadata"->>'categoryOldKey') = 'true' AND "createdAt" > $1`, [since])).rows[0];
    out.o2OldPageSaves = o2.n;
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
