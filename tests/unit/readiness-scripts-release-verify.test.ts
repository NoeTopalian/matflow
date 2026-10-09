// scripts/readiness/release-verify.mjs (admin hub lane E, 9 Oct 2026; ledger
// AH-06). The repaired replacement for the scratch release-verify.sh, which
// echoed values and exited 0 regardless, and "proved" the legacy login closed
// by POSTing {} (the route refuses an EMPTY body in every environment, so that
// probe said nothing about the old secret).
//
// Mocked fetch / pg / vercel: every assertion's PASS and FAIL, the
// inconclusive mapping (redirect, edge wall, CSRF refusal, 5xx, 429, no
// response), credential handling (real value only to an authorised loopback
// TEST target, random well-formed value otherwise, never printed), and exit codes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import * as script from "../../scripts/readiness/release-verify.mjs";

type Probe = { status?: number; contentType?: string; bodyText?: string; error?: string };
const s = script as unknown as {
  main: (argv: string[], deps: Record<string, unknown>) => Promise<number>;
  classifyRefusal: (r: Probe) => { status: string; detail: string };
  expectedMigrations: (spec: string) => string[];
  startMailInterceptor: (port: number, log?: (s: string) => void) => import("node:http").Server;
};

const SHA = "a".repeat(40);
const EP = "ep-fixture-salad-abc123";
const DB_URL = `postgresql://fixture:fixture@${EP}-pooler.eu-west-2.aws.neon.tech/neondb`;
const MIGRATIONS = ["20261009010000_audit_operator_request", "20261008000000_fixture_two"];
const PROD = "https://release.fixture.invalid";
const LOCAL = "http://localhost:4123";
const COUNTER = "http://127.0.0.1:4599";
const LEGACY_SECRET = "legacy-secret-value-fixture-0123456789abcdef";
const SESSION = "op-session-fixture-value.signature";

type Res = { status: number; json?: unknown; text?: string; contentType?: string };
const jsonRes = (status: number, body: unknown): Res => ({ status, json: body });

let tmp: string;
let outs: string[];
let errs: string[];
let routes: Record<string, (init: RequestInit & { headers?: Record<string, string> }) => Res | Error>;
let seen: { url: string; init: RequestInit & { headers?: Record<string, string> } }[];
let migrationRows: { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[];
let queued: number;
let counter: number;
let sql: string[];
let vercel: { ok: boolean; stdout: string };

function fetchMock(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  seen.push({ url, init });
  const u = new URL(url);
  const key = `${init.method ?? "GET"} ${u.pathname}`;
  const route = routes[key];
  if (!route) return Promise.reject(new TypeError("fetch failed"));
  const r = route(init);
  if (r instanceof Error) return Promise.reject(r);
  const body = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "");
  const ct = r.contentType ?? (r.json !== undefined ? "application/json" : "text/html");
  return Promise.resolve(new Response(body, { status: r.status, headers: { "content-type": ct } }));
}

const client = {
  async query(text: string) {
    sql.push(text);
    if (/_prisma_migrations/.test(text)) return { rows: migrationRows };
    if (/from "EmailLog"/.test(text)) return { rows: [{ n: queued }] };
    if (/as now/.test(text)) return { rows: [{ now: "2026-10-09 10:00:00.000" }] };
    return { rows: [] };
  },
  async end() {},
};

function deps(extra: Record<string, unknown> = {}) {
  return {
    fetch: fetchMock,
    connect: async () => client,
    readEnv: async () => ({ DATABASE_URL: DB_URL }),
    runVercel: async () => vercel,
    sleep: async () => {},
    stdout: (x: string) => outs.push(x),
    stderr: (x: string) => errs.push(x),
    ...extra,
  };
}

function privateFile(name: string, value: string) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, value + "\n");
  return f;
}

