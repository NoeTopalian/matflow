// Runs integration test files against a guarded database, first as the owner role, then as the restricted runtime
// role matflow_app. Default target: the Neon TEST branch (URLs from .env.test). MF_DB_TARGET=isolated: a database on
// localhost (env.mjs dbTargets). URLs are never printed.
//   node db-tests.mjs tests/integration/<file>.test.ts [more files]      (from the worktree root)
//   node db-tests.mjs --each <files…>          one Vitest run per file: a slow file cannot void the others, and each
//                                              file's duration is reported
//   node db-tests.mjs --list <file.txt> …      read the file names (one per line) from a text file; implies nothing else
//   node db-tests.mjs --diagnostic-test-timeout=<ms> …   raise Vitest's DEFAULT per-test limit. A diagnostic for a
//                                              slow link only: every line is marked DIAGNOSTIC and the run exits 3,
//                                              so it can never be read as a release result.
// Before each role's run the connected role and the effective row-level security are read from Postgres
// (tests/db-role-guard.mjs) and the run is refused if they are not what the pass claims.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { APP, OUT, dbTargets, assertWorktree, node24 } from "./env.mjs";

const args = process.argv.slice(2);
const each = args.includes("--each");
const diag = args.find((a) => a.startsWith("--diagnostic-test-timeout="));
const diagMs = diag ? Number(diag.split("=")[1]) : 0;
if (diag && !(diagMs > 0)) { console.log("--diagnostic-test-timeout needs a number of milliseconds"); process.exit(2); }
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--list") files.push(...fs.readFileSync(args[++i], "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
  else if (!args[i].startsWith("--")) files.push(args[i]);
}
if (!files.length) { console.log("usage: node db-tests.mjs [--each] [--list files.txt] tests/integration/<file>.test.ts …"); process.exit(2); }
assertWorktree();
const targets = dbTargets();
const { readDbRole, rlsGaps, describeDbRole } = await import(pathToFileURL(`${APP}/tests/db-role-guard.mjs`).href);
// One spawn's cap. A killed spawn is "no result", never a pass; raise MF_DB_SPAWN_TIMEOUT_MS for a slow link.
const spawnCap = Number(process.env.MF_DB_SPAWN_TIMEOUT_MS ?? 600000);
const failDir = path.join(OUT, "db-fail");
const tag = diagMs ? `DIAGNOSTIC(testTimeout=${diagMs}) ` : "";
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: APP, encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: APP, encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
console.log(`${tag}target ${targets.kind}; commit ${head}; ${dirty} uncommitted path(s); ${files.length} file(s); ${each ? "one run per file" : "one run per role"}; spawn cap ${spawnCap} ms`);

let failed = 0;
for (const role of ["owner", "restricted"]) {
  const url = targets[role];
  // Facts first. The owner pass must NOT be bound by RLS (its suites expect to see across tenants); the restricted
  // pass MUST be: matflow_app, no superuser, no BYPASSRLS, RLS tables present, nothing visible without a tenant.
  const facts = await readDbRole(url);
  const gaps = rlsGaps(facts);
  console.log(`== ${tag}${role}: ${describeDbRole(facts)}`);
  if (role === "owner" && !(facts.superuser || facts.bypassRls)) { console.log(`REFUSED: the owner pass is connected as "${facts.currentUser}", which RLS binds`); process.exit(1); }
  if (role === "restricted" && (facts.currentUser !== "matflow_app" || gaps.length)) {
    console.log(`REFUSED: the restricted pass must be matflow_app with RLS in force (${facts.currentUser}; ${gaps.join("; ") || "wrong role"})`);
    process.exit(1);
  }
  // The restricted pass sets RLS_ENFORCED=1, as scripts/test-rls-enforced.mjs does; the Vitest global setup then
  // checks the same facts again inside the run, so no runner can leave the flag out unnoticed.
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  if (role === "restricted") env.RLS_ENFORCED = "1"; else delete env.RLS_ENFORCED;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.MIGRATION_DATABASE_URL;
  for (const group of each ? files.map((f) => [f]) : [files]) {
    const t0 = Date.now();
    const r = spawnSync(node24(), ["node_modules/vitest/vitest.mjs", "run", ...group, ...(diagMs ? [`--testTimeout=${diagMs}`] : [])], { cwd: APP, env, encoding: "utf8", timeout: spawnCap, maxBuffer: 256 * 1024 * 1024 });
    const secs = Math.round((Date.now() - t0) / 1000);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>").replace(/\x1b\[[0-9;]*m/g, "");
    const status = r.status === null ? `KILLED at the ${spawnCap} ms spawn cap (no result)` : `exit ${r.status}`;
    if (each) {
      const tests = (out.match(/^\s*Tests\s+(.*)$/m) ?? [])[1]?.trim() ?? "no summary";
      console.log(`${tag}${role.padEnd(10)} ${status} ${String(secs).padStart(4)}s ${group[0]} | ${tests}`);
      for (const l of out.split(/\r?\n/).filter((l) => /^\s*×\s/.test(l)).slice(0, 12)) console.log(`    ${l.trim()}`);
    } else {
      const lines = out.split(/\r?\n/).filter((l) => /✓|×|↓|Tests |Test Files|FAIL|Error/.test(l) && !/sslmode|libpq|SSL modes/.test(l));
      console.log(`${tag}${role} ${status} ${secs}s`);
      console.log(lines.slice(-40).join("\n"));
    }
    if (r.status !== 0) {
      failed++;
      fs.mkdirSync(failDir, { recursive: true });
      const name = `${role}-${each ? path.basename(group[0]) : "batch"}${diagMs ? ".diagnostic" : ""}.log`;
      fs.writeFileSync(path.join(failDir, name), out);
    }
  }
}
if (failed) console.log(`${tag}${failed} run(s) did not pass; full output in ${failDir}`);
process.exit(diagMs ? 3 : failed ? 1 : 0);
