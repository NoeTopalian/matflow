// Operator allowlist, legacy transports, provisioning, session precedence and
// rate-limit inventory (admin hub lane B, 9 Oct 2026; ledger AH-02, AH-B1..B3).
//
// Before: "only Noe can operate" meant "only one Operator row exists". A second
// row with a password and an enrolled authenticator passed every operator gate
// (red run of tests/unit/operator-endpoint-authz-matrix.test.ts, 9 Oct 2026:
// "Tests  10 failed | 182 passed (192)" — the second operator reached the DB).
// Now OPERATOR_ALLOWED_IDS names the Operator.ids that may hold operator
// authority; production with an unset list means nobody.
//
// The per-route matrix lives in operator-endpoint-authz-matrix.test.ts. This
// file pins the pieces around it: the rule itself, the edge mirror, the
// refusal row, the session-mint points, sign-out, the proxy precedence when a
// support session and an operator session share a browser, and static scans
// for the legacy shared-secret transports and for public provisioning.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "operator-allowlist-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    ops: new Map<string, Record<string, unknown>>(),
    audit: [] as Array<Record<string, unknown>>,
    auditFail: false,
    rlDenied: false,
    rlBuckets: [] as string[],
  };
});

type Row = Record<string, unknown>;
function matches(row: Row, where: Row): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Row[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { lt?: number; gt?: Date };
      if (c.lt !== undefined && !(typeof v === "number" && v < c.lt)) return false;
      if (c.gt !== undefined && !(v instanceof Date && v.getTime() > c.gt.getTime())) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}
function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as Row)) row[k] = Number(row[k] ?? 0) + Number((v as { increment: number }).increment);
    else row[k] = v;
  }
}

vi.mock("@/lib/prisma", () => {
  const find = (where: Row) => [...h.ops.values()].find((r) => matches(r, where));
  return {
    prisma: {
      operator: {
        findUnique: async ({ where }: { where: Row }) => { const r = find(where); return r ? { ...r } : null; },
        update: async ({ where, data }: { where: Row; data: Row }) => { const r = find(where)!; apply(r, data); return { ...r }; },
        updateMany: async ({ where, data }: { where: Row; data: Row }) => {
          let count = 0;
          for (const r of h.ops.values()) if (matches(r, where)) { apply(r, data); count++; }
          return { count };
        },
      },
    },
  };
});
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async () => { throw new Error("DB transaction reached"); },
  withTenantContext: async () => { throw new Error("DB transaction reached"); },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async (bucket: string) => {
    h.rlBuckets.push(bucket);
    return h.rlDenied ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true, retryAfterSeconds: 0 };
  },
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async (a: Record<string, unknown>) => {
    if (h.auditFail) throw new Error("audit store unavailable");
    h.audit.push(a);
  },
}));
vi.mock("@/auth", () => ({ auth: (fn: unknown) => fn }));

import {
  OPERATOR_REFUSED_MESSAGE,
  isOperatorAllowed,
  isProductionLikeProcess,
  issueOperatorEnrolmentSession,
  issueOperatorSession,
  issueOperatorTotpChallenge,
  newOperatorEnrolmentTicket,
  operatorIdDigest,
  resolveOperatorFromCookie,
} from "@/lib/operator-auth";
import { sharedAdminSecretPermitted } from "@/lib/admin-auth";
import { operatorAllowedAtEdge } from "../../proxy";

const ORIGIN = "http://localhost:3847";
const ENV_KEYS = ["NODE_ENV", "VERCEL_ENV", "DATABASE_URL", "OPERATOR_ALLOWED_IDS"];
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const PROD_DB = "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.example/neondb";

function setEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() { setEnv(saved); delete process.env.OPERATOR_ALLOWED_IDS; }

function req(path: string, method = "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}
const liveSetCookies = (res: Response) =>
  res.headers.getSetCookie().filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split("=")[0]);

function seed(over: Row = {}): Row {
  const row: Row = {
    id: "op-second", email: "second@example.test", name: "Second", passwordHash: "x", role: "super_admin",
    totpEnabled: true, totpSecret: generateSecret(), totpLastUsedStep: null, failedLoginCount: 0, lockedUntil: null,
    sessionVersion: 2, enrolmentTicketHash: null, enrolmentTicketExpiresAt: null, lastLoginAt: null, ...over,
  };
  h.ops.set(row.id as string, row);
  return row;
}

