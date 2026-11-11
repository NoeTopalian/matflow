// Prisma migrations of THIS worktree against the Neon TEST branch only (DATABASE_URL from .env.test, guarded).
//   node migrate-test.mjs status            read only: which migrations the test branch has applied
//   node migrate-test.mjs dev <name>        create a migration from schema changes and apply it to the test branch
//   node migrate-test.mjs deploy            apply this worktree's pending migrations to the test branch
//   node migrate-test.mjs checksum <dir>    after editing an ALREADY-APPLIED migration of this worktree (comments, the
//                                           BEGIN/timeout wrapper — never its effect), record the edited file's checksum
//                                           on the test branch so `migrate dev` elsewhere does not see a modified
//                                           migration. Touches that one _prisma_migrations row only, compare-and-set.
// Never `db push`, never against production (the main checkout's .env is production and is never read here).
//
// Connection and lock handling (11 Nov 2026, after a stranded lock on the shared test branch):
//   - The Prisma CLI runs on the DIRECT host, never the -pooler host. Prisma Migrate serialises itself on a SESSION
//     advisory lock (pg_advisory_lock(72707369), lib/migration-lock.ts). Through pgbouncer in transaction mode the lock
//     and its unlock can land on different server connections, so the lock stayed held on a pooled backend that later
//     clients reused, and every import route answered "a database update is being applied" (holdOffMigrations). On a
//     direct connection the lock lives and dies with one real backend: Postgres releases it when the CLI disconnects,
//     however the run ends (scripts/readiness/migration-rehearsal.mjs uses the same rule).
//   - Every connection of a run carries application_name `mf-migrate-test-<run>`; the run records its own and its
//     child's process ids under %LOCALAPPDATA%\matflow-verify\migrate-test\.
//   - Before a run, a backend holding the lock is ended ONLY when it carries a mf-migrate-test tag whose recorded
//     processes are both gone (an orphan of an earlier run of this tool). A holder still owned by a live run, and any
//     holder that is not this tool's, is reported and the run refuses (exit 3): it is never terminated.
//   - After a run (success, failure, or interruption by Ctrl+C / SIGTERM, which stops the CLI's process tree first), the
//     run checks no backend of its own still holds the lock, ends only its own if one does, and says so.
//   - MF_MIGRATE_TEST_DB=matflow_rehearsal_<14 digits> targets a scratch database on the same test endpoint instead
//     (created and dropped with scripts/readiness/migration-rehearsal.mjs), for verifying this behaviour in isolation.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { APP, DATA, TEST_HOST, assertTestUrl, assertWorktree, node24, prismaEnv } from "./env.mjs";

const LOCK_KEY = 72707369; // Prisma Migrate's advisory lock (schema engine 7.x), lib/migration-lock.ts
const TAG_PREFIX = "mf-migrate-test-";
const RUN = `${TAG_PREFIX}${process.pid}-${randomBytes(3).toString("hex")}`;
const RUNS = path.join(DATA, "migrate-test");
const WIN = process.platform === "win32";
const redact = (s) => String(s ?? "").replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");

const [cmd, name] = process.argv.slice(2);

/** The test branch's URL on the DIRECT host, tagged with this run's application_name; optionally a scratch database. */
function migrationUrl() {
  const u = new URL(assertTestUrl(prismaEnv().DATABASE_URL, "DATABASE_URL"));
  u.hostname = u.hostname.replace(/-pooler\./, ".");
  for (const k of ["pgbouncer", "connection_limit", "application_name"]) u.searchParams.delete(k);
  u.searchParams.set("application_name", RUN);
  const scratch = process.env.MF_MIGRATE_TEST_DB;
  if (scratch !== undefined) {
    if (!/^matflow_rehearsal_\d{14}$/.test(scratch)) throw new Error("refusing: MF_MIGRATE_TEST_DB must be a matflow_rehearsal_<14 digits> scratch database");
    u.pathname = `/${scratch}`;
  }
  if (u.hostname.includes("-pooler") || !u.hostname.startsWith(TEST_HOST)) throw new Error("refusing: not the direct host of the Neon test branch");
  return assertTestUrl(u.toString(), "migration URL");
}

const pg = () => createRequire(`${APP}/package.json`)("pg");
async function connect(url, suffix) {
  const c = new (pg().Client)({ connectionString: url.replace(`application_name=${RUN}`, `application_name=${RUN}-${suffix}`), connectionTimeoutMillis: 20_000 });
  c.on("error", (e) => console.log(`[migrate-test] connection dropped: ${redact(e?.message ?? e)}`));
  await c.connect();
  return c;
}

