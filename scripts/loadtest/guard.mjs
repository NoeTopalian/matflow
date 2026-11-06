// Load-test target guard. Every other script in scripts/loadtest imports this module first.
//
// The load test runs ONLY against a throwaway Neon child branch of the shared test branch (ep-hidden-salad), never
// against production (ep-bold-wave). The target is the pooled URL Noe pastes into scripts/loadtest/.env.loadtest
// (gitignored by the root ".env*" rule) as LOADTEST_DATABASE_URL=...
//
// Refusals, in order. Every check works from the URLs and the connections themselves; nothing is ever written to
// the shared test branch to make a check possible.
//   1. any URL or environment value that mentions the production endpoint;
//   2. a URL that is not a pooled Neon host in the test branch's region;
//   3. the shared test branch, unless --allow-shared-test-branch (tiny smoke runs only; see SHARED_LIMITS);
//   4. any other host without an explicit --child-branch (the operator says it is the throwaway child), and a
//      host that is not different from both the test branch and production;
//   5. credentials that are not the test branch's own roles (a Neon branch inherits its parent's roles and
//      passwords, so a branch of another project, or a hand-made role, does not match);
//   6. live, read-only on both sides: the target's Neon project (neon.tenant_id) must be the test branch's, and its
//      timeline (neon.timeline_id) must be its own for a child, or the test branch's for the shared smoke run.
//
// The pure checks are exported for tests/unit/loadtest-guard.test.ts. Nothing here prints a URL or a password.
//
// CLI (from the repo root):
//   node scripts/loadtest/guard.mjs --child-branch                 check the configured child branch
//   node scripts/loadtest/guard.mjs --allow-shared-test-branch     check the shared test branch (smoke only)
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const PROD_ENDPOINT = "ep-bold-wave";
export const TEST_ENDPOINT = "ep-hidden-salad";
export const ALLOW_SHARED_FLAG = "--allow-shared-test-branch";
export const CHILD_FLAG = "--child-branch";
/** The shared test branch is used by every builder: a run there stays tiny and short. */
export const SHARED_LIMITS = Object.freeze({ maxMembers: 50, maxClubs: 3, maxSecondsPerScenario: 30, maxVus: 20 });

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "../..");
export const ENV_FILE = path.join(HERE, ".env.loadtest");

export class GuardRefusal extends Error {
  constructor(message) { super(`refusing: ${message}`); this.name = "GuardRefusal"; }
}
const refuse = (message) => { throw new GuardRefusal(message); };

