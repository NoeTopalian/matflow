// Test-harness false-assurance gate (security campaign 9 Oct 2026, lane F, SEC-088; iteration 2 lane F2).
//
//   npx vitest run <files…> --reporter=json --outputFile=vitest.json
//   node scripts/readiness/test-skip-gate.mjs vitest.json [--allow=path1,path2] [--require-db] [--expect=<glob[,glob]>]
//        [--allow-blocked]
//
// A green vitest exit code is not evidence that the security suite RAN. DB-backed files self-skip with
// `describe.skipIf(!DATABASE_URL)`; with the production URL stripped by tests/setup-test-db.ts they all report
// "skipped" and `npm test` can still exit 0 (lane F measured this on 9 Oct 2026). And a throwing beforeAll (database
// unreachable) is reported by vitest as a FAILED FILE whose tests are all "skipped" — a per-test count shows zero
// failures (the 9 Oct final sweep recorded tenant-restore-purge-race under matflow_app as "1 failed, 5 skipped" next
// to exit=0, because its script read the exit status of a command substitution). This gate reads vitest's JSON and
// FAILS (exit 1) when:
//   - the report is empty, or vitest itself reported success:false (failed suite, unhandled error, setup failure);
//   - any test failed, or any FILE failed — including a file whose tests all report "skipped" (a setup failure is
//     named as such and is never green, with or without --require-db);
//   - any file reports zero tests (a file that defines nothing passes vacuously);
//   - with --require-db (CI, or any run that claims DB evidence): any test is skipped/todo outside the --allow list;
//   - with --expect=<glob>: any matching file is absent from the run (a run that leaves the DB files out is otherwise
//     indistinguishable from one that ran them — review of lane F); and a glob that matches NO file fails, naming the
//     glob and the cwd (it used to report "expected 0, PASS" — review R2, fixed in lane E3).
// Allowed skips must be named one by one with a reason in the CI step that passes them; a pattern is not accepted.
//
// Two registries below are part of the gate (iteration 2):
//   MAINTENANCE — files that are tools, not security checks. Excluded from --expect, and their skips are allowed
//     (they skip unless explicitly enabled). Each entry carries the reason.
//   BLOCKED — required checks that cannot execute until a named prerequisite exists. Their skips are NOT allowed
//     by default: the gate FAILS and names the blocker. --allow-blocked lets the run pass with verdict
//     "PASS-WITH-BLOCKED-COVERAGE" and the blocked list printed — the coverage gap stays visible and is never
//     reported as a plain PASS.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @type {Record<string, string>} */
export const MAINTENANCE = {
  "tests/integration/sec-b-fixture-sweep-db.test.ts":
    "maintenance tool: deletes abandoned secb- fixtures when SEC_B_SWEEP=1; it asserts only that its own deletions completed, no security property (lane F2 decision, 9 Oct 2026)",
};
/** @type {Record<string, string>} */
export const BLOCKED = {
  "tests/integration/sec-f2-auditlog-append-only-db.test.ts":
    "SF-57: the append-only AuditLog migration is not applied (adoption refused to the lead 9 Oct 2026; Noe decides). Remove this entry when it is applied.",
};

/**
 * Pure evaluation (unit-tested in tests/unit/sec-f2-skip-gate.test.ts). `present` paths are repo-relative.
 * @param {any} j vitest JSON report
 * @param {{ allow?: string[], requireDb?: boolean, expected?: Iterable<string>, allowBlocked?: boolean, unmatchedGlobs?: string[], cwd?: string }} [opts]
 * @param {(p: string) => string} [rel]
 */