beforeEach(() => {
  h.jar.clear();
  h.ops.clear();
  h.audit.length = 0;
  h.auditFail = false;
  h.rlDenied = false;
  h.rlBuckets.length = 0;
  restoreEnv();
});
afterEach(() => restoreEnv());

// ── 1. the rule ────────────────────────────────────────────────────────────
const SHAPES: Array<[string, Record<string, string | undefined>, boolean]> = [
  ["development/test", {}, false],
  ["NODE_ENV=production", { NODE_ENV: "production" }, true],
  ["VERCEL_ENV=production", { VERCEL_ENV: "production" }, true],
  ["the production database", { DATABASE_URL: PROD_DB }, true],
];
const LISTS: Array<[string | undefined, string, boolean | "env"]> = [
  [undefined, "op-a", "env"],
  ["", "op-a", "env"],
  ["   ", "op-a", "env"],
  [",", "op-a", false],
  [" , , ", "op-a", false],
  ["op-a", "op-a", true],
  [" op-b ,op-a ", "op-a", true],
  ["op-a", "op-b", false],
  ["op-a", "OP-A", false],
  ["op-a", "op-", false],
  ["op-a", "op-ab", false],
  ["op-a;op-b", "op-a", false],
  ["op-a", "", false],
];

describe("isOperatorAllowed: production with no list means nobody; a set list is enforced everywhere", () => {
  for (const [label, env, productionLike] of SHAPES) {
    it.each(LISTS)(`${label}: OPERATOR_ALLOWED_IDS=%j, id %j`, (list, id, expected) => {
      setEnv({ ...env, OPERATOR_ALLOWED_IDS: list });
      const want = expected === "env" ? !productionLike : expected;
      expect(isOperatorAllowed(id)).toBe(want);
      // The edge mirror in proxy.ts must give the same answer.
      expect(operatorAllowedAtEdge(id)).toBe(want);
    });
  }

  it("agrees with the shared-secret gate (and its edge copy) on what production is", () => {
    for (const [, env, productionLike] of SHAPES) {
      setEnv({ ...env, OPERATOR_ALLOWED_IDS: undefined });
      expect(isProductionLikeProcess()).toBe(productionLike);
      expect(sharedAdminSecretPermitted()).toBe(!productionLike);
      expect(isOperatorAllowed("anyone")).toBe(!productionLike);
      expect(operatorAllowedAtEdge("anyone")).toBe(!productionLike);
      restoreEnv();
    }
  });
});

// ── 2. the shared resolver: refusal after the MFA checks, one durable row ──
describe("resolveOperatorFromCookie refuses a non-allow-listed operator and records it", () => {
  it("refuses, writes ONE admin.operator.refused row with a keyed digest (never the raw id) per request", async () => {
    seed();
    setEnv({ OPERATOR_ALLOWED_IDS: "op-noe" });
    const token = issueOperatorSession("op-second", 2);
    const r = req("/api/admin/activity", "GET");
    expect(await resolveOperatorFromCookie(token, { req: r })).toBeNull();
    expect(await resolveOperatorFromCookie(token, { req: r })).toBeNull();
    expect(h.audit).toHaveLength(1);
    const row = h.audit[0];
    expect(row).toMatchObject({
      tenantId: null,
      action: "admin.operator.refused",
      entityType: "Operator",
      entityId: operatorIdDigest("op-second"),
      durable: true,
      outcome: "refused",
      metadata: { reason: "not_allowlisted", stage: "session" },
    });
    expect(JSON.stringify({ ...row, req: undefined })).not.toContain("op-second");
    expect(operatorIdDigest("op-second")).toMatch(/^opd_[0-9a-f]{32}$/);
    expect(operatorIdDigest("op-second")).not.toBe(operatorIdDigest("op-noe"));
    // A second request is a second row.
    await resolveOperatorFromCookie(token, { req: req("/api/admin/activity", "GET") });
    expect(h.audit).toHaveLength(2);
  });

  it("the refusal stands when the row cannot be written", async () => {
    seed();
    setEnv({ OPERATOR_ALLOWED_IDS: "op-noe" });
    h.auditFail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveOperatorFromCookie(issueOperatorSession("op-second", 2))).toBeNull();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("op-second");
    errors.mockRestore();
  });

  it("invalid sessions are refused BEFORE the allowlist (no row): revoked, TOTP off, challenge token", async () => {
    seed();
    setEnv({ OPERATOR_ALLOWED_IDS: "op-noe" });
    expect(await resolveOperatorFromCookie(issueOperatorSession("op-second", 1))).toBeNull();
    expect(await resolveOperatorFromCookie(issueOperatorTotpChallenge("op-second", 2))).toBeNull();
    h.ops.get("op-second")!.totpEnabled = false;
    expect(await resolveOperatorFromCookie(issueOperatorSession("op-second", 2))).toBeNull();
    expect(h.audit).toEqual([]);
  });

  it("positive control: the allow-listed operator resolves, no row", async () => {
    seed({ id: "op-noe" });
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    expect(await resolveOperatorFromCookie(issueOperatorSession("op-noe", 2))).toMatchObject({ id: "op-noe" });
    expect(h.audit).toEqual([]);
  });
});

