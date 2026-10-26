// The journey harness's safety layer: one lock for every process that uses the Neon TEST branch's journey fixtures,
// per-run fixture ownership with an append-only ledger, process-tree control and the run manifest. No Playwright and
// no database here, so the lock is decided before anything else loads. Everything it writes stays under
// %LOCALAPPDATA%/matflow-verify (DATA); nothing it writes belongs in git.
//
// THE LOCK (DATA/journeys.lock) is one JSON record { runId, kind, pid, start, cmd, app, at }.
//   - Written atomically: the record is written in full to a private temporary file, then hard-linked to the lock
//     name. link() fails with EEXIST if the name exists, so exactly one of any number of simultaneous starters
//     wins, and a lock file is never visible half-written (a reader sees the whole record or no file).
//   - Held while its holder is the SAME process: the pid is alive AND its start time (from the OS) equals the
//     recorded one. A dead pid, or a live pid with another start time (the pid was reused), is a stale lock. A
//     holder whose start time cannot be read is treated as live: staleness is never assumed.
//   - Reclaimed by compare-and-delete under a short mutex (DATA/journeys.lock.reclaim, mkdir): the lock is removed
//     only if it is still the exact stale record that was read, so a reclaimer can never delete a fresh lock that a
//     faster starter has just taken. Then acquisition is attempted again like any start.
//   - Children: every process a run starts is recorded in its run file with pid AND start time. A process is killed
//     (by tree) only while both still match, so a reused pid belonging to something else is never touched.
//   - Recovery: whoever holds the lock first recovers orphaned runs (an unfinished run whose holder is gone): kills
//     its surviving recorded children by tree, then tears down the fixtures the ledger says it created and did not
//     tear down. Teardown is idempotent, so a crash during it is resumed by the next start.
//
// PARTICIPATION. lib.mjs (journeys) and fixture.mjs call joinLock() on import:
//   - a child of a run carries MF_LOCK_RUN; it proceeds only while that run holds the lock and is alive;
//   - anything started by hand acquires the lock itself (kind "direct") for its lifetime, or refuses (exit 3)
//     while a run holds it. A hand session's fixtures belong to the run id MF_RUN_ID, or to a stable per-worktree
//     manual id, and are never torn down by anyone else.
//
// OWNERSHIP. A run id is "r" + lowercase base36 time + random hex (a hand session: "h" + a hash of the worktree). Its fixtures' slugs embed it (mfv-<runId>-<n>), its
// fixture state is DATA/runs/<runId>/fixture-state.json, and every create and teardown is a line in the append-only
// ledger DATA/fixtures-ledger.jsonl. Teardown deletes only a tenant whose id, slug and ledger entry all agree;
// anything else is refused as uncertain. Nothing ever sweeps "mfv-" clubs by name.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP, OUT, DATA } from "../../matflow-verify-local/scripts/env.mjs";

export { APP, OUT, DATA };
const WIN = process.platform === "win32";
export const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/");
export const LOCK = `${DATA}/journeys.lock`;
const RECLAIM = `${DATA}/journeys.lock.reclaim`;
/** The lock directory the earlier shell runner used; a live holder there blocks this harness too. */
const LEGACY_LOCK = `${DATA}/journeys.lockdir`;
export const LEDGER = `${DATA}/fixtures-ledger.jsonl`;
export const RUNS = `${DATA}/runs`;
fs.mkdirSync(RUNS, { recursive: true });

