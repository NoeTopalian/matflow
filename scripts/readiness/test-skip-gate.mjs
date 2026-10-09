// Test-harness false-assurance gate (security campaign 9 Oct 2026, lane F, SEC-088).
//
//   npx vitest run <files…> --reporter=json --outputFile=vitest.json
//   node scripts/readiness/test-skip-gate.mjs vitest.json [--allow=path1,path2] [--require-db]
//
// A green vitest exit code is not evidence that the security suite RAN. 56 DB-backed files (421 tests) self-skip
// with `describe.skipIf(!DATABASE_URL)`; with the production URL stripped by tests/setup-test-db.ts they all report
// "skipped" and `npm test` can still exit 0 (lane F measured this on 9 Oct 2026). This gate reads vitest's JSON and
// FAILS (exit 1) when:
//   - any test failed, or a file failed to load (suite-level error);
//   - any file reports zero tests (a file that defines nothing passes vacuously);
//   - with --require-db (CI, or any run that claims DB evidence): any test is skipped/todo outside the --allow list.
// Allowed skips must be named one by one with a reason in the CI step that passes them; a pattern is not accepted.
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) { console.error("usage: test-skip-gate.mjs <vitest.json> [--allow=a,b] [--require-db]"); process.exit(2); }
const args = process.argv.slice(3);
const requireDb = args.includes("--require-db");
const allow = new Set((args.find((a) => a.startsWith("--allow=")) ?? "--allow=").slice(8).split(",").filter(Boolean));
// --expect=<glob[,glob]>: every file matching the globs MUST be present in the results. A run that simply leaves
// the database files out is otherwise indistinguishable from one that ran them (review of lane F, 9 Oct 2026).
const expectGlobs = (args.find((a) => a.startsWith("--expect=")) ?? "--expect=").slice(9).split(",").filter(Boolean);
const expected = new Set(expectGlobs.flatMap((g) => fs.globSync(g).map((p) => p.split(path.sep).join("/"))));
const j = JSON.parse(fs.readFileSync(file, "utf8"));
const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join("/");

const problems = [];
let total = 0, passed = 0, skipped = 0;
for (const f of j.testResults ?? []) {
  const name = rel(f.name);
  const a = f.assertionResults ?? [];
  total += a.length;
  const p = a.filter((x) => x.status === "passed").length;
  const fl = a.filter((x) => x.status === "failed").length;
  const sk = a.filter((x) => ["skipped", "pending", "todo"].includes(x.status)).length;
  passed += p; skipped += sk;
  if (f.status === "failed" && fl === 0) problems.push(`${name}: file failed to run (${String(f.message ?? "").slice(0, 160).replace(/\s+/g, " ")})`);
  if (fl > 0) problems.push(`${name}: ${fl} failed`);
  if (a.length === 0) problems.push(`${name}: zero tests`);
  if (requireDb && sk > 0 && !allow.has(name)) problems.push(`${name}: ${sk} of ${a.length} skipped (not on the allow list)`);
}
const present = new Set((j.testResults ?? []).map((f) => rel(f.name)));
for (const e of expected) if (!present.has(e)) problems.push(`${e}: expected in this run but absent`);
console.log(JSON.stringify({ files: (j.testResults ?? []).length, total, passed, skipped, requireDb, allowed: [...allow], expected: expected.size, verdict: problems.length ? "FAIL" : "PASS" }));
for (const p of problems) console.log(" -", p);
process.exit(problems.length ? 1 : 0);