// ── 3. session mint: a non-allow-listed operator never gets a session ─────
describe("session mint is refused for a non-allow-listed operator", () => {
  it("operator-totp: right code, not allow-listed → 403, no session cookie, no sign-in row, refusal row", async () => {
    const op = seed();
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    h.jar.set("matflow_op_challenge", issueOperatorTotpChallenge("op-second", 2));
    const { POST } = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret: op.totpSecret as string }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(OPERATOR_REFUSED_MESSAGE);
    expect(liveSetCookies(res)).toEqual([]);
    expect(h.audit.map((a) => a.action)).toEqual(["admin.operator.refused"]);
    expect(h.audit[0].metadata).toEqual({ reason: "not_allowlisted", stage: "session_mint" });
    // The code was spent: it cannot be replayed once the operator is allow-listed.
    expect(h.ops.get("op-second")!.totpLastUsedStep).not.toBeNull();
    expect(h.ops.get("op-second")!.lastLoginAt).toBeNull();
  });

  it("operator-totp positive control: allow-listed → session minted, sign-in row", async () => {
    const op = seed({ id: "op-noe" });
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    h.jar.set("matflow_op_challenge", issueOperatorTotpChallenge("op-noe", 2));
    const { POST } = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret: op.totpSecret as string }) }));
    expect(res.status).toBe(200);
    expect(liveSetCookies(res)).toContain("matflow_op_session");
    expect(h.audit.map((a) => a.action)).toEqual(["admin.operator.signed_in"]);
  });

  it("enrolment (GET and POST) with a valid ticket: not allow-listed → 403, nothing written, ticket unspent", async () => {
    const t = newOperatorEnrolmentTicket();
    seed({ totpEnabled: false, totpSecret: null, enrolmentTicketHash: t.hash, enrolmentTicketExpiresAt: t.expiresAt });
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    h.jar.set("matflow_op_enrol", issueOperatorEnrolmentSession("op-second", 2));
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const g = await setup.GET(req("/api/admin/auth/operator-totp/setup", "GET", undefined, { "x-matflow-enrolment-ticket": t.ticket }));
    expect(g.status).toBe(403);
    const p = await setup.POST(req("/api/admin/auth/operator-totp/setup", "POST", { code: "123456", ticket: t.ticket }));
    expect(p.status).toBe(403);
    expect(liveSetCookies(p)).toEqual([]);
    const row = h.ops.get("op-second")!;
    expect(row).toMatchObject({ totpEnabled: false, totpSecret: null, enrolmentTicketHash: t.hash, sessionVersion: 2 });
    expect(h.audit.map((a) => (a.metadata as Row).stage)).toEqual(["enrolment", "enrolment"]);
  });

  it("enrolment GET positive control: allow-listed → QR issued", async () => {
    const t = newOperatorEnrolmentTicket();
    seed({ id: "op-noe", totpEnabled: false, totpSecret: null, enrolmentTicketHash: t.hash, enrolmentTicketExpiresAt: t.expiresAt });
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    h.jar.set("matflow_op_enrol", issueOperatorEnrolmentSession("op-noe", 2));
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const g = await setup.GET(req("/api/admin/auth/operator-totp/setup", "GET", undefined, { "x-matflow-enrolment-ticket": t.ticket }));
    expect(g.status).toBe(200);
    expect((await g.json()).alreadyEnabled).toBe(false);
  });

  it("sign-out still revokes a non-allow-listed operator's session (bump, no refusal row)", async () => {
    seed();
    setEnv({ NODE_ENV: "production", OPERATOR_ALLOWED_IDS: "op-noe" });
    h.jar.set("matflow_op_session", issueOperatorSession("op-second", 2));
    const { POST } = await import("@/app/api/admin/auth/logout/route");
    const res = await POST(req("/api/admin/auth/logout"));
    expect(res.status).toBe(200);
    expect(h.ops.get("op-second")!.sessionVersion).toBe(3);
    expect(h.audit).toEqual([]);
  });
});