export const newRunId = () => `r${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
/** A hand session's run id: stable per worktree, so create, journey and teardown run by hand share one fixture. */
export const manualRunId = () => `h${createHash("sha256").update(APP).digest("hex").slice(0, 10)}`;
export const runDir = (runId) => `${RUNS}/${runId}`;
export const fixtureStatePath = (runId) => `${runDir(runId)}/fixture-state.json`;

// ── Files written whole ───────────────────────────────────────────────────────────────────────────────────────────

/** Write a file so no reader ever sees part of it: write a temporary sibling in full, then rename over. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
export const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// ── Processes ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/** When the OS says process `pid` started (an opaque string), or null if it is gone or unreadable. */
export function processStart(pid) {
  if (!alive(pid)) return null;
  if (WIN) {
    const ps = `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { try { $p.StartTime.ToUniversalTime().ToString('o') } catch { '' } }`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 30000, windowsHide: true });
    return r.stdout?.trim() || null;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return `ticks:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return r.stdout.trim() || null;
  }
}

/** "same" | "gone" | "reused" (pid alive, another start time) | "unknown" (alive, start time unreadable). */
export function identity(rec) {
  if (!alive(rec.pid)) return "gone";
  const start = processStart(rec.pid);
  if (!start) return alive(rec.pid) ? "unknown" : "gone";
  return start === rec.start ? "same" : "reused";
}

/** Kill a recorded process and its whole tree, only while pid AND start time are still the recorded ones. */
export function killTree(rec, why) {
  const who = identity(rec);
  if (who !== "same") return { pid: rec.pid, role: rec.role, killed: false, why: `${who === "reused" ? "pid reused by another process" : who}: left alone` };
  if (WIN) spawnSync("taskkill", ["/PID", String(rec.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-rec.pid, "SIGKILL"); } catch { try { process.kill(rec.pid, "SIGKILL"); } catch {} } }
  return { pid: rec.pid, role: rec.role, killed: !alive(rec.pid) || identity(rec) !== "same", why };
}

// ── Run records ───────────────────────────────────────────────────────────────────────────────────────────────────

export function readRun(runId) { return readJson(`${runDir(runId)}/run.json`); }
export function writeRun(run) { writeAtomic(`${runDir(run.runId)}/run.json`, JSON.stringify(run, null, 2)); }
export function updateRun(runId, fn) { const run = readRun(runId) ?? { runId }; fn(run); writeRun(run); return run; }

// ── The ledger ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Append one event. Only a lock holder or its participants write, so lines never interleave. */
export function ledgerAppend(entry) {
  fs.appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
}
export function ledgerRead() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { event: "unreadable", line: l.slice(0, 200) }; } });
}
/**
 * The fixtures a run started to create, or created, and has not torn down, in order, keyed by slug. "intent" is
 * written before the database insert, so a crash between the insert and the "created" line still leaves the exact
 * slug on record (tenantId is then null and teardown finds the tenant by that exact slug, never by a prefix).
 */
export function openFixtures(runId) {
  const open = new Map();
  for (const e of ledgerRead()) {
    if (e.runId !== runId || !e.slug) continue;
    if (e.event === "intent") open.set(e.slug, { ...e, tenantId: null });
    if (e.event === "created") open.set(e.slug, e);
    if (e.event === "torn-down") open.delete(e.slug);
  }
  return [...open.values()];
}
/** Every slug a run has ever put on record (for numbering the next fixture). */
export const ledgerSlugs = (runId) => [...new Set(ledgerRead().filter((e) => e.runId === runId && e.slug).map((e) => e.slug))];

// ── The lock ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const readLock = () => readJson(LOCK);

function legacyHolder() {
  const pid = Number(fs.existsSync(`${LEGACY_LOCK}/pid`) ? fs.readFileSync(`${LEGACY_LOCK}/pid`, "utf8").trim() : 0);
  return pid && alive(pid) ? pid : null;
}

/** "live" | "stale-gone" | "stale-reused" | "unknown" for a lock record. */
export function holderState(rec) {
  const who = identity(rec);
  return who === "same" ? "live" : who === "unknown" ? "unknown" : `stale-${who}`;
}

