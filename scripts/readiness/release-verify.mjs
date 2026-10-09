// READ-ONLY release verification (admin hub lane E, 9 Oct 2026; ledger AH-06).
// Replaces the defective scratch release-verify.sh, which printed values and
// exited 0 whatever they said, and "proved" the legacy door closed by sending {}.
//
//   node scripts/readiness/release-verify.mjs --target production|test --sha <40-hex> --base-url <url> \
//     --tenant <slug> --env-file-for-migrations <env file> --expect-host <neon endpoint id> \
//     --expect-migrations <name,name,...|local|@file> \
//     [--expect-operator-login --operator-session-file <private>] \
//     [--legacy-credential-file <private>]                 (test target on a loopback server only) \
//     [--mail-counter-url <loopback url> --mail-trigger-file <private>]   (test target: required)
//
//   node scripts/readiness/release-verify.mjs mail-interceptor [--port 4599]
//     A counting stand-in for Resend for a TEST server started with
//     RESEND_BASE_URL=http://127.0.0.1:4599 and a dummy RESEND_API_KEY: every
//     send that reaches the transport is counted (GET /__count) and never leaves the machine.
//
// Checks (each a named PASS/FAIL/INCONCLUSIVE/SKIPPED row; INCONCLUSIVE fails):
//   vercel.production_sha   production target: `vercel api /v9/projects/<id>` (MSYS_NO_PATHCONV=1)
//                           → targets.production.meta.githubCommitSha === --sha and readyState READY
//   health                  GET /api/health → 200 AND JSON {status:"ok", db:"ok"}
//   migrations.applied      _prisma_migrations has every expected name with finished_at and no rolled_back_at
//                           (READ ONLY transaction, statement_timeout, host guard on the endpoint id)
//   tenant.email_delivery_off  GET /api/tenant/<slug> → 200 AND emailDelivery === "off"
//   mail.transport_untouched   test target: interceptor count 0 after a send-triggering request
//   mail.queue_empty           test target: no EmailLog row queued/sent/delivered since the trigger
//   legacy.header / legacy.cookie / legacy.login_post
//                           a WELL-FORMED credential (the real one from the private file on an
//                           authorised test target; otherwise a random 64-hex value) → the
//                           application's own 401/403 JSON. A redirect, an edge wall (non-JSON),
//                           a CSRF refusal, a 5xx or a 429 is INCONCLUSIVE, which fails.
//   operator.access         with --expect-operator-login: GET /api/admin/activity with the private
//                           session cookie → 200 JSON; a redirect FAILS. Required on production.
//
// Exit: 0 every required check PASSES; 1 any FAIL/INCONCLUSIVE/timeout/missing evidence; 2 refused
// (usage, host guard, private file inside the repo, a credential aimed at an unauthorised target).
// stdout = one JSON summary, stderr = human lines; never prints a credential or a session value.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, Refusal, parseArgs, hostGuard, assertOutsideRepo } from "./owner-login-change-check.mjs";

const SHA_RE = /^[0-9a-f]{40}$/;
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const MIGRATION_RE = /^[0-9]{14}_[A-Za-z0-9_]+$/;
const TIMEOUT_MS = 20_000;
const LEGACY_PROBE_PATH = "/api/admin/activity";

export function isLoopback(u) {
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

/** One HTTP exchange, bounded; never throws. */
export async function probe(fetchImpl, url, init = {}) {
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      contentType: res.headers?.get?.("content-type") ?? "",
      location: res.headers?.get?.("location") ? "present" : null,
      bodyText: text.slice(0, 8192),
    };
  } catch (e) {
    return { error: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network error" };
  }
}

function json(r) {
  if (!String(r.contentType).includes("application/json")) return undefined;
  try { return JSON.parse(r.bodyText); } catch { return undefined; }
}

const row = (name, status, detail = "") => ({ name, status, ...(detail ? { detail } : {}) });

/**
 * Is this the APPLICATION refusing the credential? Only a 401/403 with the
 * app's JSON error shape counts. Anything that never reached the credential
 * check is inconclusive, not proof.
 */
