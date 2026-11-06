// Shared helpers for the load-test scripts. Import order matters: guard first, then the app root, then the
// verification skill's env.mjs (which re-runs the calling script on Node 24 and prints the node it runs on).
import { REPO_ROOT, TEST_ENDPOINT, PROD_ENDPOINT, assertNoProduction, GuardRefusal } from "./guard.mjs";
import "./app-root.mjs";
import { node24, appEnv, assertWorktree, DATA as VERIFY_DATA } from "../../.claude/skills/matflow-verify-local/scripts/env.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHmac } from "node:crypto";

export { node24, assertWorktree, VERIFY_DATA };

/** Outside git: %LOCALAPPDATA%/matflow-loadtest/<stamp>/ holds state, the k6 data file (synthetic sessions), logs. */
export const LT_DATA = (process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache")).replace(/\\/g, "/") + "/matflow-loadtest";
export const runDir = (stamp) => { const d = `${LT_DATA}/${stamp}`; fs.mkdirSync(d, { recursive: true }); return d; };
export const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
export function writeJson(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** lt<yyyymmdd><6 random base36>: unique per run; every slug and address the run creates carries it. */
export const newStamp = () => `lt${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${randomBytes(4).readUInt32BE(0).toString(36).padStart(6, "0").slice(-6)}`;
export const STAMP_RE = /^lt\d{8}[0-9a-z]{6}$/;
export const slugPrefix = (stamp) => `${stamp}-c`;

/** Production builds name the session cookie with the __Secure- prefix (lib/auth-cookie.ts). */
export const SESSION_COOKIE = "__Secure-authjs.session-token";
/** RFC 2544 benchmarking range: every lane address k6 uses is in 198.18.0.0/15, so its rate-limit rows are ours. */
export const LANE_PREFIXES = ["198.18.", "198.19."];

/** Minimal flag parser: --name value | --flag. Unknown flags are refused (no silent typos like --allow-foreign). */
export function parseFlags(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new GuardRefusal(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in spec)) throw new GuardRefusal(`unknown flag ${a} (known: ${Object.keys(spec).map((k) => `--${k}`).join(" ")})`);
    if (spec[key] === "bool") out[key] = true;
    else { const v = argv[++i]; if (v === undefined) throw new GuardRefusal(`${a} needs a value`); out[key] = spec[key] === "int" ? Number.parseInt(v, 10) : v; }
  }
  return out;
}

/** The auth secret the app signs with (lib/auth-secret.ts: NEXTAUTH_SECRET, else AUTH_SECRET). */
export function authSecret(testEnv) {
  const a = testEnv.NEXTAUTH_SECRET?.trim(), b = testEnv.AUTH_SECRET?.trim();
  if (a && b && a !== b) throw new GuardRefusal("NEXTAUTH_SECRET and AUTH_SECRET differ in .env.test; sessions minted with one would not verify under the other");
  const s = a || b;
  if (!s) throw new GuardRefusal(".env.test has no AUTH_SECRET");
  return s;
}

/** lib/token-hash.ts hashToken for a random (non-reserved) token: HMAC-SHA256 with the auth secret. */
export const hashToken = (secret, raw) => createHmac("sha256", secret).update(raw).digest("hex");

/** Prisma on `url` (owner role) with an RLS-bypassing transaction helper, as the journey fixtures do. */
export async function prismaFor(url) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, connectionTimeoutMillis: 20000 }) });
  const bypass = (fn, timeout = 300000) => prisma.$transaction(async (tx) => { await tx.$executeRaw`select set_config('app.bypass_rls','on',true)`; return fn(tx); }, { timeout, maxWait: 30000 });
  return { prisma, bypass };
}

/**
 * Process env for `next start` against the target: the test env (secrets of the TEST branch only), provider keys
 * disabled (env.mjs appEnv), the database set to the target's app role, and nothing else that names a database.
 */
export function serverEnv(target, base) {
  const env = appEnv();
  for (const k of Object.keys(env)) if (/DATABASE_URL|POSTGRES|^PG[A-Z]/i.test(k)) delete env[k];
  if (!target.shared) for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v.includes(TEST_ENDPOINT)) delete env[k];
  env.DATABASE_URL = target.appUrl;
  env.NEXTAUTH_URL = env.AUTH_URL = base;
  env.AUTH_TRUST_HOST = "true";
  env.NODE_ENV = "production";
  // Production behaviour: the login throttle on, no E2E harness, no testing mode.
  env.LOGIN_THROTTLE_ENABLED = "true";
  env.E2E_AUTH_BYPASS = "false";
  env.TESTING_MODE = "false";
  assertNoProduction(env);
  return env;
}

/** Scrub anything URL- or secret-shaped from text we print or save. */
export const scrub = (s) => String(s)
  .replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>")
  .replace(/[A-Za-z0-9._%+-]+@example\.test/g, "<synthetic address>")
  .replace(new RegExp(PROD_ENDPOINT, "g"), "<production endpoint>");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { REPO_ROOT };