function withReclaimMutex(fn) {
  for (let i = 0; i < 100; i++) {
    try { fs.mkdirSync(RECLAIM); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A mutex older than 60 s belongs to a reclaimer that died mid-way (it only ever holds it for milliseconds).
      try { if (Date.now() - fs.statSync(RECLAIM).mtimeMs > 60000) fs.rmSync(RECLAIM, { recursive: true, force: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      if (i === 99) throw new Error("BLOCKED: the lock-reclaim mutex stayed busy for 10 s");
    }
  }
  try { return fn(); } finally { fs.rmSync(RECLAIM, { recursive: true, force: true }); }
}

/** Remove the lock only if it is still exactly `expected` (compare-and-delete). */
function deleteIfSame(expected, moveTo) {
  return withReclaimMutex(() => {
    const now = readLock();
    if (!now || now.runId !== expected.runId || now.pid !== expected.pid || now.start !== expected.start) return false;
    if (moveTo) { fs.mkdirSync(path.dirname(moveTo), { recursive: true }); fs.renameSync(LOCK, moveTo); } else fs.rmSync(LOCK);
    return true;
  });
}

/**
 * Take the lock for `runId`. Returns { acquired: true, lock } or { acquired: false, holder, state }.
 * A stale lock is reclaimed (compare-and-delete) and the attempt repeated; the stale run is recovered afterwards by
 * recoverOrphans(), under the new lock.
 */
export function acquireLock({ runId, kind, cmd }) {
  const legacy = legacyHolder();
  if (legacy) return { acquired: false, holder: { runId: "(shell runner)", pid: legacy, kind: "legacy" }, state: "live" };
  const start = processStart(process.pid);
  if (!start) throw new Error("BLOCKED: cannot read this process's start time, so a lock could not be told apart from a reused pid");
  const me = { runId, kind, pid: process.pid, start, cmd, app: APP, host: os.hostname(), at: new Date().toISOString() };
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${LOCK}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeAtomic(tmp, JSON.stringify(me));
    try {
      fs.linkSync(tmp, LOCK);
      fs.rmSync(tmp, { force: true });
      return { acquired: true, lock: me };
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (e.code !== "EEXIST") throw e;
    }
    const held = readLock();
    if (!held) continue; // released between our link and our read
    const state = holderState(held);
    if (state === "live" || state === "unknown") return { acquired: false, holder: held, state };
    if (deleteIfSame(held, `${runDir(held.runId)}/lock.stale.${Date.now()}.json`)) {
      console.log(`[harness] stale lock of run ${held.runId} (pid ${held.pid}: ${state === "stale-reused" ? "pid now belongs to another process" : "process gone"}) reclaimed`);
    }
  }
  throw new Error("BLOCKED: could not take the journey lock after 5 attempts");
}

/** Release the lock if this process still holds it. */
export function releaseLock(lock) {
  if (!lock) return false;
  try { return deleteIfSame(lock); } catch { return false; }
}

/**
 * For a journey or fixture.mjs: join the run that started it (MF_LOCK_RUN), or take the lock for a hand-started
 * process. Refuses (exit 3) while another run holds the lock, and returns the run id whose fixture state to use.
 */
export function joinLock(cmd) {
  const lockRun = process.env.MF_LOCK_RUN;
  if (lockRun) {
    const held = readLock();
    if (!held || held.runId !== lockRun || holderState(held) !== "live") {
      console.error(`REFUSED: started for run ${lockRun}, which no longer holds the journey lock${held ? ` (held by run ${held.runId}, pid ${held.pid})` : ""}`);
      process.exit(3);
    }
    return { runId: process.env.MF_RUN_ID ?? lockRun, participant: true };
  }
  const runId = process.env.MF_RUN_ID ?? manualRunId();
  const got = acquireLock({ runId, kind: "direct", cmd });
  if (!got.acquired) {
    console.error(`REFUSED: run ${got.holder.runId} (pid ${got.holder.pid}, ${got.holder.kind}) holds the journey lock; started by hand, ${cmd} waits for it to finish`);
    process.exit(3);
  }
  const release = () => releaseLock(got.lock);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { release(); process.exit(130); });
  updateRun(runId, (r) => { r.kind = r.kind ?? "direct"; r.app = APP; r.lastDirect = { pid: process.pid, cmd, at: got.lock.at }; });
  recoverOrphans(runId);
  return { runId, participant: false, lock: got.lock };
}

// ── Recovery of runs whose holder is gone ─────────────────────────────────────────────────────────────────────────

/**
 * Called by every lock holder before it uses the test branch. For each unfinished, non-manual run other than `mine`
 * whose holder process is gone (or its pid reused): kill its recorded children that are still the same processes,
 * by tree; then tear down the fixtures the ledger says it created and did not tear down (fixture.mjs teardown, run
 * as that run's fixtures under our lock). Manual (hand) sessions are reported, never torn down by another run.
 */
export function recoverOrphans(mine) {
  const report = [];
  for (const id of fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []) {
    if (id === mine) continue;
    const run = readRun(id);
    if (!run) continue;
    const open = openFixtures(id);
    if (run.kind !== "run") {
      if (open.length) report.push({ runId: id, manual: true, openFixtures: open.map((f) => f.slug), action: "left for its own session" });
      continue;
    }
    const runningChildren = (run.children ?? []).filter((c) => !c.endedAt);
    // Finished (or already recovered) with nothing left open and no child unaccounted for: nothing to do.
    if ((run.endedAt || run.recoveredAt) && open.length === 0 && runningChildren.length === 0) continue;
    const holder = run.holder ?? null;
    if (holder && identity(holder) === "same") continue; // still running (cannot happen while we hold the lock)
    const killed = runningChildren.map((c) => killTree(c, `orphan of run ${id}`));
    // Recorded as handled, so a child that was not ours (reused pid) is not looked at again.
    updateRun(id, (r) => { for (const c of r.children ?? []) if (!c.endedAt) { c.endedAt = new Date().toISOString(); c.exit = "recovered"; } });
    const torn = open.map((f) => {
      const r = spawnSync(process.execPath, [`${HERE}/fixture.mjs`, "teardown"], {
        cwd: APP, encoding: "utf8", timeout: 300000, windowsHide: true,
        env: { ...process.env, MF_LOCK_RUN: mine, MF_RUN_ID: id, MF_RECOVERY: "1" },
      });
      return { slug: f.slug, exit: r.status, out: (r.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).pop() ?? (r.stderr ?? "").trim().slice(-200) };
    });
    const left = openFixtures(id);
    updateRun(id, (r) => { r.phase = left.length ? "recovery-incomplete" : "recovered"; r.recoveredBy = mine; r.recoveredAt = new Date().toISOString(); });
    report.push({ runId: id, killed, torn, stillOpen: left.map((f) => f.slug) });
  }
  for (const r of report) console.log(`[harness] recovery ${JSON.stringify(r)}`);
  return report;
}

// ── Children of a run ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Start a child process for run `runId` (holding the lock as `lockRun`), record it (pid + start time) before
 * waiting, and resolve with its exit code. Output goes to `logFile`.
 */
export function runChild(runId, role, file, args, { logFile, lockRun = runId, env = {}, timeoutMs = 3 * 3600_000 } = {}) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [file, ...args], {
      cwd: APP, stdio: ["ignore", out, out], windowsHide: true, detached: !WIN,
      env: { ...process.env, MF_LOCK_RUN: lockRun, MF_RUN_ID: runId, ...env },
    });
    const rec = { pid: child.pid, start: processStart(child.pid), role, file: path.basename(file), args, startedAt: new Date().toISOString() };
    updateRun(runId, (r) => { (r.children ??= []).push(rec); });
    const timer = setTimeout(() => killTree(rec, "timeout"), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      updateRun(runId, (r) => { const c = (r.children ?? []).find((x) => x.pid === rec.pid && x.start === rec.start); if (c) { c.endedAt = new Date().toISOString(); c.exit = code ?? signal; } });
      resolve({ code: code ?? (signal ? 128 : 1), signal, pid: rec.pid });
    });
  });
}

