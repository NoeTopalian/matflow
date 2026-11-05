// How long does the Activity feed's query take on a year of rows?
//
//   node scripts/perf/activity-feed-explain.mjs            (from a worktree without .env; Neon TEST branch only)
//   ROWS=20000 node scripts/perf/activity-feed-explain.mjs  (a quicker, smaller run)
//
// Seeds two synthetic clubs (slug mfv-perf-…) with ROWS audit rows each (default 200,000) spread over 365 days,
// runs GET /api/activity for each scenario, replays the SQL Prisma actually sent under EXPLAIN (ANALYZE, BUFFERS),
// prints one line per scenario and tears both clubs down to nothing. Pass line: every scenario's execution time
// at or under 300 ms. Exit 1 when any is over, 0 otherwise.
//
// Refuses production: the database URL comes from .env.test in the main checkout and must be the test branch
// (the guards are the verification skill's — .claude/skills/matflow-verify-local/scripts/env.mjs). The URL is never
// printed. Runs as the restricted runtime role (matflow_app) with row-level security enforced, as production does;
// ROLE=owner runs it as the owner role instead.
//
// The work itself is activity-feed-explain.perf.ts beside this file: it has to import the application's own query
// builder, so it runs under vitest with a config of its own (it is not part of `npm test`).
import { spawnSync } from "node:child_process";
import { APP, testEnv, assertTestUrl, assertWorktree, node24 } from "../../.claude/skills/matflow-verify-local/scripts/env.mjs";

assertWorktree();
const t = testEnv();
const role = process.env.ROLE === "owner" ? "owner" : "restricted";
const url = role === "owner" ? assertTestUrl(t.TEST_DATABASE_URL, "TEST_DATABASE_URL") : assertTestUrl(t.RESTRICTED_DATABASE_URL, "RESTRICTED_DATABASE_URL");
// The owner connection is used for one statement only: ANALYZE after seeding, which the restricted role may not run.
const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, PERF_ANALYZE_URL: assertTestUrl(t.TEST_DATABASE_URL, "TEST_DATABASE_URL"), ACTIVITY_PERF: "1", ...(role === "restricted" ? { RLS_ENFORCED: "1" } : {}) };
delete env.NODE_TLS_REJECT_UNAUTHORIZED;
delete env.MIGRATION_DATABASE_URL;

console.log(`[activity-perf] role ${role} (db user ${new URL(url).username}), rows per club ${process.env.ROWS ?? "200000"}`);
const r = spawnSync(node24(), ["node_modules/vitest/vitest.mjs", "run", "--config", "scripts/perf/vitest.perf.config.ts"], { cwd: APP, env, encoding: "utf8", timeout: 45 * 60_000, maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");
const lines = out.split(/\r?\n/).filter((l) => /^\s*(PERF|PLAN|SEED|TEARDOWN)\b|✓|×|Tests |Test Files|FAIL|Error/.test(l) && !/sslmode|libpq|SSL modes/.test(l));
console.log(lines.join("\n"));
console.log(`[activity-perf] exit ${r.status}`);
process.exit(r.status === 0 ? 0 : 1);
