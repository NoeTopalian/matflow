// Shared guards for the MatFlow verification skills. Neon TEST branch only; production is refused everywhere.
// Nothing here is machine-specific: every location is discovered or comes from an environment variable.
//   MF_APP    the worktree under test (default: current directory). Must have no .env* file except the examples.
//   MF_REPO   checkout holding .env.test (default: the main checkout, found through `git rev-parse --git-common-dir`).
//   MF_NODE24 folder holding a Node 24 executable (default: the saved user variable of that name).
//   MF_PORT   app port (default 3991; the HTTPS proxy is MF_PORT+2). Parallel sessions pick another port.
//   MF_OUT    output folder (default: %LOCALAPPDATA%/matflow-verify/<worktree name>, outside git).
// Importing this module guarantees the importing script runs on Node 24: on any other version it re-runs itself
// under MF_NODE24 and exits with that run's code. Every script prints the executable and version it runs on.
// Secrets from .env.test are never printed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const fwd = (p) => p.replace(/\\/g, "/");
const WIN = process.platform === "win32";

/** package.json engines: >=24.18.1 <25. */
const supported = (v) => { const [maj, min] = v.replace(/^v/, "").split(".").map(Number); return maj === 24 && min >= 18; };

/** MF_NODE24 from this process, or from the user's saved variables (a session started before it was set lacks it). */
function savedNode24() {
  if (process.env.MF_NODE24) return process.env.MF_NODE24;
  if (!WIN) return null;
  const r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "MF_NODE24"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.match(/MF_NODE24\s+REG_\w+\s+(.+)/)?.[1]?.trim() ?? null : null;
}

/** Absolute path of the supported Node executable this run uses (the current one once re-executed). */
export function node24() {
  if (supported(process.version)) return fwd(process.execPath);
  const dir = savedNode24();
  for (const file of dir ? [path.join(dir, WIN ? "node.exe" : "bin/node"), path.join(dir, "node")] : []) {
    const r = spawnSync(file, ["-v"], { encoding: "utf8" });
    if (r.status === 0 && supported(r.stdout.trim())) return fwd(file);
  }
  throw new Error("BLOCKED: no Node 24 (>=24.18.1 <25) found. Install it and set the MF_NODE24 user variable to its folder.");
}

if (!supported(process.version)) {
  if (process.env.MF_NODE24_REEXEC) throw new Error(`re-exec did not reach Node 24 (got ${process.version})`);
  const r = spawnSync(node24(), process.argv.slice(1), { stdio: "inherit", env: { ...process.env, MF_NODE24_REEXEC: "1" } });
  process.exit(r.status ?? 1);
}
console.log(`[matflow-verify] node ${fwd(process.execPath)} ${process.version}`);

export const TEST_HOST = "ep-hidden-salad";
export const PROD_HOST = "ep-bold-wave";
export const APP = fwd(path.resolve(process.env.MF_APP ?? process.cwd()));
export const PORT = Number(process.env.MF_PORT ?? 3991);
export const PUB = PORT + 2;
export const BASE = `https://localhost:${PUB}`;
export const DATA = fwd(path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "matflow-verify"));
export const OUT = fwd(process.env.MF_OUT ?? path.join(DATA, path.basename(APP)));
fs.mkdirSync(OUT, { recursive: true });

/** The main checkout: parent of the shared .git directory, so a worktree anywhere finds the same .env.test. */
function mainCheckout() {
  if (process.env.MF_REPO) return fwd(path.resolve(process.env.MF_REPO));
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: APP, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`refusing: ${APP} is not inside a git checkout (set MF_REPO)`);
  return fwd(path.dirname(r.stdout.trim()));
}
export const REPO = mainCheckout();

/** Every KEY=value line of .env.test. */
export function testEnv() {
  const file = `${REPO}/.env.test`;
  if (!fs.existsSync(file)) throw new Error(`BLOCKED: ${file} is missing (the test-branch settings; never committed)`);
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return env;
}

export function assertTestUrl(url, name) {
  if (!url || !url.includes(TEST_HOST) || url.includes(PROD_HOST)) throw new Error(`refusing: ${name} is not the Neon test branch`);
  return url;
}

/** A MatFlow checkout with no .env* file (Next loads .env, .env.local, .env.production, .env.production.local …). */
export function assertWorktree() {
  const pkg = `${APP}/package.json`;
  if (!fs.existsSync(pkg) || JSON.parse(fs.readFileSync(pkg, "utf8")).name !== "matflow") throw new Error(`refusing: ${APP} is not a MatFlow checkout`);
  const envFiles = fs.readdirSync(APP).filter((f) => /^\.env(\..+)?$/.test(f) && !f.endsWith(".example"));
  if (envFiles.length) throw new Error(`refusing: ${APP} has ${envFiles.join(", ")} (Next would load it). Use a git worktree without .env files.`);
  if (!fs.existsSync(`${APP}/node_modules/next`)) throw new Error(`BLOCKED: ${APP} has no node_modules — run "npm ci" there with Node 24 (a junction is not enough for Turbopack)`);
}

/** Process env for next start: .env.test values, provider keys disabled, nothing from production. */
export function appEnv({ isolated = true } = {}) {
  const env = { ...process.env, ...testEnv() };
  assertTestUrl(env.DATABASE_URL, "DATABASE_URL");
  for (const k of Object.keys(env)) if (/^(PATH|VERCEL_ENV|NODE_TLS_REJECT_UNAUTHORIZED|MIGRATION_DATABASE_URL|MF_NODE24_REEXEC)$/i.test(k)) delete env[k];
  env[WIN ? "Path" : "PATH"] = `${path.dirname(node24())}${path.delimiter}${process.env.PATH ?? ""}`;
  env.EMAIL_DELIVERY = "off";
  env.TESTING_MODE = "false";
  env.E2E_BYPASS_TOKEN = "";
  if (isolated) {
    for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "BLOB_READ_WRITE_TOKEN", "ANTHROPIC_API_KEY", "RESEND_FROM"]) env[k] = "";
    env.STRIPE_SECRET_KEY = "sk_test_invalid_local_never_charges";
    env.STRIPE_WEBHOOK_SECRET = "whsec_invalid_local";
    env.STRIPE_CLIENT_ID = "ca_invalid_local";
    env.RESEND_API_KEY = "re_invalid_local_never_sends";
  }
  return env;
}

/** Process env for next build: as above but with NO database variable at all, so nothing in the build can migrate. */
export function buildEnv() {
  const env = appEnv();
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG/i.test(k)) delete env[k];
  return env;
}

/** Process env for the Prisma CLI: the test branch's DATABASE_URL and nothing else that could redirect it. */
export function prismaEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG|^PATH$|MF_NODE24_REEXEC/i.test(k)) delete env[k];
  env.DATABASE_URL = assertTestUrl(testEnv().DATABASE_URL, "DATABASE_URL");
  env[WIN ? "Path" : "PATH"] = `${path.dirname(node24())}${path.delimiter}${process.env.PATH ?? ""}`;
  return env;
}
