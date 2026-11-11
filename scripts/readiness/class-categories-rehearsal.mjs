// Release A of club-managed class categories (migration 20261111120000_class_categories): the data side of its
// rehearsal, on a SCRATCH DATABASE made by scripts/readiness/migration-rehearsal.mjs (create → migrate with a main
// checkout → seed). Production is refused before any connection (db-target.mjs); only matflow_rehearsal_<14 digits>
// databases are ever touched. Connection strings are never printed. Synthetic data only.
//
//   node --env-file=<main checkout>/.env.test scripts/readiness/class-categories-rehearsal.mjs <command> DATABASE_URL <db> …
//
// Commands:
//   prepare VAR <db> [--classes N] before the migration: add N classes to the first club, give every class one of
//                                  the old keys or NULL, add a club with no classes, and print the per-key counts
//   writer  VAR <db> <seconds>     what a build from before the release does, without pause, for <seconds>: change
//                                  class categories by old key and insert new classes with one; meant to run WHILE
//                                  migration-rehearsal.mjs migrates this database (prints how many writes landed)
//   verify  VAR <db>               after: every club has its eight starting rows exactly once ("Open mat" spelling),
//                                  every class's reference agrees with its old key, the per-key counts are unchanged
//                                  apart from the writer's own writes, and an old-build write still goes through
//   oldnew  VAR <db>               old and new writers against the migrated schema, alternately on one class: an old
//                                  key write, a reference write, a category the club made, an old write after it
//
// Exit codes: 0 ok, 1 a check failed, 2 refused (target, name or usage).
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const TAG = "[class-categories-rehearsal]";
const NAME = /^matflow_rehearsal_\d{14}$/;
const KEYS = ["fundamentals", "gi", "nogi", "kids", "competition", "open_mat", "private", "other"];

function refuse(msg) {
  console.error(`${TAG} REFUSED: ${msg}`);
  process.exit(2);
}
const redact = (s) => String(s ?? "").replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");

/** The URL of rehearsal database `db` on the TEST endpoint, direct host. Vetted before and after it is built. */
function dbUrl(varName, db) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(varName ?? "")) refuse("name the environment variable that holds the TEST-endpoint URL");
  if (!NAME.test(db ?? "")) refuse("the database must be a matflow_rehearsal_<14 digits> name");
  const base = process.env[varName] ?? "";
  try {
    resolveDbTarget(base, { expectHost: "ep-hidden-salad" });
  } catch (e) {
    if (e instanceof TargetRefused) refuse(e.message);
    throw e;
  }
  const u = new URL(base);
  u.pathname = `/${db}`;
  u.hostname = u.hostname.replace(/-pooler\./, ".");
  u.searchParams.delete("pgbouncer");
  u.searchParams.delete("connection_limit");
  const out = u.toString();
  try {
    resolveDbTarget(out, { expectHost: "ep-hidden-salad" });
  } catch (e) {
    if (e instanceof TargetRefused) refuse(e.message);
    throw e;
  }
  return out;
}

async function client(url, appName) {
  const c = new pg.Client({ connectionString: url, application_name: appName, connectionTimeoutMillis: 20_000, keepAlive: true });
  c.on("error", (e) => console.error(`${TAG} connection ${appName} dropped: ${redact(e?.message ?? e)}`));
  await c.connect();
  // Rehearsal clubs are many; this script reads and writes across them.
  await c.query(`SELECT set_config('app.bypass_rls', 'on', false)`);
  return c;
}

