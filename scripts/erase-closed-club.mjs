// Erase ONE closed club on its written request (product rule, Noe, 16 Oct and 6 Nov 2026).
//
// MatFlow never deletes a club on its own: a club that closes is kept, with sign-in disabled, so it can reopen.
// The only way a club's data is permanently erased is this runner, run BY HAND by Noe or an operator after the
// club has asked in writing. Never by an agent, a cron, CI or any other automation (it refuses those below).
//
//   DATABASE_URL=<target> node scripts/erase-closed-club.mjs <tenantId> \
//     --reason "<the written request: who asked, when, how>" --expect-host <ep-…> --confirm
//
//   <tenantId>     the club's id (the hub's club page shows it).
//   --reason       REQUIRED, 10–500 characters. Recorded on the erasure-evidence audit row (admin.tenant.hard_deleted).
//   --expect-host  REQUIRED. The Neon endpoint the URL must resolve to: ep-bold-wave (production), ep-hidden-salad
//                  (test) or a whole endpoint id. Same guard as every readiness script (scripts/readiness/db-target.mjs).
//   --confirm      REQUIRED. Without it the runner prints what it would do and stops.
//
// What it does (lib/tenant-purge.ts purgeTenantById): refuses unless the club is CLOSED; cancels live member
// subscriptions first (fail-closed: a refusal leaves the club intact and reopenable); claims the club (reopen is
// refused from then on); deletes its rows in FK order, every file under its store prefix, then the club row, with
// the evidence row in the same transaction. AuditLog rows are kept. It prints the outcome (PurgeOneOutcome).
//   - "partial" or a busy row: run the same command again later; the claim stands and the erasure resumes.
//   - "billing-blocked": sort the named subscription out in Stripe, then run again.
//
// Exit codes: 0 erased · 1 failed (see the message) · 2 refused before any change · 3 not erased (outcome printed)
//             · 75 busy (another writer holds the club's row): try again later.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDbTarget, TargetRefused } from "./readiness/db-target.mjs";

export { TargetRefused };

/** @param {string[]} argv @param {string} name */
function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/**
 * Pure argument and context checks; throws TargetRefused. Never touches a database.
 * @param {string[]} argv the arguments after the script name
 * @param {{ env: Record<string, string | undefined>, interactive: boolean }} ctx
 * @returns {{ tenantId: string, reason: string, expectHost: string, confirm: boolean }}
 */
export function parseEraseArgs(argv, { env, interactive }) {
  for (const k of ["CI", "GITHUB_ACTIONS", "VERCEL", "VERCEL_ENV"]) {
    if (env[k]) throw new TargetRefused(`REFUSED: ${k} is set — this runner never runs as part of anything automatic`);
  }
  if (!interactive) throw new TargetRefused("REFUSED: not an interactive terminal — run it by hand");
  const tenantId = argv[0];
  if (!tenantId || tenantId.startsWith("--") || !/^[a-z0-9][a-z0-9_-]{7,63}$/i.test(tenantId)) {
    throw new TargetRefused("REFUSED: the first argument must be the club's id");
  }
  const reason = (argValue(argv, "--reason") ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new TargetRefused("REFUSED: --reason is required (10–500 characters): the club's written request");
  }
  const expectHost = argValue(argv, "--expect-host");
  if (!expectHost) throw new TargetRefused("REFUSED: --expect-host <endpoint> is required");
  return { tenantId, reason, expectHost, confirm: argv.includes("--confirm") };
}

function main() {
  let args;
  try {
    args = parseEraseArgs(process.argv.slice(2), { env: process.env, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY });
    const host = resolveDbTarget(process.env.DATABASE_URL ?? "", { expectHost: args.expectHost, allowProduction: true });
    console.log(`[erase-closed-club] target ${host}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync("npx", ["tsx", path.join(here, "erase-closed-club-run.ts")], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ERASE_TENANT_ID: args.tenantId, ERASE_REASON: args.reason, ERASE_CONFIRM: args.confirm ? "1" : "" },
  });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