export function classifyRefusal(r) {
  if (r.error) return { status: "INCONCLUSIVE", detail: r.error };
  const s = r.status;
  if (s >= 200 && s < 300) return { status: "FAIL", detail: `access granted (${s})` };
  if (s >= 300 && s < 400) return { status: "INCONCLUSIVE", detail: `redirect ${s}` };
  if (s === 429) return { status: "INCONCLUSIVE", detail: "rate limited (429)" };
  if (s >= 500) return { status: "INCONCLUSIVE", detail: `server error ${s}` };
  if (s === 401 || s === 403) {
    const body = json(r);
    if (body === undefined) return { status: "INCONCLUSIVE", detail: `${s} without the application's JSON (edge wall or protection page)` };
    if (!body || typeof body.error !== "string") return { status: "INCONCLUSIVE", detail: `${s} JSON without an error field` };
    if (/origin|referer/i.test(body.error)) return { status: "INCONCLUSIVE", detail: `${s} same-origin refusal: the credential was never evaluated` };
    if (body.supportReadOnly) return { status: "INCONCLUSIVE", detail: `${s} support-session refusal` };
    return { status: "PASS", detail: `application refused (${s})` };
  }
  return { status: "INCONCLUSIVE", detail: `unexpected status ${s}` };
}

export async function checkHealth(fetchImpl, base) {
  const r = await probe(fetchImpl, `${base}/api/health`);
  if (r.error) return row("health", "FAIL", r.error);
  const b = json(r);
  const ok = r.status === 200 && b && b.status === "ok" && b.db === "ok";
  return row("health", ok ? "PASS" : "FAIL", ok ? "" : `status ${r.status}${b ? `, body status ${b.status}, db ${b.db}` : ", body not JSON"}`);
}

export async function checkTenantDelivery(fetchImpl, base, slug) {
  const r = await probe(fetchImpl, `${base}/api/tenant/${encodeURIComponent(slug)}`);
  if (r.error) return row("tenant.email_delivery_off", "FAIL", r.error);
  const b = json(r);
  const ok = r.status === 200 && b && b.emailDelivery === "off";
  return row("tenant.email_delivery_off", ok ? "PASS" : "FAIL", ok ? "" : `status ${r.status}, emailDelivery ${b ? JSON.stringify(b.emailDelivery ?? null) : "n/a"}`);
}

export async function checkLegacyTransports(fetchImpl, base, credential) {
  const origin = new URL(base).origin;
  const header = await probe(fetchImpl, `${base}${LEGACY_PROBE_PATH}`, { headers: { "x-admin-secret": credential } });
  const cookie = await probe(fetchImpl, `${base}${LEGACY_PROBE_PATH}`, { headers: { cookie: `matflow_admin=${credential}` } });
  const login = await probe(fetchImpl, `${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ secret: credential }),
  });
  return [
    ["legacy.header", header],
    ["legacy.cookie", cookie],
    ["legacy.login_post", login],
  ].map(([name, r]) => {
    const c = classifyRefusal(r);
    return row(name, c.status, c.detail);
  });
}

export async function checkOperatorAccess(fetchImpl, base, sessionValue) {
  const r = await probe(fetchImpl, `${base}${LEGACY_PROBE_PATH}`, { headers: { cookie: `matflow_op_session=${sessionValue}` } });
  if (r.error) return row("operator.access", "FAIL", r.error);
  if (r.status >= 300 && r.status < 400) return row("operator.access", "FAIL", `redirect ${r.status}`);
  const b = json(r);
  const ok = r.status === 200 && b !== undefined;
  return row("operator.access", ok ? "PASS" : "FAIL", ok ? "" : `status ${r.status}${b === undefined ? ", body not JSON" : ""}`);
}

export function parseVercelProject(stdout) {
  const s = String(stdout ?? "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

export function checkVercelSha(stdout, sha) {
  const j = parseVercelProject(stdout);
  if (!j) return row("vercel.production_sha", "FAIL", "no parseable project JSON from vercel api");
  const p = j.targets?.production;
  const got = p?.meta?.githubCommitSha ?? null;
  const ok = got === sha && p?.readyState === "READY";
  return row("vercel.production_sha", ok ? "PASS" : "FAIL", ok ? "" : `production ${got ?? "unknown"} (${p?.readyState ?? "no state"})`);
}

function defaultRunVercel(projectId) {
  const r = spawnSync("npx", ["--no-install", "vercel", "api", `/v9/projects/${projectId}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    encoding: "utf8",
    timeout: 60_000,
    shell: process.platform === "win32",
  });
  if (r.error || r.status !== 0) return { ok: false, stdout: "" };
  return { ok: true, stdout: r.stdout };
}