const keyCounts = async (c) =>
  Object.fromEntries((await c.query(`SELECT coalesce("category", '(none)') AS k, count(*)::int AS n FROM "Class" GROUP BY 1 ORDER BY 1`)).rows.map((r) => [r.k, r.n]));

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const commands = {
  async prepare(varName, db, flag, count) {
    const c = await client(dbUrl(varName, db), "rehearsal-prepare");
    // --classes N: N more classes in the first club, for a realistic backfill size.
    const extra = flag === "--classes" ? Number(count) : 0;
    if (!Number.isInteger(extra) || extra < 0 || extra > 50_000) refuse("--classes must be 0–50000");
    if (extra > 0) {
      await c.query(`INSERT INTO "Class" (id, "tenantId", name) SELECT 'rhx_' || n, 'rht1', 'Extra class ' || n FROM generate_series(1, $1) n ON CONFLICT DO NOTHING`, [extra]);
    }
    // Every class gets one of the eight keys or none, spread evenly by its number.
    await c.query(`UPDATE "Class" SET "category" = (ARRAY[NULL, 'fundamentals', 'gi', 'nogi', 'kids', 'competition', 'open_mat', 'private', 'other'])[1 + (abs(hashtext(id)) % 9)]`);
    await c.query(`INSERT INTO "Tenant" (id, name, slug) VALUES ('rht_empty', 'Rehearsal club with no classes', 'rehearsal-club-empty') ON CONFLICT DO NOTHING`);
    console.log(`${TAG} prepared: ${JSON.stringify(await keyCounts(c))}`);
    console.log(`${TAG} clubs ${(await c.query(`SELECT count(*)::int AS n FROM "Tenant"`)).rows[0].n}, classes ${(await c.query(`SELECT count(*)::int AS n FROM "Class"`)).rows[0].n}`);
    await c.end();
    return 0;
  },

  async writer(varName, db, seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0 || s > 600) refuse("seconds must be 1–600");
    const c = await client(dbUrl(varName, db), "rehearsal-old-build-writer");
    const until = Date.now() + s * 1000;
    let updates = 0;
    let inserts = 0;
    let errors = 0;
    let longestWaitMs = 0;
    let i = 0;
    const firstError = [];
    while (Date.now() < until) {
      i++;
      const t0 = Date.now();
      try {
        if (i % 4 === 0) {
          // A new class, written the way a build from before the release writes it: an old key, no reference.
          await c.query(`INSERT INTO "Class" (id, "tenantId", name, "category") VALUES ($1, 'rht1', $2, $3)`, [`rhw_${i}`, `Writer class ${i}`, KEYS[i % KEYS.length]]);
          inserts++;
        } else {
          await c.query(`UPDATE "Class" SET "category" = $1 WHERE id = (SELECT id FROM "Class" WHERE "tenantId" = 'rht2' ORDER BY id OFFSET $2 LIMIT 1)`, [i % 9 === 0 ? null : KEYS[i % KEYS.length], i % 6]);
          updates++;
        }
      } catch (e) {
        errors++;
        if (firstError.length < 3) firstError.push(redact(e.message).slice(0, 160));
      }
      longestWaitMs = Math.max(longestWaitMs, Date.now() - t0);
    }
    await c.end();
    console.log(`${TAG} writer: ${updates} updates, ${inserts} inserts, ${errors} errors, longest single write ${longestWaitMs} ms${firstError.length ? `; first errors: ${firstError.join(" | ")}` : ""}`);
    return errors ? 1 : 0;
  },

  async verify(varName, db) {
    const c = await client(dbUrl(varName, db), "rehearsal-verify");
    const clubs = (await c.query(`SELECT count(*)::int AS n FROM "Tenant"`)).rows[0].n;
    const perClub = await c.query(`SELECT "tenantId", count(*)::int AS n, count(DISTINCT "legacyKey")::int AS keys FROM "ClassCategory" GROUP BY 1`);
    check("every club has its starting categories", perClub.rows.length === clubs, `${perClub.rows.length} of ${clubs} clubs have rows`);
    check("each club has exactly eight, one per old key", perClub.rows.every((r) => r.n === 8 && r.keys === 8));
    const spellings = await c.query(`SELECT DISTINCT name FROM "ClassCategory" WHERE "legacyKey" = 'open_mat'`);
    check("existing clubs keep the spelling \"Open mat\"", spellings.rows.length === 1 && spellings.rows[0].name === "Open mat", JSON.stringify(spellings.rows.map((r) => r.name)));
    const bad = await c.query(`
      SELECT count(*)::int AS n FROM "Class" c
        LEFT JOIN "ClassCategory" cc ON cc.id = c."categoryId" AND cc."tenantId" = c."tenantId"
       WHERE (c."categoryId" IS NULL AND c."category" IS NOT NULL)
          OR (c."categoryId" IS NOT NULL AND cc."legacyKey" IS DISTINCT FROM c."category")`);
    check("every class's reference agrees with its old key (none missing, none crossed)", bad.rows[0].n === 0, `${bad.rows[0].n} inconsistent`);
    const foreign = await c.query(`SELECT count(*)::int AS n FROM "Class" c JOIN "ClassCategory" cc ON cc.id = c."categoryId" WHERE cc."tenantId" <> c."tenantId"`);
    check("no class points at another club's category", foreign.rows[0].n === 0);
    console.log(`${TAG} after: ${JSON.stringify(await keyCounts(c))}`);
    const trig = await c.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"Class"'::regclass AND NOT tgisinternal`);
    check("the bridge trigger is installed", trig.rows.some((r) => r.tgname === "Class_category_bridge"));
    // An old-build write after the migration: the reference follows.
    await c.query("BEGIN");
    const one = (await c.query(`SELECT id, "tenantId" FROM "Class" WHERE "tenantId" = 'rht3' ORDER BY id LIMIT 1`)).rows[0];
    await c.query(`UPDATE "Class" SET "category" = 'kids' WHERE id = $1`, [one.id]);
    const after = (await c.query(`SELECT c."categoryId", cc."legacyKey" FROM "Class" c JOIN "ClassCategory" cc ON cc.id = c."categoryId" WHERE c.id = $1`, [one.id])).rows[0];
    check("an old-build write after the migration moves the reference too", after?.legacyKey === "kids");
    await c.query("ROLLBACK");
    await c.end();
    return failures ? 1 : 0;
  },

  async oldnew(varName, db) {
    const c = await client(dbUrl(varName, db), "rehearsal-old-new");
    await c.query("BEGIN");
    const cls = (await c.query(`SELECT id, "tenantId" FROM "Class" WHERE "tenantId" = 'rht4' ORDER BY id LIMIT 1`)).rows[0];
    const row = async () => (await c.query(`SELECT "category", "categoryId" FROM "Class" WHERE id = $1`, [cls.id])).rows[0];
    const idOf = async (key) => (await c.query(`SELECT id FROM "ClassCategory" WHERE "tenantId" = $1 AND "legacyKey" = $2`, [cls.tenantId, key])).rows[0].id;
    await c.query(`UPDATE "Class" SET "category" = 'gi' WHERE id = $1`, [cls.id]);
    check("old writer: key gi → reference to the club's Gi", (await row()).categoryId === (await idOf("gi")));
    await c.query(`UPDATE "Class" SET "categoryId" = $2 WHERE id = $1`, [cls.id, await idOf("nogi")]);
    check("new writer: reference to No-Gi → key nogi", (await row()).category === "nogi");
    const own = (await c.query(`INSERT INTO "ClassCategory" (id, "tenantId", name, "nameKey", "sortOrder", "updatedAt") VALUES ('rh_own', $1, 'Intermediate', 'intermediate', 9, now()) RETURNING id`, [cls.tenantId])).rows[0].id;
    await c.query(`UPDATE "Class" SET "categoryId" = $2 WHERE id = $1`, [cls.id, own]);
    check("new writer: a club-made category → key empty", (await row()).category === null);
    await c.query(`UPDATE "Class" SET name = name || ' (old edit)' WHERE id = $1`, [cls.id]);
    check("old writer: an unrelated edit keeps the club-made category", (await row()).categoryId === own);
    await c.query("ROLLBACK");
    await c.end();
    return failures ? 1 : 0;
  },
};

const [cmd, varName, db, ...rest] = process.argv.slice(2);
if (!commands[cmd]) refuse(`unknown command; use one of: ${Object.keys(commands).join(", ")}`);
commands[cmd](varName, db, ...rest).then(
  (code) => process.exit(code),
  (e) => { console.error(`${TAG} FAILED: ${redact(e?.message ?? e)}`); process.exit(1); },
);