function prodArgs(extra: string[] = []) {
  return [
    "--target", "production", "--sha", SHA, "--base-url", PROD, "--tenant", "fixture-club",
    "--env-file-for-migrations", ".env.fixture", "--expect-host", EP, "--expect-migrations", MIGRATIONS.join(","),
    "--expect-operator-login", "--operator-session-file", privateFile("session.txt", SESSION),
    // SF-94 (lane F3): the project id is injected, never read from the untracked .vercel/project.json of whatever
    // checkout runs the suite (absent in a clean checkout and in CI). The file-read path has its own cells below,
    // each against a temporary repo root.
    "--vercel-project", FIXTURE_PROJECT, ...extra,
  ];
}
const FIXTURE_PROJECT = "prj_fixture0123456789";
function testArgs(extra: string[] = []) {
  return [
    "--target", "test", "--sha", SHA, "--base-url", LOCAL, "--tenant", "fixture-club",
    "--env-file-for-migrations", ".env.fixture", "--expect-host", EP, "--expect-migrations", MIGRATIONS.join(","),
    "--mail-counter-url", COUNTER, "--mail-trigger-file", privateFile("trigger.txt", "trigger@fixture.invalid"), ...extra,
  ];
}

const summary = () => JSON.parse(outs[outs.length - 1]);
const statusOf = (name: string) => summary().checks.find((c: { name: string }) => c.name === name)?.status;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lanee-rv-"));
  outs = [];
  errs = [];
  seen = [];
  sql = [];
  queued = 0;
  counter = 0;
  vercel = { ok: true, stdout: `Fetching...\n${JSON.stringify({ targets: { production: { readyState: "READY", meta: { githubCommitSha: SHA } } } })}` };
  migrationRows = MIGRATIONS.map((m) => ({ migration_name: m, finished_at: new Date(), rolled_back_at: null }));
  routes = {
    "GET /api/health": () => jsonRes(200, { status: "ok", db: "ok", timestamp: "t" }),
    "GET /api/tenant/fixture-club": () => jsonRes(200, { name: "Fixture", emailDelivery: "off" }),
    "GET /api/admin/activity": (init) =>
      init.headers?.cookie === `matflow_op_session=${SESSION}` ? jsonRes(200, { rows: [] }) : jsonRes(403, { error: "Forbidden" }),
    "POST /api/admin/auth/login": () => jsonRes(403, { error: "Shared-secret sign-in is disabled. Sign in with your operator account." }),
    "POST /api/auth/forgot-password": () => jsonRes(200, { ok: true }),
    "GET /__count": () => jsonRes(200, { count: counter }),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("release-verify: production target", () => {
  it("passes when every assertion holds, and prints neither the session nor any credential", async () => {
    expect(await s.main(prodArgs(), deps())).toBe(0);
    const sum = summary();
    expect(sum.result).toBe("PASS");
    expect(sum.checks.map((c: { name: string }) => c.name)).toEqual([
      "vercel.production_sha", "health", "migrations.applied", "tenant.email_delivery_off",
      "legacy.header", "legacy.cookie", "legacy.login_post", "operator.access",
    ]);
    expect(sum.legacyCredential).toBe("random well-formed");
    const printed = outs.join("\n") + errs.join("\n");
    expect(printed).not.toContain(SESSION);
    // The random credential was well-formed (64 hex, like openssl rand -hex 32) and not printed.
    const sent = seen.find((x) => x.init.headers?.["x-admin-secret"])!.init.headers!["x-admin-secret"];
    expect(sent).toMatch(/^[0-9a-f]{64}$/);
    expect(printed).not.toContain(sent);
    const login = seen.find((x) => x.url.endsWith("/api/admin/auth/login"))!;
    expect(JSON.parse(String(login.init.body))).toEqual({ secret: sent });
    expect(login.init.headers?.origin).toBe(PROD);
    expect(seen.find((x) => x.init.headers?.cookie === `matflow_admin=${sent}`)).toBeTruthy();
  });

  describe("Vercel project id source (SF-94: hermetic, no dependency on the checkout's .vercel/)", () => {
    const withoutFlag = () => { const a = prodArgs(); a.splice(a.indexOf("--vercel-project"), 2); return a; };
    let root: string;
    let asked: string[];
    const spyVercel = async (id: string) => { asked.push(id); return vercel; };
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "secf3-rv-root-")); asked = []; });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("--vercel-project is what the Vercel API is asked about", async () => {
      expect(await s.main(prodArgs(), deps({ runVercel: spyVercel }))).toBe(0);
      expect(asked).toEqual([FIXTURE_PROJECT]);
    });
    it("without the flag the id is read from <repo root>/.vercel/project.json (temporary root)", async () => {
      fs.mkdirSync(path.join(root, ".vercel"));
      fs.writeFileSync(path.join(root, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_fromfile0123", orgId: "team_fixture" }));
      expect(await s.main(withoutFlag(), deps({ runVercel: spyVercel, repoRoot: root }))).toBe(0);
      expect(asked).toEqual(["prj_fromfile0123"]);
      expect(statusOf("vercel.production_sha")).toBe("PASS");
    });
    it("without the flag and without .vercel/project.json the check FAILS closed and the API is never called", async () => {
      expect(await s.main(withoutFlag(), deps({ runVercel: spyVercel, repoRoot: root }))).toBe(1);
      expect(asked).toEqual([]);
      expect(summary().checks.find((c: { name: string }) => c.name === "vercel.production_sha")).toMatchObject({ status: "FAIL" });
    });
    it("a malformed project id is refused the same way", async () => {
      fs.mkdirSync(path.join(root, ".vercel"));
      fs.writeFileSync(path.join(root, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_x; rm -rf /" }));
      expect(await s.main(withoutFlag(), deps({ runVercel: spyVercel, repoRoot: root }))).toBe(1);
      expect(asked).toEqual([]);
    });
  });

  it("reads migrations in a read-only transaction with a timeout", async () => {
    await s.main(prodArgs(), deps());
    expect(sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(sql[1]).toMatch(/SET LOCAL statement_timeout/);
    expect(sql).toContain("ROLLBACK");
    for (const q of sql) expect(q).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  const FAILS: [string, string, () => void][] = [
    ["vercel sha differs", "vercel.production_sha", () => { vercel.stdout = JSON.stringify({ targets: { production: { readyState: "READY", meta: { githubCommitSha: "b".repeat(40) } } } }); }],
    ["vercel not READY", "vercel.production_sha", () => { vercel.stdout = JSON.stringify({ targets: { production: { readyState: "BUILDING", meta: { githubCommitSha: SHA } } } }); }],
    ["vercel unparseable", "vercel.production_sha", () => { vercel.stdout = "Error: not logged in"; }],
    ["vercel command failed", "vercel.production_sha", () => { vercel = { ok: false, stdout: "" }; }],
    ["health 503", "health", () => { routes["GET /api/health"] = () => jsonRes(503, { status: "degraded", db: "down" }); }],
    ["health 200 db down", "health", () => { routes["GET /api/health"] = () => jsonRes(200, { status: "ok", db: "down" }); }],
    ["health not JSON", "health", () => { routes["GET /api/health"] = () => ({ status: 200, text: "<html>ok</html>" }); }],
    ["health timeout", "health", () => { routes["GET /api/health"] = () => Object.assign(new Error("timed out"), { name: "TimeoutError" }); }],
    ["health redirect", "health", () => { routes["GET /api/health"] = () => ({ status: 307, text: "" }); }],
    ["migration missing", "migrations.applied", () => { migrationRows = migrationRows.slice(1); }],
    ["migration unfinished", "migrations.applied", () => { migrationRows[0].finished_at = null; }],
    ["migration rolled back", "migrations.applied", () => { migrationRows[0].rolled_back_at = new Date(); }],
    ["email delivery on", "tenant.email_delivery_off", () => { routes["GET /api/tenant/fixture-club"] = () => jsonRes(200, { emailDelivery: "on" }); }],
    ["email delivery absent", "tenant.email_delivery_off", () => { routes["GET /api/tenant/fixture-club"] = () => jsonRes(200, { name: "x" }); }],
    ["tenant 404", "tenant.email_delivery_off", () => { routes["GET /api/tenant/fixture-club"] = () => jsonRes(404, { error: "Not found" }); }],
    ["operator redirect", "operator.access", () => { routes["GET /api/admin/activity"] = (i) => (i.headers?.cookie?.startsWith("matflow_op_session") ? { status: 307, text: "" } : jsonRes(403, { error: "Forbidden" })); }],
    ["operator 403", "operator.access", () => { routes["GET /api/admin/activity"] = () => jsonRes(403, { error: "Forbidden" }); }],
    ["legacy header admitted", "legacy.header", () => { routes["GET /api/admin/activity"] = (i) => (i.headers?.["x-admin-secret"] ? jsonRes(200, { rows: [] }) : jsonRes(403, { error: "Forbidden" })); }],
    ["legacy login admitted", "legacy.login_post", () => { routes["POST /api/admin/auth/login"] = () => jsonRes(200, { ok: true }); }],
  ];
  it.each(FAILS)("%s → %s FAILS, exit 1", async (_l, name, mutate) => {
    mutate();
    expect(await s.main(prodArgs(), deps())).toBe(1);
    expect(summary().result).toBe("FAIL");
    expect(statusOf(name)).toBe("FAIL");
  });

  it("a redirect on the authenticated operator check is named as a redirect, not merely a wrong status", async () => {
    routes["GET /api/admin/activity"] = (i) => (i.headers?.cookie?.startsWith("matflow_op_session") ? { status: 307, text: "" } : jsonRes(403, { error: "Forbidden" }));
    expect(await s.main(prodArgs(), deps())).toBe(1);
    expect(summary().checks.find((c: { name: string }) => c.name === "operator.access").detail).toBe("redirect 307");
  });

  it("a large valid JSON activity page (~60 KB) is parsed whole — operator.access PASSES (AH-G3)", async () => {
    // The real response is ~58 KB; a reader that cut the body at 8 KiB before
    // JSON.parse called it "body not JSON" and failed a correct release.
    const rows = Array.from({ length: 300 }, (_, k) => ({ id: `al_${k}`, action: "admin.something.happened", metadata: { note: "x".repeat(150) } }));
    routes["GET /api/admin/activity"] = (i) =>
      i.headers?.cookie?.startsWith("matflow_op_session") ? jsonRes(200, { rows }) : jsonRes(403, { error: "Forbidden" });
    expect(JSON.stringify({ rows }).length).toBeGreaterThan(8192 * 6);
    expect(await s.main(prodArgs(), deps())).toBe(0);
    expect(statusOf("operator.access")).toBe("PASS");
  });

  it("operator access is required evidence on production: absent → FAIL, not a pass", async () => {
    const a = prodArgs();
    a.splice(a.indexOf("--expect-operator-login"), 3);
    expect(await s.main(a, deps())).toBe(1);
    expect(statusOf("operator.access")).toBe("FAIL");
  });
});

describe("release-verify: legacy transports — the inconclusive mapping", () => {
  const TABLE: [string, Probe, string][] = [
    ["application 403 JSON", { status: 403, contentType: "application/json", bodyText: '{"error":"Forbidden"}' }, "PASS"],
    ["application 401 JSON", { status: 401, contentType: "application/json; charset=utf-8", bodyText: '{"error":"Invalid secret"}' }, "PASS"],
    ["200 = access granted", { status: 200, contentType: "application/json", bodyText: '{"ok":true}' }, "FAIL"],
    ["redirect", { status: 307, contentType: "", bodyText: "" }, "INCONCLUSIVE"],
    ["edge wall (HTML 401)", { status: 401, contentType: "text/html", bodyText: "<html>Authentication Required</html>" }, "INCONCLUSIVE"],
    ["CSRF refusal", { status: 403, contentType: "application/json", bodyText: '{"error":"Forbidden: cross-origin request rejected"}' }, "INCONCLUSIVE"],
    ["missing origin refusal", { status: 403, contentType: "application/json", bodyText: '{"error":"Origin or Referer header required for this request"}' }, "INCONCLUSIVE"],
    ["support read-only refusal", { status: 403, contentType: "application/json", bodyText: '{"ok":false,"error":"x","supportReadOnly":true}' }, "INCONCLUSIVE"],
    ["JSON without error", { status: 403, contentType: "application/json", bodyText: '{"ok":false}' }, "INCONCLUSIVE"],
    ["malformed JSON", { status: 403, contentType: "application/json", bodyText: "{nope" }, "INCONCLUSIVE"],
    ["500", { status: 500, contentType: "application/json", bodyText: '{"error":"x"}' }, "INCONCLUSIVE"],
    ["429", { status: 429, contentType: "application/json", bodyText: '{"error":"Too many"}' }, "INCONCLUSIVE"],
    ["404", { status: 404, contentType: "application/json", bodyText: '{"error":"x"}' }, "INCONCLUSIVE"],
    ["no response", { error: "timeout" }, "INCONCLUSIVE"],
  ];
  it.each(TABLE)("%s → %s", (_l, probe, expected) => {
    expect(s.classifyRefusal(probe).status).toBe(expected);
  });

  it.each([
    ["redirect", { status: 302, text: "" } as Res],
    ["edge wall", { status: 401, text: "<html>Vercel Authentication</html>" } as Res],
    ["5xx", jsonRes(502, { error: "bad gateway" })],
    ["429", jsonRes(429, { error: "Too many login attempts. Try again later." })],
  ])("a %s on the login POST fails the run as INCONCLUSIVE (exit 1)", async (_l, res) => {
    routes["POST /api/admin/auth/login"] = () => res;
    expect(await s.main(prodArgs(), deps())).toBe(1);
    expect(statusOf("legacy.login_post")).toBe("INCONCLUSIVE");
    expect(summary().result).toBe("FAIL");
  });

  it("a network failure on the header probe is INCONCLUSIVE, not a pass", async () => {
    routes["GET /api/admin/activity"] = (i) => (i.headers?.["x-admin-secret"] ? new TypeError("fetch failed") : jsonRes(200, {}));
    expect(await s.main(prodArgs(), deps())).toBe(1);
    expect(statusOf("legacy.header")).toBe("INCONCLUSIVE");
  });
});

describe("release-verify: test target (loopback server, intercepting mail transport)", () => {
  it("sends the REAL legacy credential from the private file to an authorised loopback test server, never printing it", async () => {
    const cred = privateFile("legacy.txt", LEGACY_SECRET);
    expect(await s.main(testArgs(["--legacy-credential-file", cred]), deps())).toBe(0);
    expect(summary().legacyCredential).toBe("real (private file)");
    expect(seen.some((x) => x.init.headers?.["x-admin-secret"] === LEGACY_SECRET)).toBe(true);
    expect(seen.some((x) => x.init.headers?.cookie === `matflow_admin=${LEGACY_SECRET}`)).toBe(true);
    expect(outs.join("") + errs.join("")).not.toContain(LEGACY_SECRET);
    expect(statusOf("vercel.production_sha")).toBe("SKIPPED");
    expect(statusOf("operator.access")).toBe("SKIPPED");
    expect(statusOf("mail.transport_untouched")).toBe("PASS");
    expect(statusOf("mail.queue_empty")).toBe("PASS");
  });

  it("a development server that still honours the secret is caught (FAIL, exit 1)", async () => {
    routes["GET /api/admin/activity"] = (i) => (i.headers?.["x-admin-secret"] === LEGACY_SECRET ? jsonRes(200, { rows: [] }) : jsonRes(403, { error: "Forbidden" }));
    const cred = privateFile("legacy.txt", LEGACY_SECRET);
    expect(await s.main(testArgs(["--legacy-credential-file", cred]), deps())).toBe(1);
    expect(statusOf("legacy.header")).toBe("FAIL");
  });

  it("mail: a send that reached the transport fails; a queued row fails; a trigger that was refused is inconclusive", async () => {
    routes["POST /api/auth/forgot-password"] = () => { counter = 1; return jsonRes(200, { ok: true }); };
    expect(await s.main(testArgs(), deps())).toBe(1);
    expect(statusOf("mail.transport_untouched")).toBe("FAIL");

    counter = 0;
    routes["POST /api/auth/forgot-password"] = () => jsonRes(200, { ok: true });
    queued = 1;
    expect(await s.main(testArgs(), deps())).toBe(1);
    expect(statusOf("mail.queue_empty")).toBe("FAIL");

    queued = 0;
    routes["POST /api/auth/forgot-password"] = () => jsonRes(429, { error: "Too many" });
    expect(await s.main(testArgs(), deps())).toBe(1);
    expect(statusOf("mail.transport_untouched")).toBe("INCONCLUSIVE");

    routes["POST /api/auth/forgot-password"] = () => jsonRes(200, { ok: true });
    delete routes["GET /__count"];
    expect(await s.main(testArgs(), deps())).toBe(1);
    expect(statusOf("mail.transport_untouched")).toBe("FAIL");
  });

  it("the interceptor counts every POST and discards the body", async () => {
    const logs: string[] = [];
    const server = s.startMailInterceptor(0, (x) => logs.push(x));
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const before = await (await fetch(`http://127.0.0.1:${port}/__count`)).json();
      await fetch(`http://127.0.0.1:${port}/emails`, { method: "POST", body: JSON.stringify({ to: "x@fixture.invalid", html: "secret-body" }) });
      const after = await (await fetch(`http://127.0.0.1:${port}/__count`)).json();
      expect(before).toEqual({ count: 0 });
      expect(after).toEqual({ count: 1 });
      expect(logs.join("")).not.toContain("secret-body");
      expect(logs.join("")).not.toContain("x@fixture.invalid");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("release-verify: refusals (exit 2)", () => {
  it.each([
    ["short sha", (a: string[]) => { a[a.indexOf("--sha") + 1] = "abc123"; }],
    ["host guard mismatch", (a: string[]) => { a[a.indexOf("--expect-host") + 1] = "ep-bold-wave-abt39t7x"; }],
    ["host guard substring", (a: string[]) => { a[a.indexOf("--expect-host") + 1] = "ep-fixture-salad"; }],
    ["no expect-host", (a: string[]) => { a.splice(a.indexOf("--expect-host"), 2); }],
    ["http production", (a: string[]) => { a[a.indexOf("--base-url") + 1] = "http://release.fixture.invalid"; }],
    ["malformed migration name", (a: string[]) => { a[a.indexOf("--expect-migrations") + 1] = "not-a-migration"; }],
    ["real credential to production", (a: string[]) => { a.push("--legacy-credential-file", privateFile("legacy.txt", LEGACY_SECRET)); }],
    ["mail interceptor on production", (a: string[]) => { a.push("--mail-counter-url", COUNTER); }],
    ["session file inside the repo", (a: string[]) => { a[a.indexOf("--operator-session-file") + 1] = path.join(process.cwd(), "package.json"); }],
    ["expect login without a session file", (a: string[]) => { a.splice(a.indexOf("--operator-session-file"), 2); }],
  ])("%s", async (_l, mutate) => {
    const a = prodArgs();
    mutate(a);
    let connected = false;
    expect(await s.main(a, deps({ connect: async () => { connected = true; return client; } }))).toBe(2);
    expect(summary().result).toBe("REFUSED");
    expect(connected).toBe(false);
    expect(seen).toHaveLength(0);
    expect(outs.join("") + errs.join("")).not.toContain(LEGACY_SECRET);
  });

  it("a test target must be loopback and must observe the mail boundary", async () => {
    const a = testArgs();
    a[a.indexOf("--base-url") + 1] = "https://preview.fixture.invalid";
    expect(await s.main(a, deps())).toBe(2);
    const b = testArgs();
    b.splice(b.indexOf("--mail-counter-url"), 2);
    expect(await s.main(b, deps())).toBe(2);
  });

  it("--expect-migrations local lists every migration directory in the repository", () => {
    const names = s.expectedMigrations("local");
    expect(names).toContain("20261009010000_audit_operator_request");
    expect(names.length).toBeGreaterThan(50);
  });
});
