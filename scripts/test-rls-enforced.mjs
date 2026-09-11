/**
 * Runs the RLS enforcement suite as the RESTRICTED role, with RLS_ENFORCED=1.
 *
 * Why this script exists: the six enforcement assertions in
 * tests/integration/rls-foundation.test.ts self-skip when the connected role
 * holds BYPASSRLS — which is every connection the normal suite uses. For the
 * life of this project they had therefore never executed, and reported green.
 * Running them as `matflow_app` makes them real; RLS_ENFORCED=1 makes a skip
 * a failure so the gap cannot silently return.
 *
 * Verified 2026-09-11: 9 passed, 0 skipped under the restricted role.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const env = readFileSync(".env.test", "utf8");
const pick = (k) => (env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1] ?? "").trim().replace(/^"|"$/g, "");

const restricted = pick("RESTRICTED_DATABASE_URL");
if (!restricted) {
  console.error("[rls] RESTRICTED_DATABASE_URL is not set in .env.test — cannot prove enforcement.");
  process.exit(1);
}
// Never let this point anywhere but the test branch.
if (!restricted.includes("ep-hidden-salad") || restricted.includes("ep-bold-wave")) {
  console.error("[rls] RESTRICTED_DATABASE_URL is not the test branch. Refusing.");
  process.exit(1);
}

// `shell: true` is required on Windows: spawning npx.cmd directly returns
// EINVAL on current Node versions.
const r = spawnSync("npx vitest run tests/integration/rls-foundation.test.ts", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: restricted, TEST_DATABASE_URL: restricted, RLS_ENFORCED: "1" },
});
process.exit(r.status ?? 1);
