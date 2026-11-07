// The whole load test in one command (README.md). From the repo root of a worktree with no .env file:
//   node scripts/loadtest/run.mjs --child-branch --members 5000 --scenarios all
//   node scripts/loadtest/run.mjs --members 20 --clubs 2 --smoke --allow-shared-test-branch     (kit smoke run)
// Steps: guard -> migrate the child branch -> production build (if HEAD has none) -> seed -> next start on private
// ports behind a TLS proxy -> each k6 scenario, with pg_stat_activity sampled every 5 s -> S2 invariants, top
// statements, server-log scan -> stop the servers -> teardown -> dated report in docs/readiness/loadtest/.
// Exit: 0 every check passed; 1 the run completed but a target or check failed; 2 usage; 3 refused by the guard;
// 4 the kit itself failed (a step could not run).
import { guardTarget, checkSharedLimits, GuardRefusal, ALLOW_SHARED_FLAG, targetFlags } from "./guard.mjs";
import { parseFlags, newStamp, runDir, readJson, writeJson, serverEnv, node24, assertWorktree, VERIFY_DATA, LT_DATA, scrub, sleep, REPO_ROOT } from "./lib.mjs";
import { scanLogs, summariseActivity, s2Invariants, statementsFor } from "./monitor.mjs";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";

const ALL = ["s1", "s2", "s3", "s4", "s5"];
const FILES = { s1: "s1-signin-burst.js", s2: "s2-class-start.js", s3: "s3-browse-mix.js", s4: "s4-reports.js", s5: "s5-bot-flood.js" };
const SPEC = { members: "int", clubs: "int", scenarios: "str", smoke: "bool", seconds: "int", instances: "int", port: "int", keep: "bool", "history-weeks": "int", "s2-app-capacity": "int", "allow-shared-test-branch": "bool", "child-branch": "bool" };
const HERE = path.join(REPO_ROOT, "scripts/loadtest");
const WIN = process.platform === "win32";
const log = (s) => console.log(`[loadtest ${new Date().toISOString().slice(11, 19)}] ${s}`);

function k6Binary() {
  const candidates = [process.env.K6_BIN, "k6"];
  const local = `${LT_DATA}/k6`;
  if (fs.existsSync(local)) for (const v of fs.readdirSync(local).sort().reverse()) for (const sub of fs.readdirSync(`${local}/${v}`)) {
    const exe = `${local}/${v}/${sub}/${WIN ? "k6.exe" : "k6"}`;
    if (fs.existsSync(exe)) candidates.push(exe);
  }
  for (const c of candidates.filter(Boolean)) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return { bin: c, version: r.stdout.trim() };
  }
  throw new Error(`k6 not found: install it (https://grafana.com/docs/k6/latest/set-up/install-k6/), or set K6_BIN, or unzip the official release into ${local}/<version>/ (see README)`);
}

const listening = (port) => new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); }); s.on("error", () => resolve(false)); });
const kill = (pid) => { if (!pid) return; if (WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); else try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* gone */ } } };
const git = (...a) => spawnSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();