/** The Neon endpoint id of a host (ep-adjective-noun-hash), with or without "-pooler"; null if not a Neon host. */
export function endpointOf(host) {
  const m = /^(ep-[a-z]+-[a-z]+-[a-z0-9]+?)(-pooler)?\.[a-z0-9.-]+\.neon\.tech$/i.exec(host ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** "eu-west-2.aws.neon.tech" for "ep-x-y-z-pooler.eu-west-2.aws.neon.tech". */
const regionOf = (host) => host.slice(host.indexOf(".") + 1).toLowerCase();

function parsePg(raw, name) {
  let u;
  try { u = new URL(raw); } catch { refuse(`${name} is not a URL`); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") refuse(`${name} is not a postgres URL`);
  return u;
}

/** Refuse if any value mentions the production endpoint. Names the keys, never the values. */
export function assertNoProduction(values) {
  const bad = Object.entries(values).filter(([, v]) => typeof v === "string" && v.toLowerCase().includes(PROD_ENDPOINT)).map(([k]) => k);
  if (bad.length) refuse(`${bad.join(", ")} mention${bad.length === 1 ? "s" : ""} the production endpoint ${PROD_ENDPOINT}`);
}

/**
 * Static checks of a target URL against the test branch's URLs (from .env.test). Pure: no network.
 * @param {string} raw            the target URL
 * @param {{ owner: string, restricted?: string }} testUrls  the test branch's owner and restricted-role URLs
 * @param {{ allowShared?: boolean, childBranch?: boolean }} opts  the operator's flags
 * @returns {{ endpoint: string, host: string, shared: boolean, role: string }}
 */
export function checkTargetUrl(raw, testUrls, { allowShared = false, childBranch = false } = {}) {
  if (typeof raw !== "string" || !raw.trim()) refuse("no target URL");
  assertNoProduction({ target: raw });
  const u = parsePg(raw.trim(), "the target");
  const host = u.hostname.toLowerCase();
  const endpoint = endpointOf(host);
  if (!endpoint) refuse(`host ${host} is not a Neon endpoint`);
  if (!host.split(".")[0].endsWith("-pooler")) refuse(`host ${host} is not the pooled endpoint: paste the "Pooled connection" string (its host contains -pooler)`);

  const testOwner = parsePg(testUrls?.owner ?? "", "the test branch URL (.env.test DATABASE_URL)");
  assertNoProduction({ "the test branch URL": testUrls.owner, "the restricted test URL": testUrls.restricted });
  const testEndpoint = endpointOf(testOwner.hostname);
  if (!testEndpoint?.startsWith(TEST_ENDPOINT)) refuse(".env.test DATABASE_URL is not the shared test branch");
  if (regionOf(host) !== regionOf(testOwner.hostname.toLowerCase())) refuse(`host ${host} is not in the test branch's region (${regionOf(testOwner.hostname)})`);

  const shared = endpoint.startsWith(TEST_ENDPOINT) || endpoint === testEndpoint;
  if (shared && !allowShared) refuse(`${host} is the SHARED test branch; the load test needs a child branch of it (or ${ALLOW_SHARED_FLAG} for a tiny smoke run)`);
  if (!shared && !childBranch) refuse(`${host} is neither the test branch nor production: pass ${CHILD_FLAG} to confirm it is the throwaway child branch of the test branch`);
  if (shared && childBranch) refuse(`${CHILD_FLAG} was given but ${host} is the shared test branch`);

  // A Neon branch inherits its parent's roles with their passwords: the target's credentials must be one of the
  // test branch's own roles, byte for byte.
  const roles = [testOwner, testUrls.restricted ? parsePg(testUrls.restricted, "the restricted test URL") : null].filter(Boolean);
  const role = roles.find((r) => r.username === u.username);
  if (!role) refuse(`role "${u.username}" is not one of the test branch's roles (${roles.map((r) => r.username).join(", ")})`);
  if (role.password !== u.password) refuse(`the password for "${u.username}" is not the test branch's: not a branch of the test branch`);
  if (u.pathname !== testOwner.pathname) refuse(`database ${u.pathname} is not the test branch's database ${testOwner.pathname}`);
  return { endpoint, host, shared, role: u.username };
}

/** The same role URL as `testRoleUrl`, on the target's host (Neon branches inherit roles and passwords). */
export function onTargetHost(testRoleUrl, targetUrl) {
  const role = new URL(testRoleUrl);
  role.hostname = new URL(targetUrl).hostname;
  assertNoProduction({ derived: role.toString() });
  return role.toString();
}

/** Read-only: which Neon project and timeline a connection is on. Run on the target and on the test branch. */
export const LINEAGE_SQL = "select current_setting('neon.tenant_id', true) as project, current_setting('neon.timeline_id', true) as timeline";

/** Judge the two lineage rows (target, test branch). Pure. */
export function checkLineage(target, test, { shared }) {
  const hex = (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
  if (!hex(target?.project) || !hex(target?.timeline)) refuse("the target reports no Neon project or timeline (not a Neon branch)");
  if (!hex(test?.project) || !hex(test?.timeline)) refuse("the test branch reports no Neon project or timeline");
  if (target.project !== test.project) refuse("the target is not in the test branch's Neon project");
  if (shared && target.timeline !== test.timeline) refuse("this host is named as the shared test branch but is on another timeline");
  if (!shared && target.timeline === test.timeline) refuse("this database IS the shared test branch (same timeline) under another host name");
  return { project: target.project, timeline: target.timeline, testTimeline: test.timeline };
}

/** KEY=value lines of a dotenv-style file ({} when missing). */
export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

/** The main checkout (holds .env.test), found through git's common dir, or MF_REPO. */
export function mainCheckout() {
  if (process.env.MF_REPO) return path.resolve(process.env.MF_REPO);
  const gitFile = path.join(REPO_ROOT, ".git");
  if (fs.existsSync(gitFile) && fs.statSync(gitFile).isFile()) {
    // A worktree: ".git" is a file "gitdir: <main>/.git/worktrees/<name>".
    const gitdir = fs.readFileSync(gitFile, "utf8").match(/gitdir:\s*(.+)/)?.[1]?.trim();
    if (gitdir) return path.resolve(gitdir, "../../..");
  }
  return REPO_ROOT;
}

export function testBranchUrls() {
  const env = readEnvFile(path.join(mainCheckout(), ".env.test"));
  if (!env.DATABASE_URL) refuse(`no DATABASE_URL in ${path.join(mainCheckout(), ".env.test")} (the test-branch settings)`);
  return { owner: env.DATABASE_URL, restricted: env.RESTRICTED_DATABASE_URL, env };
}

/**
 * The checked target: the owner-role URL (seed, migrate, monitor) and the app-role URL (the server), both on the
 * target host. Static checks only; guardTarget adds the live check.
 */
export function resolveTarget({ allowShared = false, childBranch = false, envFile = ENV_FILE, test = testBranchUrls() } = {}) {
  const configured = readEnvFile(envFile).LOADTEST_DATABASE_URL;
  let raw = configured;
  if (!raw) {
    if (!allowShared) refuse(`no LOADTEST_DATABASE_URL in ${envFile}. Noe's one step: create a Neon child branch of the test branch and paste its pooled URL there (see scripts/loadtest/README.md)`);
    raw = test.owner;
  }
  const checked = checkTargetUrl(raw, { owner: test.owner, restricted: test.restricted }, { allowShared, childBranch });
  // The owner role seeds and migrates; the app runs as the restricted role when the test branch has one, as
  // production does.
  const ownerUrl = checked.role === new URL(test.owner).username ? raw : onTargetHost(test.owner, raw);
  const appUrl = test.restricted ? onTargetHost(test.restricted, raw) : ownerUrl;
  return { ...checked, ownerUrl, appUrl, appRole: new URL(appUrl).username, testEnv: test.env, testOwnerUrl: test.owner };
}

/** Refuse a shared-test-branch run that is not tiny. */
export function checkSharedLimits({ shared, members, clubs, secondsPerScenario, vus }) {
  if (!shared) return;
  const L = SHARED_LIMITS;
  if (members > L.maxMembers) refuse(`the shared test branch takes at most ${L.maxMembers} members (asked ${members})`);
  if (clubs > L.maxClubs) refuse(`the shared test branch takes at most ${L.maxClubs} clubs (asked ${clubs})`);
  if (secondsPerScenario > L.maxSecondsPerScenario) refuse(`the shared test branch takes at most ${L.maxSecondsPerScenario} s per scenario (asked ${secondsPerScenario})`);
  if (vus > L.maxVus) refuse(`the shared test branch takes at most ${L.maxVus} virtual users (asked ${vus})`);
}

const requireFromRepo = () => createRequire(path.join(REPO_ROOT, "package.json"));

/** A pg client on `url` with client-side limits (a silently dropped Neon connection must fail, not hang). */
export async function pgConnect(url) {
  const pg = requireFromRepo()("pg");
  const c = new pg.Client({ connectionString: url, statement_timeout: 60000, connectionTimeoutMillis: 20000, query_timeout: 90000, keepAlive: true });
  await c.connect();
  return c;
}

async function lineageRow(url) {
  const c = await pgConnect(url);
  try { return (await c.query(LINEAGE_SQL)).rows[0]; } finally { await c.end(); }
}

/** Resolve, check statically, then check lineage live (two read-only queries). The scripts' one entry point. */
export async function guardTarget({ allowShared = false, childBranch = false } = {}) {
  const target = resolveTarget({ allowShared, childBranch });
  const [mine, test] = await Promise.all([lineageRow(target.ownerUrl), target.shared ? null : lineageRow(target.testOwnerUrl)]);
  const lineage = checkLineage(mine, test ?? mine, { shared: target.shared });
  return { ...target, lineage };
}

/** The flags a script passes on to the scripts it runs, so each re-checks the same target. */
export const targetFlags = (t) => (t.shared ? [ALLOW_SHARED_FLAG] : [CHILD_FLAG]);

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const t = await guardTarget({ allowShared: process.argv.includes(ALLOW_SHARED_FLAG), childBranch: process.argv.includes(CHILD_FLAG) });
    console.log(`GUARD OK: ${t.shared ? "SHARED test branch (smoke only)" : "child branch"} ${t.host}; seed/migrate role ${new URL(t.ownerUrl).username}, app role ${t.appRole}; Neon project matches the test branch, timeline ${t.lineage.timeline}${t.shared ? "" : ` (the test branch is ${t.lineage.testTimeline})`}`);
  } catch (e) {
    console.error(e instanceof GuardRefusal ? e.message : `guard failed: ${e.message}`);
    process.exit(3);
  }
}