/**
 * Record a process the run did not start through runChild but must answer for — the app server and proxy that
 * server.mjs starts detached, or anything else that can outlive its parent — with its pid and start time.
 */
export function recordChild(runId, pid, role) {
  const rec = { pid, start: processStart(pid), role, startedAt: new Date().toISOString(), detached: true };
  if (!rec.start) return null;
  updateRun(runId, (r) => { (r.children ??= []).push(rec); });
  return rec;
}

/** Mark recorded children ended once they are known to be gone (e.g. after server.mjs stop). */
export function markEnded(runId, roles) {
  updateRun(runId, (r) => { for (const c of r.children ?? []) if (!c.endedAt && roles.includes(c.role) && identity(c) !== "same") { c.endedAt = new Date().toISOString(); c.exit = "stopped"; } });
}

/** Kill every recorded child of `runId` that is still running (same pid and start time), by tree. */
export function killChildren(runId, why) {
  const run = readRun(runId);
  const results = (run?.children ?? []).filter((c) => !c.endedAt).map((c) => ({ c, k: killTree(c, why) }));
  updateRun(runId, (r) => {
    for (const { c, k } of results) {
      const x = (r.children ?? []).find((y) => y.pid === c.pid && y.start === c.start);
      if (x && !x.endedAt) { x.endedAt = new Date().toISOString(); x.exit = k.killed ? `killed (${why})` : k.why; }
    }
  });
  return results.map(({ k }) => k);
}