/** Backends of THIS database holding (or waiting for) Prisma Migrate's lock. */
async function lockHolders(c) {
  return (await c.query(
    `SELECT a.pid, a.application_name AS app, l.granted
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.objid = $1 AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [LOCK_KEY],
  )).rows;
}

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const runFile = (tag) => path.join(RUNS, `${tag}.json`);
function recordRun(childPid) {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(runFile(RUN), JSON.stringify({ tag: RUN, parentPid: process.pid, childPid, startedAt: new Date().toISOString(), cmd }));
}
/** Whether a mf-migrate-test tag belongs to a run with a live process (its record, or the pid in the tag). */
function runIsLive(app) {
  const tag = app.match(/^(mf-migrate-test-\d+-[0-9a-f]{6})/)?.[1];
  if (!tag) return { ours: false, live: false };
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(runFile(tag), "utf8")); } catch { /* no record */ }
  const parentPid = rec?.parentPid ?? Number(tag.split("-")[3]);
  return { ours: true, tag, live: alive(parentPid) || alive(rec?.childPid) };
}

/** Before a run: end orphaned lock holders of THIS tool only; refuse on any other holder. Never touches unrelated sessions. */
async function sweepBefore(url) {
  const c = await connect(url, "sweep");
  try {
    const holders = await lockHolders(c);
    for (const h of holders) {
      const who = runIsLive(h.app ?? "");
      if (who.ours && !who.live) {
        const ended = (await c.query("SELECT pg_terminate_backend($1) AS ok", [h.pid])).rows[0].ok;
        console.log(`[migrate-test] ended orphaned backend ${h.pid} of an earlier run (${who.tag}, its processes are gone): ${ended}`);
        try { fs.rmSync(runFile(who.tag)); } catch { /* none */ }
      } else {
        console.log(`[migrate-test] REFUSED: Prisma Migrate's lock is ${h.granted ? "held" : "awaited"} by backend ${h.pid} (${h.app || "no application_name"}${who.ours ? ", a live migrate-test run" : ", not this tool's"}); it was not touched. Wait for it to finish, or ask its owner.`);
        return false;
      }
    }
    return true;
  } finally {
    await c.end().catch(() => {});
  }
}

/** After a run, however it ended: no backend of THIS run may still hold the lock; end only our own if one does. */
async function verifyAfter(url) {
  const c = await connect(url, "verify");
  try {
    const holders = await lockHolders(c);
    const ours = holders.filter((h) => (h.app ?? "").startsWith(RUN) && !(h.app ?? "").endsWith("-verify"));
    for (const h of ours) {
      const ended = (await c.query("SELECT pg_terminate_backend($1) AS ok", [h.pid])).rows[0].ok;
      console.log(`[migrate-test] backend ${h.pid} of this run still held the lock after the CLI ended; ended it: ${ended}`);
    }
    const left = (await lockHolders(c)).filter((h) => (h.app ?? "").startsWith(RUN));
    const others = holders.filter((h) => !(h.app ?? "").startsWith(RUN));
    console.log(`[migrate-test] LOCK ${left.length === 0 ? "RELEASED" : "STILL HELD"}: ${left.length} backend(s) of this run hold Prisma Migrate's lock; ${others.length} other holder(s) untouched`);
    return left.length === 0;
  } finally {
    await c.end().catch(() => {});
    try { fs.rmSync(runFile(RUN)); } catch { /* none */ }
  }
}

/** Stop the CLI and everything it started (Windows: the whole process tree). */
function stopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (WIN) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

if (cmd === "checksum") {
  if (!/^\d{14}_[a-z0-9_]+$/.test(name ?? "")) { console.log("usage: node migrate-test.mjs checksum <migration directory name>"); process.exit(2); }
  assertWorktree();
  const file = `${APP}/prisma/migrations/${name}/migration.sql`;
  if (!fs.existsSync(file)) { console.log(`refusing: ${name} is not a migration of this worktree`); process.exit(2); }
  // Prisma's migration checksum: sha256 of the file's bytes, lower-case hex.
  const want = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const client = await connect(migrationUrl(), "checksum");
  try {
    const row = (await client.query('SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1', [name])).rows;
    if (row.length !== 1 || !row[0].finished_at) { console.log(`refusing: ${name} is not applied exactly once on the test branch (rows ${row.length})`); process.exit(2); }
    const had = row[0].checksum;
    if (had === want) { console.log(`CHECKSUM ${name} already matches the file (${want.slice(0, 12)}…)`); process.exit(0); }
    const set = await client.query('UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2 AND checksum = $3', [want, name, had]);
    const now = (await client.query('SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1', [name])).rows[0].checksum;
    console.log(`CHECKSUM ${name} ${had.slice(0, 12)}… -> ${now.slice(0, 12)}… (rows updated ${set.rowCount}; matches file ${now === want})`);
    process.exit(now === want ? 0 : 1);
  } finally {
    await client.end().catch(() => {});
  }
}

const args = { status: ["migrate", "status"], deploy: ["migrate", "deploy"], dev: ["migrate", "dev", "--name", name] }[cmd];
if (!args || (cmd === "dev" && !/^[a-z0-9_]+$/.test(name ?? ""))) { console.log("usage: node migrate-test.mjs status | deploy | dev <snake_case_name> | checksum <migration dir>"); process.exit(2); }
assertWorktree();
const url = migrationUrl();
if (!(await sweepBefore(url))) process.exit(3);

const env = { ...prismaEnv(), DATABASE_URL: url };
const child = spawn(node24(), ["node_modules/prisma/build/index.js", ...args], { cwd: APP, env, detached: !WIN, stdio: ["ignore", "pipe", "pipe"] });
recordRun(child.pid);
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
let interrupted = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { interrupted = true; console.log(`[migrate-test] ${sig}: stopping the Prisma CLI`); stopTree(child); });
}
const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
console.log(redact(out).split(/\r?\n/).filter((l) => l.trim() && !/sslmode|libpq|SSL modes|verify-full|uselibpqcompat|prepare for this change|current behavior|weaker security|trace-warnings/.test(l)).join("\n"));
const released = await verifyAfter(url).catch((e) => { console.log(`[migrate-test] could not verify the lock: ${redact(e?.message ?? e)}`); return false; });
console.log(`PRISMA ${cmd.toUpperCase()} EXIT ${interrupted ? "interrupted" : code}`);
process.exit(interrupted ? 130 : (code ?? 1) || (released ? 0 : 4));
