// Database and log monitoring for the load test (queries in collect.sql). Guarded like every load-test script.
//   node scripts/loadtest/monitor.mjs sample --stamp <s> [--seconds N]     pg_stat_activity every 5 s into
//                                                                          <run dir>/activity.jsonl until N s pass
//                                                                          or <run dir>/monitor.stop appears
//   node scripts/loadtest/monitor.mjs statements --stamp <s> [--reset]     top 20 pg_stat_statements into
//                                                                          <run dir>/statements.json (child only:
//                                                                          creates the extension if missing)
//   node scripts/loadtest/monitor.mjs logs <file> [file …]                 counts pool timeouts, P2028, 55P03, 57014
//                                                                          and "revocation check failed" in logs
//   add --child-branch (the throwaway child) or --allow-shared-test-branch (no extension is created there)
import { guardTarget, pgConnect, GuardRefusal } from "./guard.mjs";
import { parseFlags, runDir, writeJson, scrub, sleep, STAMP_RE } from "./lib.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "collect.sql");

/** collect.sql split into its named sections. */
export function sqlSections(text = fs.readFileSync(SQL_FILE, "utf8")) {
  const out = {};
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^-- name:\s*(\S+)/);
    if (m) { name = m[1]; out[name] = ""; continue; }
    if (name && !line.startsWith("--")) out[name] += `${line}\n`;
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim().replace(/;$/, "");
  return out;
}

/** What the server logs must never show under load. Each pattern is counted separately. */
export const LOG_PATTERNS = {
  poolTimeout: /timeout exceeded when trying to connect|Timed out fetching a new connection from the connection pool|connection timeout|Connection terminated due to connection timeout/i,
  P2028: /P2028/,
  lockNotAvailable55P03: /55P03/,
  statementTimeout57014: /57014|canceling statement due to statement timeout/i,
  revocationCheckFailed: /revocation check failed/i,
};

/** Counts per pattern over the given log texts, with up to 3 example lines each (scrubbed). */
export function scanLogs(texts) {
  const result = {};
  for (const k of Object.keys(LOG_PATTERNS)) result[k] = { count: 0, examples: [] };
  for (const text of texts) for (const line of text.split(/\r?\n/)) for (const [k, re] of Object.entries(LOG_PATTERNS)) {
    if (re.test(line)) { result[k].count++; if (result[k].examples.length < 3) result[k].examples.push(scrub(line).slice(0, 300)); }
  }
  return result;
}

/** Peak figures from the activity samples. */
export function summariseActivity(samples) {
  let peakTotal = 0, peakBusy = 0, peakLockWaits = 0, oldestXact = 0;
  const waits = {};
  for (const s of samples) {
    peakTotal = Math.max(peakTotal, s.oldest?.total ?? 0);
    peakBusy = Math.max(peakBusy, s.oldest?.busy ?? 0);
    peakLockWaits = Math.max(peakLockWaits, s.oldest?.waiting_on_locks ?? 0);
    oldestXact = Math.max(oldestXact, s.oldest?.oldest_xact_s ?? 0);
    for (const r of s.activity ?? []) if (r.state && r.state !== "idle" && r.wait_event !== "-") {
      const key = `${r.wait_event_type}/${r.wait_event}`;
      waits[key] = Math.max(waits[key] ?? 0, r.n);
    }
  }
  const topWaits = Object.entries(waits).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([wait, peak]) => ({ wait, peak }));
  return { samples: samples.length, peakSessions: peakTotal, peakBusy, peakLockWaits, oldestTransactionSeconds: Math.round(oldestXact * 10) / 10, topWaits };
}

async function sample(flags, target) {
  const dir = runDir(flags.stamp);
  const file = `${dir}/activity.jsonl`, stop = `${dir}/monitor.stop`;
  const q = sqlSections();
  const until = Date.now() + (flags.seconds ?? 3600) * 1000;
  const c = await pgConnect(target.ownerUrl);
  try {
    while (Date.now() < until && !fs.existsSync(stop)) {
      const at = new Date().toISOString();
      try {
        const activity = (await c.query(q.activity)).rows;
        const oldest = (await c.query(q.oldest)).rows[0];
        fs.appendFileSync(file, JSON.stringify({ at, activity, oldest }) + "\n");
      } catch (e) { fs.appendFileSync(file, JSON.stringify({ at, error: scrub(e.message) }) + "\n"); }
      await sleep(5000);
    }
  } finally { await c.end(); }
}

async function statements(flags, target) {
  const q = sqlSections();
  const c = await pgConnect(target.ownerUrl);
  try {
    let installed = (await c.query(q.statements_available)).rows[0].installed;
    if (!installed && !target.shared) { await c.query(q.statements_prepare); installed = true; }
    if (!installed) return { installed: false, note: "pg_stat_statements is not installed on the shared test branch and is not created there" };
    if (flags.reset) { await c.query(q.statements_reset); return { installed: true, reset: true }; }
    const top = (await c.query(q.top_statements)).rows.map((r) => ({ ...r, query: scrub(r.query) }));
    return { installed: true, top };
  } finally { await c.end(); }
}

/** S2 invariants for the given instance ids. */
export async function s2Invariants(target, instanceIds) {
  const c = await pgConnect(target.ownerUrl);
  try { return (await c.query(sqlSections().s2_invariants, [instanceIds])).rows; } finally { await c.end(); }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/loadtest/monitor.mjs");
if (isMain) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === "logs") {
      console.log(JSON.stringify(scanLogs(rest.map((f) => fs.readFileSync(f, "utf8"))), null, 2));
    } else if (cmd === "sample" || cmd === "statements") {
      const flags = parseFlags(rest, { stamp: "str", seconds: "int", reset: "bool", "allow-shared-test-branch": "bool", "child-branch": "bool" });
      if (!STAMP_RE.test(flags.stamp ?? "")) throw new GuardRefusal("--stamp <the run's stamp> is required");
      const target = await guardTarget({ allowShared: !!flags["allow-shared-test-branch"], childBranch: !!flags["child-branch"] });
      if (cmd === "sample") await sample(flags, target);
      else { const r = await statements(flags, target); if (r.top) writeJson(`${runDir(flags.stamp)}/statements.json`, r); console.log(JSON.stringify({ ...r, top: r.top ? `${r.top.length} statements written` : undefined })); }
    } else {
      console.log("usage: node scripts/loadtest/monitor.mjs sample|statements --stamp <s> [--seconds N] [--reset] | logs <file> …");
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof GuardRefusal ? e.message : `monitor failed: ${scrub(e.message)}`);
    process.exit(e instanceof GuardRefusal ? 3 : 1);
  }
}
export { statements as statementsFor };