// ── Manifest ──────────────────────────────────────────────────────────────────────────────────────────────────────

const sha256File = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const listFiles = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }) : [])
  .map((f) => String(f).replace(/\\/g, "/"))
  .filter((f) => re.test(f) && !f.split("/").some((p) => p.startsWith(".")))
  .sort();

/**
 * The run's manifest, written before the first journey: a sha256 of every harness file (both skills' scripts and
 * SKILL.md files, journeys included), the build under test (its commit stamp and the worktree HEAD) and the
 * migrations — the folders in the worktree and, when `appliedMigrations` is given, those applied on the test branch.
 */
export function writeManifest(runId, { appliedMigrations = null, journeys = [] } = {}) {
  const skills = path.resolve(HERE, "../..").replace(/\\/g, "/");
  const files = {};
  for (const skill of ["matflow-verify-browser", "matflow-verify-local"]) {
    for (const f of listFiles(`${skills}/${skill}`, /\.(mjs|md|sh)$/)) files[`${skill}/${f}`] = sha256File(`${skills}/${skill}/${f}`);
  }
  const git = (...a) => spawnSync("git", a, { cwd: APP, encoding: "utf8" }).stdout.trim();
  const harnessGit = (...a) => spawnSync("git", a, { cwd: skills, encoding: "utf8" }).stdout.trim();
  const manifest = {
    runId,
    writtenAt: new Date().toISOString(),
    harness: { dir: skills, commit: harnessGit("rev-parse", "HEAD") || null, dirty: !!harnessGit("status", "--porcelain", "--", "."), files },
    app: { dir: APP, head: git("rev-parse", "HEAD") || null, dirty: !!git("status", "--porcelain", "--", ".", ":(exclude).omc") },
    build: readJson(`${APP}/.next/matflow-verify-build.json`),
    migrations: {
      inWorktree: fs.existsSync(`${APP}/prisma/migrations`) ? fs.readdirSync(`${APP}/prisma/migrations`).filter((d) => /^\d/.test(d)).sort() : [],
      appliedOnTestBranch: appliedMigrations,
    },
    journeys,
  };
  writeAtomic(`${runDir(runId)}/manifest.json`, JSON.stringify(manifest, null, 2));
  return manifest;
}
