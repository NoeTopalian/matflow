// Run journeys one after another, each on a fresh fixture, under the journey lock (harness.mjs). Run from the
// worktree under test (or set MF_APP), on the Neon TEST branch only.
//   node run-journeys.mjs [options] [journey ...]      journeys are names under journeys/ ("smoke" = smoke.mjs)
//   --no-server             do not start or check the app server (fixture-only journeys, e.g. selftest-stub)
//   --allow-foreign         start even while other test-branch node processes (vitest, db-tests, migrate-test,
//                           other journeys) are running; refused by default
//   --fault <name>          harness self-test only: passed to fixture teardown as MF_HARNESS_FAULT
// Exit: 0 all journeys passed and every fixture torn down · 1 a journey failed · 3 refused (lock held, or foreign
// processes) · 4 server not on a build of HEAD · 5 a fixture was not created fresh · 6 a teardown did not finish.
//
// Safety (see harness.mjs): the lock is taken atomically before anything touches the test branch; a stale lock (its
// holder gone, or its pid reused) is reclaimed and the run it belonged to is recovered first — its surviving
// children killed by tree, its open fixtures torn down. Every child is recorded (pid + start time) in
// DATA/runs/<runId>/run.json before it is waited on; the manifest (sha256 of every harness file, build commit,
// migrations) is written before the first journey. Stopping a run: Ctrl+C (children are killed by tree and fixtures
// torn down), or kill it any way at all — the next start recovers it.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { APP, OUT, PORT, testEnv, assertTestUrl } from "../../matflow-verify-local/scripts/env.mjs";
import {
  HERE, acquireLock, releaseLock, newRunId, writeRun, updateRun, readRun, runDir, recoverOrphans, runChild,
  killChildren, openFixtures, writeManifest, recordChild, markEnded, readJson,
} from "./harness.mjs";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const noServer = flag("--no-server");
const allowForeign = flag("--allow-foreign");
const fault = opt("--fault");
const DEFAULT = ["next-16-4-smoke", "allowance-eligibility", "member-booking-notice", "scanner-override", "reporting-truth", "headcount-movement", "permissions-matrix", "accounts-and-members"];
const journeys = args.length ? args : DEFAULT;
const L = path.resolve(HERE, "../../matflow-verify-local/scripts").replace(/\\/g, "/");
const journeyFile = (j) => (j === "smoke" ? `${HERE}/smoke.mjs` : `${HERE}/journeys/${j}.mjs`);
for (const j of journeys) if (!fs.existsSync(journeyFile(j))) { console.error(`unknown journey ${j} (${journeyFile(j)})`); process.exit(2); }

const runId = newRunId();
const got = acquireLock({ runId, kind: "run", cmd: `run-journeys ${journeys.join(" ")}` });
if (!got.acquired) {
  console.log(`REFUSED: run ${got.holder.runId} (pid ${got.holder.pid}, ${got.holder.kind}) holds the journey lock (${got.state})`);
  process.exit(3);
}
const lock = got.lock;
const log = (s) => console.log(`[run ${runId}] ${s}`);
const logFile = (name) => `${runDir(runId)}/${name}.log`;
writeRun({ runId, kind: "run", phase: "starting", holder: { pid: lock.pid, start: lock.start }, app: APP, journeys, startedAt: lock.at, children: [], results: [] });
log(`lock taken: pid ${lock.pid}, app ${APP}, journeys ${journeys.join(", ")}`);

let finishing = false;
let serverStarted = false;
function stopServer() {
  if (!serverStarted) return;
  serverStarted = false;
  const r = spawnSync(process.execPath, [`${L}/server.mjs`, "stop"], { cwd: APP, encoding: "utf8", timeout: 120000, windowsHide: true });
  log(`server stop exit ${r.status}`);
  markEnded(runId, ["server", "proxy"]);
}
function finish(code, phase) {
  if (finishing) return;
  finishing = true;
  stopServer();
  // Nothing the run started may outlive it: anything recorded and still the same process is killed by tree.
  for (const k of killChildren(runId, "run finished")) if (k.killed) log(`  killed leftover ${k.role} pid ${k.pid}`);
  updateRun(runId, (r) => { r.phase = phase; r.endedAt = new Date().toISOString(); r.exit = code; });
  releaseLock(lock);
  log(`${phase}; lock released; exit ${code}`);
  process.exit(code);
}
/** Ctrl+C or a polite kill: children killed by tree, open fixtures torn down, lock released. */
function interrupted(sig) {
  if (finishing) return;
  log(`${sig}: stopping children and tearing down`);
  const killed = killChildren(runId, sig);
  for (const k of killed) log(`  killed ${JSON.stringify(k)}`);
  for (const f of openFixtures(runId)) {
    const r = spawnSync(process.execPath, [`${HERE}/fixture.mjs`, "teardown"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_LOCK_RUN: runId, MF_RUN_ID: runId }, timeout: 300000 });
    log(`  teardown ${f.slug}: exit ${r.status}`);
  }
  finish(130, "interrupted");
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => interrupted(sig));
process.on("exit", () => releaseLock(lock));

// 1. Recover any run whose holder is gone.
updateRun(runId, (r) => { r.phase = "recovering"; });
const recovered = recoverOrphans(runId);
updateRun(runId, (r) => { r.recovered = recovered; });
if (recovered.some((r) => r.stillOpen?.length)) { log("ABORT: an earlier run's fixtures could not be torn down; see the recovery line above"); finish(6, "aborted"); }

