// Clean-baseline migration rehearsal on a SCRATCH DATABASE of the Neon TEST endpoint (brief S2.4, 24 Oct 2026).
//
// A child of the already-migrated test branch is not a clean baseline: it already holds every migration. This script
// creates an empty database (`matflow_rehearsal_<UTC stamp>`) on the TEST endpoint, migrates it with the Prisma CLI of
// a chosen checkout (for example a detached worktree of main), seeds synthetic data, applies a later checkout's
// migrations while watching locks, rehearses a partial failure, and drops the database it created. Production is
// refused before any connection (scripts/readiness/db-target.mjs); only `matflow_rehearsal_<digits>` databases are
// ever migrated, seeded or dropped. Connection strings are never printed.
//
// The base URL comes from an environment variable NAMED on the command line (never a value on the command line):
//   node --env-file=<main checkout>/.env.test scripts/readiness/migration-rehearsal.mjs <command> DATABASE_URL …
//
// Commands (VAR = the variable holding a TEST-endpoint URL):
//   create  VAR                                 create an empty rehearsal database; prints its name
//   list    VAR                                 rehearsal databases on the endpoint
//   migrate VAR <db> <checkout> [--pooled]      `prisma migrate deploy` from <checkout> (its own CLI and migrations),
//                                               timing each migration and watching locks (relation and advisory)
//   profile VAR <db> <checkout>                 the locks each PENDING migration file takes: all pending files run in ONE
//                                               transaction that is always rolled back (nothing is applied)
//   seed    VAR <db> [--clubs N] [--members N]  synthetic clubs, plans, members, classes, attendance, status events
//   partial VAR <db> <checkout> <table>         hold ACCESS SHARE on <table> in another session while migrate deploy
//                                               runs, so the first migration that needs ACCESS EXCLUSIVE on it fails
//   resolve VAR <db> <checkout> <migration>     `prisma migrate resolve --rolled-back <migration>`
//   state   VAR <db>                            _prisma_migrations and the release's columns/table/constraints
//   advisory VAR <db> <checkout> [--pooled]     the Prisma Migrate advisory lock, by experiment: hold the shared form
//                                               while migrate deploy waits; probe the try-form while migrate holds it
//   drop    VAR <db>                            DROP DATABASE … WITH (FORCE) — rehearsal names only
//
// Exit codes: 0 ok, 1 a step failed (reported), 2 refused (target, name or usage).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const TAG = "[rehearsal]";
const NAME = /^matflow_rehearsal_\d{14}$/;
/** Prisma Migrate's Postgres advisory lock key (schema engine: `SELECT pg_advisory_lock(72707369)`); see lib/migration-lock.ts. */
const PRISMA_MIGRATE_LOCK_KEY = 72707369;

function refuse(msg) {
  console.error(`${TAG} REFUSED: ${msg}`);
  process.exit(2);
}
const redact = (s) => String(s ?? "").replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");

/** The vetted base URL from the named variable (TEST endpoint only; production refused before any connection). */
function baseUrl(varName) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(varName ?? "")) refuse("name the environment variable that holds the TEST-endpoint URL");
  const url = process.env[varName];
  try {
    resolveDbTarget(url ?? "", { expectHost: "ep-hidden-salad" });
  } catch (e) {
    if (e instanceof TargetRefused) refuse(e.message);
    throw e;
  }
  return url;
}

/** The URL of database `db` on the same endpoint; direct (non-pooler) host unless pooled. Re-vetted. */
function dbUrl(base, db, { pooled = false } = {}) {
  if (db !== null && !NAME.test(db ?? "")) refuse("the database must be a matflow_rehearsal_<14 digits> name");
  const u = new URL(base);
  if (db !== null) u.pathname = `/${db}`;
  if (!pooled) {
    u.hostname = u.hostname.replace(/-pooler\./, ".");
    u.searchParams.delete("pgbouncer");
  } else if (!u.hostname.includes("-pooler.")) {
    u.hostname = u.hostname.replace(/^(ep-[a-z]+-[a-z]+-[a-z0-9]{8})\./, "$1-pooler.");
  }
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
  // A dropped socket is reported, never an unhandled 'error' event that kills the run mid-migration.
  c.on("error", (e) => console.error(`${TAG} connection ${appName} dropped: ${redact(e?.message ?? e)}`));
  await c.connect();
  return c;
}