// ── 4. proxy: the edge fence and session precedence ───────────────────────
async function proxyRun(method: string, pathname: string, cookies: Record<string, string>, auth: unknown) {
  const mod = await import("../../proxy");
  const proxy = mod.default as unknown as (r: unknown) => Promise<Response>;
  const url = ORIGIN + pathname;
  return proxy({
    method,
    nextUrl: new URL(url),
    url,
    headers: new Headers(),
    cookies: { get: (n: string) => (n in cookies ? { name: n, value: cookies[n] } : undefined) },
    auth,
  });
}
const passThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
const redirectPath = (res: Response) => (res.status === 307 ? new URL(res.headers.get("location")!).pathname : null);

describe("proxy /admin fence follows the allowlist", () => {
  it("a well-signed MFA session of a non-allow-listed operator is sent to /admin/login", async () => {
    setEnv({ OPERATOR_ALLOWED_IDS: "op-noe" });
    expect(redirectPath(await proxyRun("GET", "/admin/tenants", { matflow_op_session: issueOperatorSession("op-second", 0) }, null))).toBe("/admin/login");
    expect(passThrough(await proxyRun("GET", "/admin/tenants", { matflow_op_session: issueOperatorSession("op-noe", 0) }, null))).toBe(true);
  });
  it("production with no list: nobody passes the fence", async () => {
    setEnv({ VERCEL_ENV: "production", OPERATOR_ALLOWED_IDS: undefined });
    expect(redirectPath(await proxyRun("GET", "/admin", { matflow_op_session: issueOperatorSession("op-noe", 0) }, null))).toBe("/admin/login");
  });
});

const ROOT = process.cwd();
function walk(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, name, out);
    else if (entry === name) out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}
const CLUB_UNDER_API_ADMIN = /^app\/api\/admin\/(import|dsar|email)\//;
const OPERATOR_API_PATHS = walk(join(ROOT, "app/api/admin"), "route.ts")
  .filter((f) => !CLUB_UNDER_API_ADMIN.test(f))
  .map((f) => "/" + f.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, "fixture-$1"));