export function expectedMigrations(spec, repoRoot = REPO_ROOT) {
  let names;
  if (spec === "local") {
    const dir = path.join(repoRoot, "prisma", "migrations");
    names = fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "migration.sql")));
  } else if (spec.startsWith("@")) {
    names = fs.readFileSync(spec.slice(1), "utf8").split(/[\s,]+/);
  } else {
    names = spec.split(",");
  }
  names = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort();
  const bad = names.filter((n) => !MIGRATION_RE.test(n));
  if (!names.length || bad.length) throw new Refusal(`--expect-migrations: ${names.length ? `malformed name(s) ${bad.slice(0, 3).join(", ")}` : "empty list"}`);
  return names;
}

async function readOnly(client, fn) {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '15s'");
    return await fn();
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

export async function checkMigrations(client, expected) {
  const rows = await readOnly(client, async () => (await client.query(
    `select migration_name, finished_at, rolled_back_at from _prisma_migrations where migration_name = any($1)`,
    [expected],
  )).rows);
  const done = new Set(rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null).map((r) => r.migration_name));
  const missing = expected.filter((n) => !done.has(n));
  return row("migrations.applied", missing.length === 0 ? "PASS" : "FAIL",
    missing.length === 0 ? `${expected.length} applied` : `${missing.length} not applied: ${missing.slice(0, 5).join(", ")}`);
}

// UTC wall-clock text, compared with $2::timestamp: Prisma's TIMESTAMP(3) columns
// hold UTC without a zone, and a JS Date parameter would be cast with the local
// offset dropped (see owner-login-change-check.mjs, the TEST-branch finding).
async function dbNow(client) {
  return readOnly(client, async () => (await client.query(
    `select to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') as now`,
  )).rows[0].now);
}

export async function countQueuedMail(client, slug, since) {
  return readOnly(client, async () => {
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const r = await client.query(
      `select count(*)::int as n from "EmailLog" e join "Tenant" t on t.id = e."tenantId"
        where t.slug = $1 and e."createdAt" >= $2::timestamp and e.status in ('queued', 'sent', 'delivered')`,
      [slug, since],
    );
    return r.rows[0].n;
  });
}