function checkoutDir(dir) {
  const abs = path.resolve(dir ?? "");
  if (!fs.existsSync(path.join(abs, "prisma", "migrations"))) refuse(`${abs} has no prisma/migrations`);
  if (!fs.existsSync(path.join(abs, "node_modules", "prisma", "build", "index.js"))) refuse(`${abs} has no node_modules/prisma`);
  const envFiles = fs.readdirSync(abs).filter((f) => /^\.env(\..+)?$/.test(f) && !f.endsWith(".example"));
  if (envFiles.length) refuse(`${abs} has ${envFiles.join(", ")}; use a checkout without .env files`);
  return abs;
}

/** The Prisma CLI of `dir` against `url` only: every other database variable is removed from the child. */
function prismaCli(dir, url, args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG/i.test(k)) delete env[k];
  env.DATABASE_URL = url;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(dir, "node_modules", "prisma", "build", "index.js"), ...args], { cwd: dir, env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, ms: Date.now() - t0, out: redact(out) }));
  });
}
const usefulLines = (out) =>
  out.split(/\r?\n/).filter((l) => l.trim() && !/sslmode|libpq|SSL modes|verify-full|uselibpqcompat|prepare for this change|current behavior|weaker security|trace-warnings|^\s*at /.test(l));

/** Polls pg_locks on `db` (other sessions only) until stopped; keeps every distinct lock and the longest wait seen. */
function lockWatch(c0, url, intervalMs = 25) {
  const seen = new Map();
  let stop = false;
  let polls = 0;
  let drops = 0;
  let c = c0;
  const loop = (async () => {
    while (!stop) {
      polls++;
      let r;
      try {
        r = await c.query(`
        SELECT l.locktype, l.mode, l.granted, l.pid, c.relname, l.classid::text, l.objid::text, l.objsubid,
               a.application_name, extract(epoch FROM (clock_timestamp() - coalesce(l.waitstart, clock_timestamp()))) * 1000 AS wait_ms
          FROM pg_locks l
          LEFT JOIN pg_class c ON c.oid = l.relation
          LEFT JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.pid <> pg_backend_pid()
           AND (l.locktype = 'advisory' OR (l.locktype = 'relation' AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())))`);
      } catch {
        // The watcher's own connection dropped: reconnect and carry on (the migration is not affected).
        drops++;
        await c.end().catch(() => {});
        c = await client(url, "rehearsal-lock-watch").catch(() => c);
        continue;
      }
      for (const x of r.rows) {
        if (x.locktype === "relation" && (!x.relname || x.relname.startsWith("pg_"))) continue;
        const key = x.locktype === "advisory" ? `advisory ${x.classid}:${x.objid}:${x.objsubid} ${x.mode}` : `${x.relname} ${x.mode}`;
        const prev = seen.get(key) ?? { granted: false, waited: false, maxWaitMs: 0, apps: new Set() };
        prev.granted ||= x.granted;
        if (!x.granted) { prev.waited = true; prev.maxWaitMs = Math.max(prev.maxWaitMs, Number(x.wait_ms) || 0); }
        prev.apps.add(x.application_name || "?");
        seen.set(key, prev);
      }
      await new Promise((r2) => setTimeout(r2, intervalMs));
    }
  })();
  return {
    async stop() { stop = true; await loop; if (c !== c0) await c.end().catch(() => {}); return { polls, drops, locks: [...seen].map(([k, v]) => ({ lock: k, granted: v.granted, waited: v.waited, maxWaitMs: Math.round(v.maxWaitMs), by: [...v.apps].join(",") })) }; },
  };
}