/** The localhost certificate the verification skill made (server.mjs), or a new one in the same place. */
function ensureCert() {
  const dir = `${VERIFY_DATA}/tls`, cert = `${dir}/cert.pem`, key = `${dir}/key.pem`;
  if (fs.existsSync(cert) && fs.existsSync(key) && new Date(new X509Certificate(fs.readFileSync(cert)).validTo) > new Date(Date.now() + 86400000)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const gitExec = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const bundled = gitExec ? path.resolve(gitExec, "../../../usr/bin/openssl.exe") : null;
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "825", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"];
  for (const bin of ["openssl", bundled].filter(Boolean)) if (spawnSync(bin, args, { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).status === 0) return dir;
  throw new Error("openssl not found (Git for Windows ships one): needed once for the localhost certificate");
}

/** Run a node script of this kit as a child (each re-checks the guard itself). */
function nodeScript(file, args, { capture = false } = {}) {
  const r = spawnSync(node24(), [path.join(HERE, file), ...args], { cwd: REPO_ROOT, encoding: "utf8", stdio: capture ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (capture) { process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? ""); }
  return r;
}

/** Prisma migrate against the target's owner role, with nothing else in the environment that names a database. */
function migrate(target) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG[A-Z]|MF_NODE24_REEXEC/i.test(k)) delete env[k];
  env.DATABASE_URL = target.ownerUrl;
  const args = target.shared ? ["migrate", "status"] : ["migrate", "deploy"];
  const r = spawnSync(node24(), ["node_modules/prisma/build/index.js", ...args], { cwd: REPO_ROOT, env, encoding: "utf8" });
  const out = scrub(`${r.stdout ?? ""}${r.stderr ?? ""}`).split(/\r?\n/).filter((l) => l.trim() && !/sslmode|libpq|SSL modes|verify-full|uselibpqcompat|prepare for this change|current behavior|weaker security|trace-warnings/.test(l));
  return { command: `prisma ${args.join(" ")}`, exit: r.status, tail: out.slice(-6) };
}

/** A production build of HEAD (server.mjs build: no database variable in its environment), unless one exists. */
function ensureBuild() {
  const stamp = readJson(`${REPO_ROOT}/.next/matflow-verify-build.json`);
  const head = git("rev-parse", "HEAD");
  const dirty = !!git("status", "--porcelain", "--", ".", ":(exclude).omc");
  if (stamp && stamp.commit === head && !stamp.dirty && !dirty && fs.existsSync(`${REPO_ROOT}/.next/BUILD_ID`)) return { commit: head, built: false };
  if (dirty) throw new Error("the worktree has uncommitted changes: commit them first, so the results belong to a commit");
  log("no production build of HEAD: building (server.mjs build; no database variable in its environment)");
  const r = spawnSync(node24(), [".claude/skills/matflow-verify-local/scripts/server.mjs", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`build failed (exit ${r.status})`);
  return { commit: head, built: true };
}

async function startServers(target, dir, { port, instances }) {
  const base = `https://localhost:${port}`;
  const ports = Array.from({ length: instances }, (_, i) => port + 1 + i);
  for (const p of [port, ...ports]) if (await listening(p)) throw new Error(`port ${p} is in use: pass --port <another>`);
  const env = serverEnv(target, base);
  const pids = [];
  for (const p of ports) {
    const out = fs.openSync(`${dir}/server-${p}.log`, "w");
    const child = spawn(node24(), ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(p)], { cwd: REPO_ROOT, env, stdio: ["ignore", out, out], detached: !WIN, windowsHide: true });
    child.unref();
    pids.push(child.pid);
  }
  const pout = fs.openSync(`${dir}/proxy.log`, "w");
  const proxy = spawn(node24(), [path.join(HERE, "proxy.mjs"), String(port), ensureCert(), ports.join(",")], { cwd: REPO_ROOT, stdio: ["ignore", pout, pout], detached: !WIN, windowsHide: true });
  proxy.unref();
  pids.push(proxy.pid);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const statuses = await Promise.all(ports.map((p) => fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(10000) }).then((r) => r.status, () => 0)));
    const viaProxy = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) }).then((r) => r.status, () => 0);
    if (statuses.every((s) => s === 200) && viaProxy === 200) return { base, pids, ports };
  }
  pids.forEach(kill);
  throw new Error(`servers not healthy within 180 s; see ${dir}/server-*.log`);
}