export async function checkMail(fetchImpl, { base, counterUrl, triggerEmail, slug, client, sleep }) {
  const out = [];
  const before = await probe(fetchImpl, `${counterUrl}/__count`);
  const since = await dbNow(client);
  const trig = await probe(fetchImpl, `${base}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(base).origin },
    body: JSON.stringify({ email: triggerEmail, tenantSlug: slug }),
  });
  await sleep(3000); // background (after()) sends get their chance to fire
  const after = await probe(fetchImpl, `${counterUrl}/__count`);
  const b = json(before);
  const a = json(after);
  if (trig.error || trig.status !== 200) {
    out.push(row("mail.transport_untouched", "INCONCLUSIVE", `the send-triggering request answered ${trig.error ?? trig.status}`));
  } else if (!b || !a || typeof a.count !== "number") {
    out.push(row("mail.transport_untouched", "FAIL", "interceptor counter unreadable"));
  } else {
    out.push(row("mail.transport_untouched", a.count === 0 ? "PASS" : "FAIL", `count ${a.count} after the trigger`));
  }
  const queued = await countQueuedMail(client, slug, since);
  out.push(row("mail.queue_empty", queued === 0 ? "PASS" : "FAIL", `${queued} queued/sent row(s) since the trigger`));
  return out;
}

function readPrivate(file, what, repoRoot) {
  const p = path.resolve(file);
  assertOutsideRepo(p, what, repoRoot);
  let v;
  try { v = fs.readFileSync(p, "utf8").split(/\r?\n/)[0].trim(); } catch { throw new Refusal(`${what} is unreadable`); }
  if (!v) throw new Refusal(`${what} is empty`);
  return v;
}

export function startMailInterceptor(port = 4599, log = (s) => process.stderr.write(s + "\n")) {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__count") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ count }));
      return;
    }
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") {
        count++;
        log(`intercepted ${req.method} ${String(req.url).split("?")[0]} (#${count}); body discarded`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `intercepted-${count}` }));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function defaultConnect(connectionString) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, statement_timeout: 15000, query_timeout: 20000, connectionTimeoutMillis: 15000 });
  await client.connect();
  return client;
}

async function defaultReadEnv(file) {
  const { default: dotenv } = await import("dotenv");
  return dotenv.parse(fs.readFileSync(file, "utf8"));
}

export async function main(argv, deps = {}) {
  const out = deps.stdout ?? ((s) => process.stdout.write(s + "\n"));
  const err = deps.stderr ?? ((s) => process.stderr.write(s + "\n"));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const connect = deps.connect ?? defaultConnect;
  const readEnv = deps.readEnv ?? defaultReadEnv;
  const runVercel = deps.runVercel ?? defaultRunVercel;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const random = deps.randomCredential ?? (() => randomBytes(32).toString("hex"));
  const summary = { script: "release-verify", result: "ERROR", checks: [] };
  const finish = (code) => {
    out(JSON.stringify(summary));
    for (const c of summary.checks) err(`${c.status.padEnd(12)} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    err(`${summary.result}${summary.reason ? `: ${summary.reason}` : ""}`);
    return code;
  };

  let client;
  try {
    const a = parseArgs(argv);
    if (a._.length) throw new Refusal("unexpected positional argument");
    const target = a.target;
    if (!["production", "test"].includes(target)) throw new Refusal("--target production|test is required");
    summary.target = target;
    if (typeof a.sha !== "string" || !SHA_RE.test(a.sha)) throw new Refusal("--sha <full 40-character lower-case sha> is required");
    summary.sha = a.sha;
    if (typeof a["base-url"] !== "string") throw new Refusal("--base-url is required");
    let base;
    try { base = new URL(a["base-url"]).origin; } catch { throw new Refusal("--base-url is not a URL"); }
    if (target === "production" && (!base.startsWith("https://") || isLoopback(base))) throw new Refusal("a production target is an https, non-loopback URL");
    if (target === "test" && !isLoopback(base)) throw new Refusal("a test target is a loopback server (localhost / 127.0.0.1)");
    summary.baseUrl = base;
    if (typeof a.tenant !== "string" || !SLUG_RE.test(a.tenant)) throw new Refusal("--tenant <slug> is required");
    if (typeof a["env-file-for-migrations"] !== "string") throw new Refusal("--env-file-for-migrations is required");
    if (typeof a["expect-migrations"] !== "string") throw new Refusal("--expect-migrations <list|local|@file> is required");
    const expected = expectedMigrations(a["expect-migrations"], repoRoot);

    // Private inputs: refused inside the repo; the legacy credential only for an authorised test target.
    let legacy = null;
    if (a["legacy-credential-file"] !== undefined) {
      if (target !== "test") throw new Refusal("a real legacy credential may only be sent to an authorised TEST server; production gets a random well-formed value");
      legacy = readPrivate(String(a["legacy-credential-file"]), "the legacy credential file", repoRoot);
    }
    let session = null;
    if (a["expect-operator-login"] === true) {
      if (typeof a["operator-session-file"] !== "string") throw new Refusal("--expect-operator-login needs --operator-session-file <private>");
      session = readPrivate(a["operator-session-file"], "the operator session file", repoRoot);
    }
    let mail = null;
    if (target === "test") {
      if (typeof a["mail-counter-url"] !== "string" || typeof a["mail-trigger-file"] !== "string") {
        throw new Refusal("a test target needs --mail-counter-url and --mail-trigger-file (the delivery boundary must be observed)");
      }
      if (!isLoopback(a["mail-counter-url"])) throw new Refusal("--mail-counter-url must be loopback");
      mail = { counterUrl: new URL(a["mail-counter-url"]).origin, triggerEmail: readPrivate(a["mail-trigger-file"], "the mail trigger file", repoRoot) };
    } else if (a["mail-counter-url"] !== undefined) {
      throw new Refusal("the mail interceptor is a test-server instrument");
    }

    const env = await readEnv(path.resolve(a["env-file-for-migrations"]));
    const dbVar = typeof a["db-var"] === "string" ? a["db-var"] : "DATABASE_URL";
    if (!env[dbVar]) throw new Refusal(`${dbVar} is not set in the migrations env file`);
    summary.endpoint = hostGuard(env[dbVar], a["expect-host"]);

    const checks = summary.checks;
    if (target === "production") {
      let projectId = typeof a["vercel-project"] === "string" ? a["vercel-project"] : null;
      if (!projectId) {
        try { projectId = JSON.parse(fs.readFileSync(path.join(repoRoot, ".vercel", "project.json"), "utf8")).projectId; } catch { projectId = null; }
      }
      if (!projectId || !/^prj_[A-Za-z0-9]+$/.test(projectId)) checks.push(row("vercel.production_sha", "FAIL", "no Vercel project id"));
      else {
        const v = await runVercel(projectId);
        checks.push(v.ok ? checkVercelSha(v.stdout, a.sha) : row("vercel.production_sha", "FAIL", "vercel api failed or timed out"));
      }
    } else {
      checks.push(row("vercel.production_sha", "SKIPPED", "test target is not a Vercel deployment"));
    }

    checks.push(await checkHealth(fetchImpl, base));
    client = await connect(env[dbVar]);
    checks.push(await checkMigrations(client, expected));
    checks.push(await checkTenantDelivery(fetchImpl, base, a.tenant));
    if (mail) checks.push(...(await checkMail(fetchImpl, { base, ...mail, slug: a.tenant, client, sleep })));
    summary.legacyCredential = legacy ? "real (private file)" : "random well-formed";
    checks.push(...(await checkLegacyTransports(fetchImpl, base, legacy ?? random())));
    if (session) checks.push(await checkOperatorAccess(fetchImpl, base, session));
    else if (target === "production") checks.push(row("operator.access", "FAIL", "not run: authenticated operator access is required on production"));
    else checks.push(row("operator.access", "SKIPPED", "--expect-operator-login not given"));

    const bad = checks.filter((c) => c.status === "FAIL" || c.status === "INCONCLUSIVE");
    summary.failed = bad.length;
    summary.skipped = checks.filter((c) => c.status === "SKIPPED").map((c) => c.name);
    summary.result = bad.length ? "FAIL" : "PASS";
    return finish(bad.length ? 1 : 0);
  } catch (e) {
    if (e instanceof Refusal) {
      summary.result = "REFUSED";
      summary.reason = e.message;
      return finish(2);
    }
    summary.result = "ERROR";
    summary.reason = (e && e.code ? `${e.code} ` : "") + String(e?.message ?? e).slice(0, 200);
    return finish(1);
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  if (argv[0] === "mail-interceptor") {
    const a = parseArgs(argv.slice(1));
    const port = Number(a.port ?? 4599);
    startMailInterceptor(port);
    process.stderr.write(`mail interceptor on http://127.0.0.1:${port} (GET /__count)\n`);
  } else {
    main(argv).then((code) => { process.exitCode = code; });
  }
}