async function migrationsTable(c) {
  const exists = await c.query(`SELECT to_regclass('"_prisma_migrations"') IS NOT NULL AS e`);
  if (!exists.rows[0].e) return [];
  const r = await c.query(`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count,
           extract(epoch FROM (finished_at - started_at)) * 1000 AS ms, left(coalesce(logs, ''), 400) AS logs
      FROM "_prisma_migrations" ORDER BY started_at, migration_name`);
  return r.rows;
}

function pendingFiles(dir, appliedNames) {
  const root = path.join(dir, "prisma", "migrations");
  return fs.readdirSync(root).filter((d) => /^\d{14}_/.test(d) && !appliedNames.has(d)).sort()
    .map((d) => ({ name: d, sql: fs.readFileSync(path.join(root, d, "migration.sql"), "utf8") }));
}

const RELEASE_OBJECTS = `
  SELECT 'table ClassMembershipTier' AS object, to_regclass('"ClassMembershipTier"') IS NOT NULL AS present
  UNION ALL SELECT 'column ' || table_name || '.' || column_name, true FROM information_schema.columns
   WHERE table_schema = 'public' AND ((table_name = 'Class' AND column_name = 'category')
      OR (table_name = 'MembershipTier' AND column_name IN ('classLimit', 'classLimitWeeks', 'classLimitBasis', 'classLimitAnchor'))
      OR (table_name = 'Member' AND column_name IN ('billingPeriodStart', 'billingPeriodEnd')))
  UNION ALL SELECT 'constraint ' || conname || CASE WHEN convalidated THEN '' ELSE ' (NOT VALID)' END, true FROM pg_constraint
   WHERE conname IN ('MembershipTier_classLimitBasis_check', 'MembershipTier_classLimitWeeks_check', 'MembershipTier_classLimit_check',
                     'MembershipTier_classLimit_basis_pair_check', 'Class_category_check')
  ORDER BY 1`;

async function printState(url) {
  const c = await client(url, "rehearsal-state");
  try {
    const rows = await migrationsTable(c);
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at);
    const rolled = rows.filter((r) => r.rolled_back_at);
    console.log(`${TAG} _prisma_migrations: ${rows.length} rows, ${rows.filter((r) => r.finished_at).length} finished, ${failed.length} failed (unfinished, not rolled back), ${rolled.length} rolled back`);
    for (const r of rows.slice(-8)) {
      console.log(`  ${r.migration_name}  finished=${r.finished_at ? "yes" : "NO"}  rolled_back=${r.rolled_back_at ? "yes" : "no"}  steps=${r.applied_steps_count}${r.ms != null ? `  ${Math.round(r.ms)} ms` : ""}`);
      if (!r.finished_at && r.logs) console.log(`    logs: ${redact(r.logs).split(/\r?\n/).filter(Boolean).slice(0, 4).join(" | ")}`);
    }
    const objs = await c.query(RELEASE_OBJECTS);
    console.log(`${TAG} release objects present: ${objs.rows.filter((o) => o.present).map((o) => o.object).join("; ") || "none"}`);
  } finally {
    await c.end();
  }
}

async function runMigrate(base, db, dir, { pooled = false, label = "migrate deploy" } = {}) {
  const url = dbUrl(base, db, { pooled });
  const watchUrl = dbUrl(base, db);
  const watcher = await client(watchUrl, "rehearsal-lock-watch");
  const rowKey = (r) => `${r.migration_name}|${r.started_at?.toISOString?.()}|${Boolean(r.finished_at)}|${Boolean(r.rolled_back_at)}`;
  const before = new Set((await migrationsTable(watcher)).map(rowKey));
  await watcher.end();
  const w = lockWatch(await client(watchUrl, "rehearsal-lock-watch"), watchUrl);
  const r = await prismaCli(dir, url, ["migrate", "deploy"]);
  const watched = await w.stop();
  const reader = await client(watchUrl, "rehearsal-state");
  const after = await migrationsTable(reader);
  await reader.end();
  console.log(`${TAG} ${label} (${pooled ? "pooled" : "direct"} host) from ${path.basename(dir)}: exit ${r.code}, wall ${r.ms} ms`);
  console.log(usefulLines(r.out).map((l) => `  | ${l}`).join("\n"));
  const fresh = after.filter((m) => !before.has(rowKey(m)));
  console.log(`${TAG} migrations recorded by this run: ${fresh.length}`);
  for (const m of fresh) console.log(`  ${m.migration_name}  ${m.finished_at ? `${Math.round(m.ms)} ms` : "NOT FINISHED"}${m.rolled_back_at ? " rolled back" : ""}`);
  console.log(`${TAG} locks observed by the watcher (${watched.polls} polls, ${watched.drops} watcher reconnects; brief DDL locks can fall between polls — see \`profile\`):`);
  for (const l of watched.locks) console.log(`  ${l.lock}  granted=${l.granted}${l.waited ? `  WAITED up to ${l.maxWaitMs} ms` : ""}  by=${l.by}`);
  return r.code;
}