function runK6(k6, name, file, { base, dataFile, smoke, seconds, dir }) {
  const summary = `${dir}/${name}-summary.json`;
  fs.rmSync(summary, { force: true });
  // k6 hands scripts only the variables given with -e; nothing from this process's environment reaches __ENV.
  const vars = { BASE: base, DATA: dataFile, PROFILE: smoke ? "smoke" : "full", SMOKE_SECONDS: String(seconds), SUMMARY: summary };
  const env = { ...process.env, K6_NO_USAGE_REPORT: "true" };
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG[A-Z]/i.test(k)) delete env[k];
  const started = Date.now();
  const r = spawnSync(k6.bin, ["run", "--quiet", "--no-usage-report", ...Object.entries(vars).flatMap(([k, v]) => ["-e", `${k}=${v}`]), path.join(HERE, file)], { cwd: REPO_ROOT, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(`${dir}/k6-${name}.log`, `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  const result = readJson(summary);
  // k6 exits 99 when a threshold fails: the run itself completed.
  return { name, exit: r.status, seconds: Math.round((Date.now() - started) / 1000), executed: !!result, result, stdoutTail: (r.stdout ?? "").trim().split(/\r?\n/).slice(-14) };
}

const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
function scenarioRows(res) {
  const m = res.result?.metrics ?? {};
  const rows = [];
  for (const [k, v] of Object.entries(m)) if (v.type === "trend" && /^http_req_duration\{/.test(k) && v.values.count) rows.push(`| ${res.name} | \`${k.replace("http_req_duration", "")}\` | ${fmt(v.values.count)} | ${fmt(v.values.med)} | ${fmt(v.values["p(95)"])} | ${fmt(v.values["p(99)"])} | ${fmt(v.values.max)} |`);
  const all = m.http_req_duration?.values;
  if (all) rows.push(`| ${res.name} | all requests | ${fmt(all.count)} | ${fmt(all.med)} | ${fmt(all["p(95)"])} | ${fmt(all["p(99)"])} | ${fmt(all.max)} |`);
  return rows;
}

function report({ flags, target, stamp, commit, k6, results, invariants, logs, activity, statements, teardown, migration, verdict, smoke, startedAt }) {
  const date = new Date().toISOString().slice(0, 10);
  const file = `${REPO_ROOT}/docs/readiness/loadtest/${date}-${smoke ? "smoke" : "load"}-${flags.members}m-${stamp}.md`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const L = [];
  L.push(`# Load test ${smoke ? "smoke run" : "run"}: ${flags.members} members, ${flags.clubs} clubs (${date})`, "");
  L.push(`**Verdict: ${verdict.ok ? "PASS" : "FAIL"}.** ${smoke ? "Smoke profile: it proves the kit runs end to end; latency figures from a smoke run are not evidence about the target (tiny load, and the server ran wherever this machine is, not next to the database)." : "Full profile against the spec's target."}`, "");
  for (const r of verdict.reasons) L.push(`- ${r}`);
  L.push("", "## Run", "");
  L.push(`| | |`, `|---|---|`);
  L.push(`| Started / finished (UTC) | ${startedAt} / ${new Date().toISOString()} |`);
  L.push(`| Commit served | \`${commit}\` |`);
  L.push(`| Target | ${target.shared ? "SHARED test branch (" + ALLOW_SHARED_FLAG + ", smoke only)" : "Neon child branch of the test branch"} \`${target.host}\`; app role \`${target.appRole}\` |`);
  L.push(`| Migration | \`${migration.command}\` exit ${migration.exit} |`);
  L.push(`| Servers | ${flags.instances} × \`next start\` (pool of 5 each) behind the TLS proxy |`);
  L.push(`| k6 | ${k6.version} |`);
  L.push(`| Run stamp | \`${stamp}\` (all synthetic rows carried it) |`);
  L.push(`| Teardown | ${teardown}`, "");
  L.push("## Latency (ms) per scenario and request kind", "", "| Scenario | Requests | Count | p50 | p95 | p99 | Max |", "|---|---|---|---|---|---|---|");
  for (const res of results) L.push(...scenarioRows(res));
  L.push("", "## Thresholds, errors and outcomes", "");
  for (const res of results) {
    const m = res.result?.metrics ?? {};
    const failed = res.result?.thresholdsFailed ?? [];
    L.push(`### ${res.name} (k6 exit ${res.exit}, ${res.seconds} s)`, "");
    if (!res.executed) { L.push("Did not produce a summary: see the k6 log in the run folder.", ""); continue; }
    L.push(`- Unexpected errors: ${fmt((m.unexpected_errors?.values.rate ?? 0) * 100, 2)}% of ${fmt((m.unexpected_errors?.values.passes ?? 0) + (m.unexpected_errors?.values.fails ?? 0))}; intended 429s: ${fmt(m.rate_limited_429?.values.count ?? 0)}`);
    L.push(`- Thresholds failed: ${failed.length ? failed.map((f) => `\`${f}\``).join(", ") : "none"}`);
    const extra = { ...res.result }; for (const k of ["scenario", "profile", "stamp", "at", "thresholdsFailed", "metrics"]) delete extra[k];
    if (Object.keys(extra).length) L.push(`- Outcomes: \`${JSON.stringify(extra)}\``);
    L.push("");
  }
  if (invariants) {
    L.push("## S2 invariants (database, after S2)", "", "| Session | Capacity | Attended | Members recorded twice |", "|---|---|---|---|");
    for (const r of invariants) L.push(`| ${r.class_name} | ${r.capacity} | ${r.attended} | ${r.duplicated_members} |`);
    L.push("");
  }
  L.push("## Database", "", `pg_stat_activity, sampled every 5 s: \`${JSON.stringify(activity)}\``, "");
  if (statements?.top?.length) {
    L.push("Top statements by total time:", "", "| Calls | Total ms | Mean ms | Max ms | Statement |", "|---|---|---|---|---|");
    for (const s of statements.top) L.push(`| ${s.calls} | ${s.total_ms} | ${s.mean_ms} | ${s.max_ms} | \`${String(s.query).replace(/\|/g, "\\|").slice(0, 160)}\` |`);
  } else L.push(`Top statements: ${statements?.note ?? statements?.error ?? "not collected"}`);
  L.push("", "## Server logs", "", "| Pattern | Count |", "|---|---|");
  for (const [k, v] of Object.entries(logs)) L.push(`| ${k} | ${v.count} |`);
  L.push("", `Raw results (k6 summaries, logs, samples) stay outside git in \`${runDir(stamp)}\`.`, "");
  fs.writeFileSync(file, L.join("\n"));
  return file;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), SPEC);
  const smoke = !!flags.smoke;
  flags.members ??= smoke ? 20 : 1000;
  flags.clubs ??= smoke ? 2 : 10;
  flags.instances ??= smoke ? 1 : 4;
  flags.port ??= 4091;
  const seconds = flags.seconds ?? 10;
  const scenarios = (flags.scenarios ?? "all") === "all" ? ALL : flags.scenarios.split(",").map((s) => s.trim().toLowerCase().slice(0, 2));
  if (scenarios.some((s) => !ALL.includes(s))) throw new GuardRefusal(`--scenarios takes all or a list of ${ALL.join(",")}`);

  // 1. Guard (static + live lineage), and the shared branch only for a tiny smoke run.
  const target = await guardTarget({ allowShared: !!flags["allow-shared-test-branch"], childBranch: !!flags["child-branch"] });
  if (target.shared && !smoke) throw new GuardRefusal(`the shared test branch takes only --smoke runs`);
  checkSharedLimits({ shared: target.shared, members: flags.members, clubs: flags.clubs, secondsPerScenario: smoke ? seconds : 600, vus: smoke ? 20 : 5000 });
  assertWorktree();
  const startedAt = new Date().toISOString();
  log(`target ${target.shared ? "SHARED test branch (smoke)" : "child branch"} ${target.host}, same Neon project as the test branch, timeline ${target.lineage.timeline}`);
  const k6 = k6Binary();
  log(`k6: ${k6.version}`);

  // 2. Migrate the child (status only on the shared branch: other builders own its migrations).
  const migration = migrate(target);
  log(`${migration.command}: exit ${migration.exit}\n  ${migration.tail.join("\n  ")}`);
  if (migration.exit !== 0 && !target.shared) throw new Error("migration failed");

  // 3. Build.
  const build = ensureBuild();
  log(`build of ${build.commit.slice(0, 8)} ${build.built ? "made" : "present"}`);

  // 4. Seed.
  const stamp = newStamp();
  const dir = runDir(stamp);
  const shareFlag = targetFlags(target);
  log(`seeding stamp ${stamp}`);
  const seeded = nodeScript("seed.mjs", ["--members", String(flags.members), "--clubs", String(flags.clubs), "--stamp", stamp, ...(flags["history-weeks"] !== undefined ? ["--history-weeks", String(flags["history-weeks"])] : smoke ? ["--history-weeks", "2"] : []), ...(flags["s2-app-capacity"] !== undefined ? ["--s2-app-capacity", String(flags["s2-app-capacity"])] : []), ...shareFlag]);
  let servers = null, monitor = null, teardown = "not run", results = [], invariants = null, statements = null, kitError = null;
  try {
    if (seeded.status !== 0) throw new Error(`seed failed (exit ${seeded.status})`);
    const dataFile = `${dir}/k6-data.json`;
    const data = readJson(dataFile);

    // 5. Statements: reset so the top 20 belong to this run (child only).
    if (!target.shared) await statementsFor({ reset: true }, target).catch((e) => log(`statements reset failed: ${scrub(e.message)}`));

    // 6. Servers.
    servers = await startServers(target, dir, { port: flags.port, instances: flags.instances });
    log(`servers healthy: ${servers.base} -> ${servers.ports.join(",")}`);

    // 7. Monitor, then the scenarios.
    fs.rmSync(`${dir}/monitor.stop`, { force: true });
    monitor = spawn(node24(), [path.join(HERE, "monitor.mjs"), "sample", "--stamp", stamp, "--seconds", "14400", ...shareFlag], { cwd: REPO_ROOT, stdio: ["ignore", fs.openSync(`${dir}/monitor.log`, "w"), fs.openSync(`${dir}/monitor.log`, "a")], windowsHide: true });
    for (const s of scenarios) {
      log(`scenario ${FILES[s]}`);
      const res = runK6(k6, s, FILES[s], { base: servers.base, dataFile, smoke, seconds, dir });
      results.push(res);
      for (const line of res.stdoutTail) console.log(`  ${line}`);
      if (s === "s2") {
        const big = data.clubs[0].s2;
        invariants = await s2Invariants(target, [big.kiosk.instanceId, big.app.instanceId]);
        log(`S2 invariants: ${JSON.stringify(invariants.map((r) => ({ class: r.class_name, capacity: r.capacity, attended: r.attended, twice: r.duplicated_members })))}`);
      }
      await sleep(smoke ? 2000 : 30000);
    }
    statements = await statementsFor({}, target).catch((e) => ({ error: scrub(e.message) }));
    if (statements.top) writeJson(`${dir}/statements.json`, statements);
  } catch (e) {
    kitError = e;
    log(`KIT ERROR: ${scrub(e.message)}`);
  } finally {
    fs.writeFileSync(`${dir}/monitor.stop`, "stop");
    if (monitor) await new Promise((r) => { const t = setTimeout(() => { kill(monitor.pid); r(); }, 15000); monitor.on("exit", () => { clearTimeout(t); r(); }); });
    if (servers) servers.pids.forEach(kill);
    // 8. Teardown (unless --keep).
    if (flags.keep) teardown = `kept: node scripts/loadtest/seed.mjs --teardown --stamp ${stamp} ${shareFlag.join(" ")}`;
    else {
      const t = nodeScript("seed.mjs", ["--teardown", "--stamp", stamp, ...shareFlag], { capture: true });
      teardown = `${t.status === 0 ? "clean" : "INCOMPLETE"}: ${(t.stdout ?? "").trim().split(/\r?\n/).filter((l) => /TORN DOWN|TEARDOWN/.test(l)).join(" ") || `exit ${t.status}`}`;
    }
  }

  // 9. Evidence and verdict.
  const logs = scanLogs(fs.readdirSync(dir).filter((f) => /^server-\d+\.log$/.test(f)).map((f) => fs.readFileSync(`${dir}/${f}`, "utf8")));
  const samples = fs.existsSync(`${dir}/activity.jsonl`) ? fs.readFileSync(`${dir}/activity.jsonl`, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const activity = summariseActivity(samples);
  const reasons = [];
  if (kitError) reasons.push(`KIT: ${scrub(kitError.message)}`);
  for (const s of scenarios) { const r = results.find((x) => x.name === s); if (!r || !r.executed) reasons.push(`${s} did not execute`); }
  if (!/^clean/.test(teardown) && !flags.keep) reasons.push(`teardown ${teardown}`);
  for (const [k, v] of Object.entries(logs)) if (v.count) reasons.push(`server logs: ${v.count} × ${k}`);
  for (const r of invariants ?? []) {
    if (r.capacity !== null && r.attended > r.capacity) reasons.push(`S2 OVER CAPACITY: ${r.class_name} ${r.attended} > ${r.capacity}`);
    if (r.duplicated_members) reasons.push(`S2 DUPLICATES: ${r.class_name} has ${r.duplicated_members} members recorded twice`);
  }
  const s2 = results.find((r) => r.name === "s2")?.result?.checkins;
  if (s2 && invariants) { const rows = invariants.reduce((a, r) => a + r.attended, 0); if (rows !== s2.ok) reasons.push(`S2: k6 saw ${s2.ok} successful check-ins but the database holds ${rows}`); }
  for (const r of results.filter((x) => x.executed)) {
    const m = r.result.metrics;
    const err = m.unexpected_errors?.values;
    if (smoke) {
      // A smoke run proves the kit: every request answered as expected; latency is not judged.
      if (err && err.passes > 0) reasons.push(`${r.name}: ${err.passes} unexpected responses (see k6-${r.name}.log)`);
      if (r.name === "s1" && (r.result.signinFailed || !r.result.signedIn)) reasons.push(`s1: ${r.result.signedIn} sign-ins succeeded, ${r.result.signinFailed} failed`);
      if (r.name === "s2" && r.result.checkins && (r.result.checkins.ok === 0 || r.result.checkins.refusedOther)) reasons.push(`s2: check-in outcomes ${JSON.stringify(r.result.checkins)}`);
    } else {
      for (const f of r.result.thresholdsFailed) reasons.push(`${r.name}: threshold ${f}`);
      if (r.name === "s5" && r.result.twoTimesBaseline !== "PASS") reasons.push(`s5: real-user p95 under the flood is ${fmt(r.result.floodToBaselineRatio, 2)}× the baseline (target ≤ 2×)`);
    }
  }
  const verdict = { ok: reasons.length === 0, reasons: reasons.length ? reasons : [smoke ? "Every scenario ran, every response was an expected one, S2 kept capacity with no duplicates, the logs are clean and the teardown left zero rows." : "Every target in the spec was met."] };
  const commit = git("rev-parse", "HEAD");
  const file = report({ flags, target, stamp, commit, k6, results, invariants, logs, activity, statements, teardown, migration, verdict, smoke, startedAt });
  log(`report: ${path.relative(REPO_ROOT, file).replace(/\\/g, "/")}`);
  log(`VERDICT ${verdict.ok ? "PASS" : "FAIL"}${verdict.ok ? "" : ":\n  - " + verdict.reasons.join("\n  - ")}`);
  return kitError ? 4 : verdict.ok ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => {
  console.error(e instanceof GuardRefusal ? e.message : `run failed: ${scrub(e.stack ?? e.message)}`);
  process.exit(e instanceof GuardRefusal ? 3 : 4);
});