const OPERATOR_PAGES = walk(join(ROOT, "app/admin"), "page.tsx").map((f) =>
  ("/" + f.replace(/^app\//, "").replace(/\/?page\.tsx$/, "")).replace(/\[(\w+)\]/g, "fixture-$1"),
);
const EXITS = new Set(["DELETE /api/admin/impersonate", "POST /api/admin/auth/logout"]);

describe("session precedence: a browser holding a support session AND an operator session", () => {
  // Support (impersonation) identity on the club side; a valid, allow-listed
  // operator session cookie alongside it.
  const support = { user: { id: "u-owner", tenantId: "t-club", role: "owner", impersonatedBy: "op-noe" } };
  const both = () => ({ matflow_op_session: issueOperatorSession("op-noe", 0), matflow_impersonation: "signed-support-cookie" });

  it("the operator plane refuses the support context on every operator route and method (exits aside)", async () => {
    setEnv({ OPERATOR_ALLOWED_IDS: "op-noe" });
    expect(OPERATOR_API_PATHS.length).toBeGreaterThan(15);
    for (const path of OPERATOR_API_PATHS) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const res = await proxyRun(method, path, both(), support);
        if (EXITS.has(`${method} ${path}`)) {
          expect(passThrough(res), `${method} ${path} (exit)`).toBe(true);
          continue;
        }
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).supportReadOnly, `${method} ${path}`).toBe(true);
      }
    }
  });

  it("operator pages send the support browser back to the club view", async () => {
    expect(OPERATOR_PAGES).toContain("/admin");
    for (const page of OPERATOR_PAGES.filter((p) => p !== "/admin/login")) {
      expect(redirectPath(await proxyRun("GET", page, both(), support)), page).toBe("/dashboard");
    }
  });

  it("the club plane gives the operator cookie no power: support stays read-only, and an operator cookie alone is no club session", async () => {
    for (const path of ["/api/members", "/api/settings", "/api/staff", "/api/payments/p1/refund"]) {
      const withSupport = await proxyRun("POST", path, both(), support);
      expect(withSupport.status, path).toBe(403);
      const operatorOnly = await proxyRun("POST", path, { matflow_op_session: issueOperatorSession("op-noe", 0) }, null);
      expect(operatorOnly.status, path).toBe(401);
    }
    expect(redirectPath(await proxyRun("GET", "/dashboard", { matflow_op_session: issueOperatorSession("op-noe", 0) }, null))).toBe("/login");
  });

  it("only the operator plane and the support binding read the operator session cookie", () => {
    const readers = ["app", "lib", "components"].flatMap((d) => [...walk(join(ROOT, d), "route.ts"), ...walkTs(join(ROOT, d))])
      .filter((f, i, a) => a.indexOf(f) === i)
      .filter((f) => /OP_SESSION_COOKIE|matflow_op_session|resolveOperatorFromCookie|verifyOperatorSession/.test(code(f)));
    for (const f of readers) {
      expect(
        f.startsWith("app/api/admin/") || f.startsWith("app/admin/") ||
          // operator-plane libraries (auth, context, step-up) and the support
          // binding, which checks the support session against the operator's own.
          /^lib\/operator-[a-z-]+\.ts$/.test(f) ||
          ["lib/admin-auth.ts", "lib/impersonation.ts"].includes(f),
        `${f} reads the operator session outside the operator plane`,
      ).toBe(true);
    }
  });
});