// 2. Nothing else may be using the test branch.
if (!allowForeign) {
  const me = new Set([process.pid]);
  const ps = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", timeout: 60000, windowsHide: true })
    : spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (ps.status !== 0) { log("REFUSED: the process check failed"); finish(3, "refused"); }
  const TEST_BRANCH_USER = /matflow-verify-browser[\\/]scripts[\\/](journeys|smoke\.mjs)|fixture\.mjs|db-tests\.mjs|migrate-test\.mjs|vitest/;
  const foreign = ps.stdout.split(/\r?\n/)
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
    .filter((m) => !me.has(Number(m[1])) && TEST_BRANCH_USER.test(m[2]))
    .map((m) => [m[1], m[2]]);
  if (foreign.length) { log(`REFUSED: ${foreign.length} other test-branch node process(es) running (pids ${foreign.map(([p]) => p).join(", ")}); --allow-foreign overrides`); finish(3, "refused"); }
}

// 3. The server, on a build of HEAD.
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: APP, encoding: "utf8" }).stdout.trim();
if (!noServer) {
  updateRun(runId, (r) => { r.phase = "server"; });
  const s = await runChild(runId, "server-start", `${L}/server.mjs`, ["start"], { logFile: logFile("server-start") });
  const started = fs.readFileSync(logFile("server-start"), "utf8").split("\n").find((l) => l.startsWith("started")) ?? "";
  log(started || `server start exit ${s.code}`);
  // server.mjs starts the app server and the HTTPS proxy DETACHED: they outlive any parent, so the run records
  // them (pid + start time) and answers for them — stopped at the end, or killed by the next run's recovery.
  const pids = readJson(`${OUT}/pids-${PORT}.json`);
  for (const [role, pid] of [["server", pids?.server], ["proxy", pids?.proxy]]) if (pid) recordChild(runId, pid, role);
  serverStarted = s.code === 0;
  if (s.code !== 0 || !started.includes(`build of ${head.slice(0, 8)}`)) { log(`ABORT: the server is not on a build of ${head.slice(0, 8)}`); finish(4, "aborted"); }
}

// 4. The manifest, before the first journey.
let applied = null;
try {
  const require = createRequire(`${APP}/package.json`);
  const pg = require("pg");
  const c = new pg.Client({ connectionString: assertTestUrl(testEnv().DATABASE_URL, "DATABASE_URL"), statement_timeout: 20000, connectionTimeoutMillis: 20000 });
  await c.connect();
  try { applied = (await c.query(`select migration_name from "_prisma_migrations" where finished_at is not null and rolled_back_at is null order by migration_name`)).rows.map((r) => r.migration_name); }
  finally { await c.end(); }
} catch (e) { applied = { unreadable: String(e).slice(0, 160) }; }
const manifest = writeManifest(runId, { appliedMigrations: applied, journeys });
log(`manifest ${runDir(runId)}/manifest.json: ${Object.keys(manifest.harness.files).length} harness files, app ${String(manifest.app.head).slice(0, 8)}${manifest.app.dirty ? " (dirty)" : ""}, build ${manifest.build ? String(manifest.build.commit).slice(0, 8) : "none"}, ${manifest.migrations.inWorktree.length} migrations in the worktree, ${Array.isArray(applied) ? applied.length : "?"} applied on the test branch`);

// 5. Journeys, each on a fresh fixture.
updateRun(runId, (r) => { r.phase = "journeys"; });
let failed = 0;
for (const j of journeys) {
  const created = await runChild(runId, `fixture-create:${j}`, `${HERE}/fixture.mjs`, ["create"], { logFile: logFile(`fixture-${j}`) });
  const createdLine = fs.readFileSync(logFile(`fixture-${j}`), "utf8").split("\n").find((l) => l.includes('"created"')) ?? "";
  log(`fixture for ${j}: ${createdLine || `create exit ${created.code}`}`);
  if (created.code !== 0 || !createdLine) { log("ABORT: fixture.mjs create did not report a new fixture"); failed += 1; await teardown(); finish(5, "aborted"); }
  const t0 = Date.now();
  const jr = await runChild(runId, `journey:${j}`, journeyFile(j), [], { logFile: logFile(`journey-${j}`) });
  const out = fs.readFileSync(logFile(`journey-${j}`), "utf8");
  const tally = out.match(/\d+ PASS \/ \d+ FAIL \/ \d+ NOTE/g)?.pop() ?? null;
  const fails = out.split("\n").filter((l) => l.startsWith("FAIL")).length;
  const ok = jr.code === 0 && fails === 0;
  if (!ok) failed += 1;
  updateRun(runId, (r) => { r.results.push({ journey: j, exit: jr.code, fails, tally, seconds: Math.round((Date.now() - t0) / 1000) }); });
  log(`journey ${j}: exit ${jr.code}${tally ? `, ${tally}` : ""}${fails ? `, ${fails} FAIL line(s)` : ""} (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!(await teardown())) finish(6, "teardown-failed");
}

async function teardown() {
  updateRun(runId, (r) => { r.phase = "teardown"; });
  const r = await runChild(runId, "fixture-teardown", `${HERE}/fixture.mjs`, ["teardown"], { logFile: logFile("fixture-teardown"), env: fault ? { MF_HARNESS_FAULT: fault } : {} });
  const last = fs.readFileSync(logFile("fixture-teardown"), "utf8").trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "";
  log(`teardown: exit ${r.code} ${last}`);
  updateRun(runId, (x) => { x.phase = "journeys"; });
  return r.code === 0 && openFixtures(runId).length === 0;
}

// 6. Finish (finish() stops the server).
const run = readRun(runId);
log(`results ${JSON.stringify(run.results)}`);
finish(failed ? 1 : 0, "done");