const commands = {
  async create(varName) {
    const base = baseUrl(varName);
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const name = `matflow_rehearsal_${stamp}`;
    const c = await client(dbUrl(base, null), "rehearsal-create");
    try {
      await c.query(`CREATE DATABASE "${name}"`);
    } finally {
      await c.end();
    }
    console.log(`${TAG} created ${name}`);
    return 0;
  },

  async list(varName) {
    const c = await client(dbUrl(baseUrl(varName), null), "rehearsal-list");
    const r = await c.query(`SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE datname LIKE 'matflow\\_rehearsal\\_%' ORDER BY 1`);
    await c.end();
    console.log(`${TAG} rehearsal databases: ${r.rows.map((x) => `${x.datname} (${x.size})`).join(", ") || "none"}`);
    return 0;
  },

  async migrate(varName, db, dir, ...flags) {
    return runMigrate(baseUrl(varName), db, checkoutDir(dir), { pooled: flags.includes("--pooled") });
  },

  async profile(varName, db, dir) {
    const base = baseUrl(varName);
    const d = checkoutDir(dir);
    const c = await client(dbUrl(base, db), "rehearsal-profile");
    try {
      const applied = new Set((await migrationsTable(c)).filter((r) => r.finished_at).map((r) => r.migration_name));
      const files = pendingFiles(d, applied);
      console.log(`${TAG} profiling ${files.length} pending migration(s) in ONE transaction that is rolled back`);
      await c.query("BEGIN");
      const held = new Set();
      try {
        for (const f of files) {
          // The file's own BEGIN/COMMIT are removed so every file runs inside the profiling transaction; its
          // SET LOCAL lines still apply (to the rest of this transaction).
          const body = f.sql.split(/\r?\n/).filter((l) => !/^\s*(BEGIN|COMMIT)\s*;\s*(--.*)?$/i.test(l)).join("\n");
          const t0 = Date.now();
          await c.query(body);
          const ms = Date.now() - t0;
          const r = await c.query(`SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relname NOT LIKE 'pg\\_%' AND c.relkind IN ('r', 'p') ORDER BY 1, 2`);
          const fresh = r.rows.map((x) => `${x.relname} ${x.mode}`).filter((k) => !held.has(k));
          fresh.forEach((k) => held.add(k));
          console.log(`  ${f.name}: ${ms} ms client-side (one round trip included); new table locks: ${fresh.join("; ") || "none"}`);
        }
      } finally {
        await c.query("ROLLBACK");
      }
      const still = await migrationsTable(c);
      console.log(`${TAG} rolled back; _prisma_migrations unchanged at ${still.length} rows`);
    } finally {
      await c.end();
    }
    return 0;
  },

  async seed(varName, db, ...flags) {
    const arg = (k, dflt) => { const i = flags.indexOf(k); return i >= 0 ? Number(flags[i + 1]) : dflt; };
    const clubs = arg("--clubs", 4);
    const members = arg("--members", 3000);
    if (!(clubs >= 1 && clubs <= 20 && members >= 1 && members <= 20000)) refuse("--clubs 1..20, --members 1..20000 per club");
    const c = await client(dbUrl(baseUrl(varName), db), "rehearsal-seed");
    const t0 = Date.now();
    try {
      await c.query("BEGIN");
      // Synthetic only: rehearsal-club-N slugs and example.test addresses. Row-level security is FORCEd on these
      // tables, so the seed opts out for its own transaction only.
      await c.query(`SET LOCAL app.bypass_rls = 'on'`);
      await c.query(`INSERT INTO "Tenant" (id, name, slug) SELECT 'rht' || n, 'Rehearsal club ' || n, 'rehearsal-club-' || n FROM generate_series(1, $1) n`, [clubs]);
      await c.query(`INSERT INTO "MembershipTier" (id, "tenantId", name, "updatedAt", "maxClassesPerWeek")
        SELECT 'rhp' || n || '_' || t, 'rht' || n, 'Plan ' || t, now(), CASE WHEN t = 3 THEN 3 END FROM generate_series(1, $1) n, generate_series(1, 4) t`, [clubs]);
      await c.query(`INSERT INTO "Member" (id, "tenantId", email, name, "membershipTierId", status, "joinedAt", "updatedAt")
        SELECT 'rhm' || n || '_' || m, 'rht' || n, 'member' || m || '.club' || n || '@example.test', 'Member ' || m, 'rhp' || n || '_' || (1 + m % 4),
               CASE WHEN m % 10 = 0 THEN 'cancelled' WHEN m % 7 = 0 THEN 'inactive' ELSE 'active' END,
               now() - make_interval(days => m % 900), now()
          FROM generate_series(1, $1) n, generate_series(1, $2) m`, [clubs, members]);
      await c.query(`INSERT INTO "Class" (id, "tenantId", name, "maxCapacity")
        SELECT 'rhc' || n || '_' || k, 'rht' || n, 'Class ' || k, 30 FROM generate_series(1, $1) n, generate_series(1, 6) k`, [clubs]);
      await c.query(`INSERT INTO "ClassInstance" (id, "classId", date, "startTime", "endTime")
        SELECT 'rhi' || n || '_' || k || '_' || d, 'rhc' || n || '_' || k, date_trunc('day', now()) - make_interval(days => d), lpad((6 + k * 2)::text, 2, '0') || ':00', lpad((7 + k * 2)::text, 2, '0') || ':00'
          FROM generate_series(1, $1) n, generate_series(1, 6) k, generate_series(0, 179) d`, [clubs]);
      // About 40 attendances per member: member m attends class (m % 6)+1 on days spaced by its own stride.
      await c.query(`INSERT INTO "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod")
        SELECT 'rha' || n || '_' || m || '_' || j, 'rht' || n, 'rhm' || n || '_' || m, 'rhi' || n || '_' || (1 + m % 6) || '_' || ((j * 4 + m % 4) % 180),
               date_trunc('day', now()) - make_interval(days => (j * 4 + m % 4) % 180) + interval '18 hours', CASE WHEN j % 3 = 0 THEN 'kiosk' ELSE 'admin' END
          FROM generate_series(1, $1) n, generate_series(1, $2) m, generate_series(0, 39) j
        ON CONFLICT DO NOTHING`, [clubs, members]);
      await c.query(`INSERT INTO "MemberStatusEvent" (id, "tenantId", "memberId", "fromStatus", "toStatus", reason, "occurredAt")
        SELECT 'rhe' || n || '_' || m || '_' || e, 'rht' || n, 'rhm' || n || '_' || m,
               CASE e WHEN 0 THEN NULL WHEN 1 THEN 'active' ELSE 'inactive' END, CASE e WHEN 0 THEN 'active' WHEN 1 THEN 'inactive' ELSE 'active' END,
               CASE WHEN e = 0 THEN 'import' ELSE 'staff_edit' END, now() - make_interval(days => 900 - e * 200 - m % 100)
          FROM generate_series(1, $1) n, generate_series(1, $2) m, generate_series(0, 2) e`, [clubs, members]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    }
    await c.query(`ANALYZE`);
    const counts = await c.query(`SELECT (SELECT count(*) FROM "Tenant") AS clubs, (SELECT count(*) FROM "Member") AS members,
      (SELECT count(*) FROM "ClassInstance") AS instances, (SELECT count(*) FROM "AttendanceRecord") AS attendance,
      (SELECT count(*) FROM "MemberStatusEvent") AS status_events, pg_size_pretty(pg_database_size(current_database())) AS size`);
    await c.end();
    console.log(`${TAG} seeded in ${Date.now() - t0} ms: ${JSON.stringify(counts.rows[0])}`);
    return 0;
  },

  async partial(varName, db, dir, table) {
    if (!/^[A-Za-z]+$/.test(table ?? "")) refuse("name the table to hold, e.g. Member");
    const base = baseUrl(varName);
    const d = checkoutDir(dir);
    const holder = await client(dbUrl(base, db), "rehearsal-conflicting-session");
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE "${table}" IN ACCESS SHARE MODE`);
    console.log(`${TAG} another session holds ACCESS SHARE on "${table}" (what any open transaction that read it holds)`);
    // Who waits for "${table}", for how long, and with which error the wait ends (the server's own view; Prisma's
    // output can mask the cause — see the rehearsal record).
    const poller = await client(dbUrl(base, db), "rehearsal-wait-poller");
    const waits = new Map();
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const r = await poller.query(`
          SELECT l.pid, l.mode, extract(epoch FROM (clock_timestamp() - l.waitstart)) * 1000 AS ms, a.wait_event_type, a.wait_event,
                 left(regexp_replace(a.query, '\\s+', ' ', 'g'), 90) AS q
            FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'relation' AND l.relation = $1::regclass AND NOT l.granted`, [`"${table}"`]).catch(() => ({ rows: [] }));
        for (const x of r.rows) {
          const k = `${x.pid} ${x.mode}`;
          const p = waits.get(k) ?? { maxMs: 0, q: x.q, ev: `${x.wait_event_type}/${x.wait_event}` };
          p.maxMs = Math.max(p.maxMs, Number(x.ms) || 0);
          waits.set(k, p);
        }
        await new Promise((r2) => setTimeout(r2, 50));
      }
    })();
    let code;
    try {
      code = await runMigrate(base, db, d, { label: `migrate deploy while "${table}" is held` });
    } finally {
      polling = false;
      await poll;
      await poller.end();
      await holder.query("ROLLBACK");
      await holder.end();
      console.log(`${TAG} conflicting session released`);
    }
    console.log(`${TAG} waits on "${table}" seen by the poller: ${waits.size}`);
    for (const [k, v] of waits) console.log(`  pid/mode ${k}: waited at least ${Math.round(v.maxMs)} ms (${v.ev}) on: ${v.q}`);
    await printState(dbUrl(base, db));
    return code === 0 ? 1 : 0; // the rehearsal expects the deploy to FAIL
  },

  async resolve(varName, db, dir, migration) {
    if (!/^\d{14}_[a-z0-9_]+$/.test(migration ?? "")) refuse("name the migration directory to mark rolled back");
    const r = await prismaCli(checkoutDir(dir), dbUrl(baseUrl(varName), db), ["migrate", "resolve", "--rolled-back", migration]);
    console.log(`${TAG} migrate resolve --rolled-back ${migration}: exit ${r.code}`);
    console.log(usefulLines(r.out).map((l) => `  | ${l}`).join("\n"));
    return r.code === 0 ? 0 : 1;
  },

  async state(varName, db) {
    await printState(dbUrl(baseUrl(varName), db));
    return 0;
  },

  async advisory(varName, db, dir, ...flags) {
    const base = baseUrl(varName);
    const d = checkoutDir(dir);
    const pooled = flags.includes("--pooled");
    // 1. A session holding the SHARED form of the key: does migrate deploy wait for it, and for how long?
    const sharer = await client(dbUrl(base, db), "rehearsal-shared-holder");
    await sharer.query("BEGIN");
    await sharer.query(`SELECT pg_advisory_xact_lock_shared(${PRISMA_MIGRATE_LOCK_KEY}::bigint)`);
    const holdMs = Number(flags[flags.indexOf("--hold-s") + 1] || 40) * 1000;
    console.log(`${TAG} step 1: another session holds pg_advisory_xact_lock_shared(${PRISMA_MIGRATE_LOCK_KEY}) for ${holdMs / 1000} s`);
    const releaseAt = setTimeout(() => sharer.query("ROLLBACK").then(() => sharer.end()), holdMs);
    const t1 = Date.now();
    const run1 = runMigrate(base, db, d, { pooled, label: "migrate deploy while the shared form is held" });
    // Once migrate deploy is WAITING for the exclusive form, can a NEW job still take the shared form? (Postgres queues
    // a new lock request behind a conflicting waiter, so the try-form is expected to refuse.)
    const late = await client(dbUrl(base, db), "rehearsal-late-job");
    let waitSeenAt = null;
    while (Date.now() - t1 < holdMs - 2_000) {
      const n = (await late.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = ${PRISMA_MIGRATE_LOCK_KEY} AND NOT granted`)).rows[0].n;
      if (n > 0) { waitSeenAt = Date.now() - t1; break; }
      await new Promise((r2) => setTimeout(r2, 200));
    }
    if (waitSeenAt !== null) {
      await late.query("BEGIN");
      const lateOk = (await late.query(`SELECT pg_try_advisory_xact_lock_shared(${PRISMA_MIGRATE_LOCK_KEY}::bigint) AS ok`)).rows[0].ok;
      await late.query("ROLLBACK");
      console.log(`${TAG} step 1: migrate deploy waiting for the exclusive form from ~${waitSeenAt} ms; a new job's try-shared then: ${lateOk ? "ADMITTED" : "refused"}`);
    } else {
      console.log(`${TAG} step 1: no waiting exclusive request seen while the shared form was held`);
    }
    await late.end();
    const code1 = await run1;
    console.log(`${TAG} step 1: migrate deploy ended ${Date.now() - t1} ms after it started (shared form released at ${holdMs} ms)`);
    clearTimeout(releaseAt);
    await sharer.query("ROLLBACK").catch(() => {});
    await sharer.end().catch(() => {});
    // 2. While migrate deploy runs, does the try-form of the shared lock see it held?
    console.log(`${TAG} step 2: probing pg_try_advisory_xact_lock_shared(${PRISMA_MIGRATE_LOCK_KEY}) every 50 ms during migrate deploy`);
    const prober = await client(dbUrl(base, db), "rehearsal-try-prober");
    let stop = false;
    let refused = 0;
    let admitted = 0;
    const probe = (async () => {
      while (!stop) {
        await prober.query("BEGIN");
        const r = await prober.query(`SELECT pg_try_advisory_xact_lock_shared(${PRISMA_MIGRATE_LOCK_KEY}::bigint) AS ok`);
        await prober.query("ROLLBACK");
        if (r.rows[0].ok) admitted++; else refused++;
        await new Promise((r2) => setTimeout(r2, 50));
      }
    })();
    const code2 = await runMigrate(base, db, d, { pooled, label: "migrate deploy while probing" });
    stop = true;
    await probe;
    await prober.end();
    console.log(`${TAG} probe during migrate: refused ${refused}, admitted ${admitted}`);
    return code1 === 0 && code2 === 0 ? 0 : 1;
  },

  async drop(varName, db) {
    const base = baseUrl(varName);
    dbUrl(base, db); // name check
    const c = await client(dbUrl(base, null), "rehearsal-drop");
    try {
      const cur = await c.query("SELECT current_database() AS d");
      if (cur.rows[0].d === db) refuse("connected to the database being dropped");
      await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    } finally {
      await c.end();
    }
    console.log(`${TAG} dropped ${db}`);
    return 0;
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.log("usage: node scripts/readiness/migration-rehearsal.mjs create|list|migrate|profile|seed|partial|resolve|state|advisory|drop VAR …");
  process.exit(2);
}
console.log(`${TAG} node ${process.version}`);
commands[cmd](...rest).then(
  (code) => process.exit(code ?? 0),
  (e) => {
    console.error(`${TAG} FAILED: ${redact(e?.message ?? e)}`);
    process.exit(1);
  },
);