// ── 5. static scans: legacy transports, provisioning, rate limits, pages ──
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}
/** Source with comments removed, so a mention in prose is not a read. */
function code(file: string): string {
  return readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
const SOURCES = ["app", "lib", "components"].flatMap((d) => walkTs(join(ROOT, d))).concat(["proxy.ts", "auth.ts"]);

describe("legacy shared-secret transports: inventory", () => {
  it("MATFLOW_ADMIN_SECRET is read only by the gate, the edge mirror and the development sign-in route", () => {
    const readers = SOURCES.filter((f) => /process\.env\.MATFLOW_ADMIN_SECRET|process\.env\[["']MATFLOW_ADMIN_SECRET/.test(code(f)));
    expect(readers.sort()).toEqual(["app/api/admin/auth/login/route.ts", "lib/admin-auth.ts", "proxy.ts"]);
  });

  it("the x-admin-secret header is compared only in lib/admin-auth.ts (audit-log reads it to LABEL a dev row)", () => {
    const readers = SOURCES.filter((f) => /headers\.get\(\s*["']x-admin-secret["']\s*\)/.test(code(f)));
    expect(readers.sort()).toEqual(["lib/admin-auth.ts", "lib/audit-log.ts"]);
    expect(code("lib/audit-log.ts")).not.toMatch(/MATFLOW_ADMIN_SECRET|constantTimeEq/);
  });

  it("the matflow_admin cookie is read only by lib/admin-auth.ts and the proxy fence", () => {
    const readers = SOURCES.filter((f) => /\.get\(\s*(ADMIN_COOKIE|["']matflow_admin["'])\s*\)/.test(code(f)));
    expect(readers.sort()).toEqual(["lib/admin-auth.ts", "proxy.ts"]);
  });

  it("no source reads a secret from a query string, and no operator route reads one from the body", () => {
    const query = SOURCES.filter((f) =>
      /searchParams\.get\(\s*["'](secret|adminSecret|admin_secret|x-admin-secret|matflow_admin|token)["']/.test(code(f)) &&
      (f.startsWith("app/api/admin/") || f.startsWith("app/admin/") || f.startsWith("lib/admin") || f.startsWith("lib/operator")),
    );
    expect(query).toEqual([]);
    const body = walk(join(ROOT, "app/api/admin"), "route.ts").filter((f) => /\bsecret\s*:\s*z\./.test(code(f)));
    expect(body).toEqual(["app/api/admin/auth/login/route.ts"]);
  });

  it("the development sign-in route refuses in production BEFORE reading the body", async () => {
    const { POST } = await import("@/app/api/admin/auth/login/route");
    for (const env of [{ NODE_ENV: "production" }, { VERCEL_ENV: "production" }, { DATABASE_URL: PROD_DB }]) {
      setEnv(env);
      const json = vi.fn(async () => ({ secret: "anything" }));
      const fake = { headers: new Headers({ origin: ORIGIN, host: "localhost:3847" }), method: "POST", url: ORIGIN + "/api/admin/auth/login", json } as unknown as Request;
      const res = await POST(fake);
      expect(res.status).toBe(403);
      expect(json).not.toHaveBeenCalled();
      expect(liveSetCookies(res)).toEqual([]);
      restoreEnv();
    }
  });
});

describe("provisioning: no HTTP path creates an Operator", () => {
  it("no file under app/, lib/ or components/ creates, upserts or inserts an Operator", () => {
    const creators = SOURCES.filter((f) => /\boperator\.(create|createMany|upsert)\s*\(|INSERT\s+INTO\s+"?Operator"?/i.test(code(f)));
    expect(creators).toEqual([]);
  });
  it("only the local scripts (direct database credentials) create operators", () => {
    const scripts = walkTs(join(ROOT, "scripts")).filter((f) => /\boperator\.(create|createMany|upsert)\s*\(/.test(code(f)));
    expect(scripts.sort()).toEqual(["scripts/operator-access.mjs", "scripts/seed-operator-noe.mjs"]);
  });
});

describe("rate limits: every operator credential door has a DB-backed bucket", () => {
  const BUCKETS: Array<[string, string[]]> = [
    ["app/api/admin/auth/operator-login/route.ts", ["admin:operator-login:"]],
    ["app/api/admin/auth/operator-totp/route.ts", ["admin:operator-totp-ip:", "admin:operator-totp:"]],
    ["app/api/admin/auth/operator-totp/setup/route.ts", ["admin:operator-totp-setup-ip:", "admin:operator-totp-setup:"]],
    ["app/api/admin/auth/step-up/route.ts", ["admin:operator-step-up:"]],
    ["app/api/admin/auth/login/route.ts", ["admin:login:"]],
  ];
  it.each(BUCKETS)("%s", (file, buckets) => {
    const src = code(file);
    for (const b of buckets) expect(src, `${file} lacks ${b}`).toContain(b);
    expect(src).toMatch(/checkRateLimit\(/);
  });
  it("checkRateLimit counts in the database first (cross-instance); memory only if the DB is unreachable", () => {
    const src = code("lib/rate-limit.ts");
    expect(src).toMatch(/prisma\.rateLimitHit\.groupBy/);
    expect(src).toMatch(/result = await checkDbRateLimit\(/);
  });
  it("setup GET and POST answer 429 from the per-IP bucket, before any cookie or ticket is examined", async () => {
    h.rlDenied = true;
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    expect((await setup.GET(req("/api/admin/auth/operator-totp/setup", "GET"))).status).toBe(429);
    expect((await setup.POST(req("/api/admin/auth/operator-totp/setup", "POST", { code: "123456" }))).status).toBe(429);
    expect(h.rlBuckets).toEqual(["admin:operator-totp-setup-ip:203.0.113.9", "admin:operator-totp-setup-ip:203.0.113.9"]);
  });
});

describe("operator pages: every /admin page runs the server-side gate", () => {
  it.each(walk(join(ROOT, "app/admin"), "page.tsx").filter((f) => f !== "app/admin/login/page.tsx"))("%s", (file) => {
    expect(code(file)).toMatch(/if \(!\(await isAdminPageAuthed\(\)\)\) redirect\("\/admin\/login"\)/);
  });
});