export function evaluate(j, { allow = [], requireDb = false, expected = [], allowBlocked = false, unmatchedGlobs = [], cwd = "" } = {}, rel = (p) => p) {
  const allowSet = new Set(allow);
  const problems = [];
  // Lane E3 (review R2): a glob that matches nothing used to give "expected 0, PASS" — a typo or a wrong cwd silently
  // switched the check off. Every --expect glob must match at least one file.
  for (const g of unmatchedGlobs) problems.push(`--expect glob "${g}" matched no file under ${cwd || "the current directory"}`);
  const blocked = [];
  let total = 0, passed = 0, skipped = 0, failed = 0;
  const files = j.testResults ?? [];
  if (files.length === 0) problems.push("the report contains no test files");
  for (const f of files) {
    const name = rel(f.name);
    const a = f.assertionResults ?? [];
    total += a.length;
    const p = a.filter((x) => x.status === "passed").length;
    const fl = a.filter((x) => x.status === "failed").length;
    const sk = a.filter((x) => ["skipped", "pending", "todo"].includes(x.status)).length;
    passed += p; skipped += sk; failed += fl;
    const msg = String(f.message ?? "").slice(0, 160).replace(/\s+/g, " ");
    if (f.status === "failed" && fl === 0) {
      problems.push(sk > 0 && sk === a.length
        ? `${name}: SETUP FAILURE — file failed and all ${sk} tests were reported skipped (${msg})`
        : `${name}: file failed to run (${msg})`);
    }
    if (fl > 0) problems.push(`${name}: ${fl} failed`);
    if (a.length === 0) problems.push(`${name}: zero tests`);
    if (requireDb && sk > 0 && f.status !== "failed") {
      if (MAINTENANCE[name] || allowSet.has(name)) continue;
      if (BLOCKED[name]) {
        blocked.push(`${name}: ${sk} of ${a.length} skipped — BLOCKED: ${BLOCKED[name]}`);
        if (!allowBlocked) problems.push(`${name}: ${sk} of ${a.length} skipped — BLOCKED coverage (pass --allow-blocked to record it as such): ${BLOCKED[name]}`);
        continue;
      }
      problems.push(`${name}: ${sk} of ${a.length} skipped (not on the allow list)`);
    }
  }
  if (j.success === false && problems.length === 0) problems.push("vitest reported success:false (unhandled error or failed suite outside any file)");
  const present = new Set(files.map((f) => rel(f.name)));
  const exp = [...expected].filter((e) => !MAINTENANCE[e]);
  for (const e of exp) if (!present.has(e)) problems.push(`${e}: expected in this run but absent`);
  const verdict = problems.length ? "FAIL" : blocked.length ? "PASS-WITH-BLOCKED-COVERAGE" : "PASS";
  return { summary: { files: files.length, total, passed, failed, skipped, requireDb, allowed: [...allowSet], expected: exp.length, blocked: blocked.length, verdict }, problems, blocked };
}

/**
 * Expand --expect globs relative to `cwd`. Returns the matched repo-relative paths and every glob that matched nothing.
 * @param {string[]} globs @param {string} cwd
 */
export function expandExpect(globs, cwd) {
  const expected = new Set();
  const unmatched = [];
  for (const g of globs) {
    const hits = fs.globSync(g, { cwd }).map((p) => p.split(path.sep).join("/"));
    if (hits.length === 0) unmatched.push(g);
    for (const h of hits) expected.add(h);
  }
  return { expected, unmatched };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: test-skip-gate.mjs <vitest.json> [--allow=a,b] [--require-db] [--expect=<glob>] [--allow-blocked]"); process.exit(2); }
  const args = process.argv.slice(3);
  const allow = (args.find((a) => a.startsWith("--allow=")) ?? "--allow=").slice(8).split(",").filter(Boolean);
  const expectGlobs = (args.find((a) => a.startsWith("--expect=")) ?? "--expect=").slice(9).split(",").filter(Boolean);
  const cwd = process.cwd();
  const { expected, unmatched } = expandExpect(expectGlobs, cwd);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const rel = (p) => path.relative(cwd, p).split(path.sep).join("/");
  const r = evaluate(j, { allow, requireDb: args.includes("--require-db"), expected, allowBlocked: args.includes("--allow-blocked"), unmatchedGlobs: unmatched, cwd }, rel);
  console.log(JSON.stringify(r.summary));
  for (const b of r.blocked) console.log(" ~", b);
  for (const p of r.problems) console.log(" -", p);
  process.exit(r.problems.length ? 1 : 0);
}
