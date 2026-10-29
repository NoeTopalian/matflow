// Runs integration test files against the Neon TEST branch, first as the owner role (TEST_DATABASE_URL), then as the
// restricted runtime role matflow_app (RESTRICTED_DATABASE_URL). URLs come from .env.test and are never printed.
//   node db-tests.mjs tests/integration/<file>.test.ts [more files]      (from the worktree root)
import { spawnSync } from "node:child_process";
import { APP, testEnv, assertTestUrl, assertWorktree, node24 } from "./env.mjs";

const files = process.argv.slice(2);
if (!files.length) { console.log("usage: node db-tests.mjs tests/integration/<file>.test.ts …"); process.exit(2); }
assertWorktree();
const t = testEnv();
const roles = { owner: assertTestUrl(t.TEST_DATABASE_URL, "TEST_DATABASE_URL"), restricted: assertTestUrl(t.RESTRICTED_DATABASE_URL, "RESTRICTED_DATABASE_URL") };
let failed = 0;
for (const [role, url] of Object.entries(roles)) {
  // The restricted pass sets RLS_ENFORCED=1, as scripts/test-rls-enforced.mjs does: the security files assert
  // it and fail their role check without it.
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url, ...(role === "restricted" ? { RLS_ENFORCED: "1" } : {}) };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.MIGRATION_DATABASE_URL;
  const r = spawnSync(node24(), ["node_modules/vitest/vitest.mjs", "run", ...files], { cwd: APP, env, encoding: "utf8", timeout: 600000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");
  const lines = out.split(/\r?\n/).filter((l) => /✓|×|↓|Tests |Test Files|FAIL|Error/.test(l) && !/sslmode|libpq|SSL modes/.test(l));
  console.log(`== ${role} (db user ${new URL(url).username}) exit ${r.status}`);
  console.log(lines.slice(-40).join("\n"));
  if (r.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
