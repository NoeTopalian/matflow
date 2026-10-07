// Operator-plane authorisation matrix (opsec audit, 5 Oct 2026).
//
// proxy.ts lists "/api/admin" in PUBLIC_PREFIXES, so the edge does NOTHING for
// any route under app/api/admin/**. Every operator route has to refuse
// non-operators by itself. This file enumerates the route files from disk
// (a new file that is not classified below fails the suite), imports every
// exported HTTP handler, and drives it as:
//
//   - nobody (no cookies, no session)
//   - a club owner / manager / coach / member holding a real-looking NextAuth
//     session (auth() resolves, the authjs session cookie is present)
//   - a club owner who also presents a WRONG admin secret (cookie + header)
//
// and asserts each is refused (401/403) AND that nothing downstream ran: no DB
// call, no audit row, no email, no Stripe call, no cookie minted.
//
// Positive controls prove the gate is the thing doing the refusing (the test
// is not vacuous): an MFA-verified operator session gets PAST the gate
// everywhere; the shared secret (cookie / header) gets past it in a
// development/test process ONLY.
//
// Operator auth hardening (lane A, 6 Oct 2026) flipped the audit's pinning
// controls: "the bootstrap secret alone opens every shared-secret operator
// route" is now asserted for development/test only, and a new block asserts
// that in PRODUCTION (NODE_ENV=production, VERCEL_ENV=production, or the
// production database) the secret opens nothing — even with
// ALLOW_ADMIN_SECRET_HEADER=1. Enrolment, challenge, pre-hardening, expired,
// tampered and TOTP-less sessions are refused everywhere.
//
// Every request is same-origin, so CSRF never answers in place of the auth gate.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ── shared mutable state the mocks read ────────────────────────────────────
const state = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  session: null as null | { user: Record<string, unknown> },
  sideEffects: [] as string[],
  operatorRow: null as null | Record<string, unknown>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    getAll: () => [...state.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (name: string) => state.jar.has(name),
    set: (name: string) => { state.sideEffects.push(`cookie.set:${name}`); },
    delete: (name: string) => { state.sideEffects.push(`cookie.delete:${name}`); },
  }),
  headers: async () => new Headers(),
}));

// Club-side identity. Operator gates must ignore this entirely.
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => state.session),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

// Any DB access at all is a side effect the gate should have prevented —
// except the Operator lookup a v1.5 session needs to resolve itself.
function dbProxy(label: string): unknown {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      if (label === "prisma" && prop === "operator") {
        return {
          findUnique: async () => state.operatorRow,
          update: async () => { state.sideEffects.push("db:operator.update"); return state.operatorRow; },
          updateMany: async () => { state.sideEffects.push("db:operator.updateMany"); return { count: 0 }; },
        };
      }
      return dbProxy(`${label}.${String(prop)}`);
    },
    apply() {
      state.sideEffects.push(`db:${label}`);
      throw new Error(`DB touched: ${label}`);
    },
  });
}

vi.mock("@/lib/prisma", () => ({ prisma: dbProxy("prisma") }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async () => { state.sideEffects.push("db:withRlsBypass"); throw new Error("DB touched: withRlsBypass"); },
  withTenantContext: async () => { state.sideEffects.push("db:withTenantContext"); throw new Error("DB touched: withTenantContext"); },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async () => { state.sideEffects.push("audit"); return {}; },
}));
vi.mock("@/lib/email", () => ({
  sendEmail: async () => { state.sideEffects.push("email"); return { ok: true }; },
}));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: async () => { state.sideEffects.push("stripe"); return { ok: true }; },
}));

// Real: lib/admin-auth, lib/operator-auth, lib/operator-context, lib/csrf,
// lib/impersonation — those ARE the gates under test.
import { issueOperatorSession } from "@/lib/operator-auth";

// ── enumerate the route files ──────────────────────────────────────────────
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry === "route.ts") out.push(relative(ROOT, full).replace(/\\/g, "/"));
  }
  return out;
}
const ALL_ROUTES = walk(join(ROOT, "app/api/admin")).sort();

// Club-owner routes that happen to live under /api/admin (requireApiOwner /
// requireApiRole — the TENANT gate, not the operator gate). Out of scope for
// the operator matrix; classified so they cannot hide among operator routes.
const CLUB_ROUTE_PREFIXES = ["app/api/admin/import/", "app/api/admin/dsar/", "app/api/admin/email/"];
// The operator sign-in surface: establishes a session, public by design.
const PUBLIC_AUTH = [
  "app/api/admin/auth/login/route.ts",
  "app/api/admin/auth/logout/route.ts",
  "app/api/admin/auth/operator-login/route.ts",
  "app/api/admin/auth/operator-totp/route.ts",
];
// Requires a per-operator session; the shared secret is NOT enough here, in
// any environment. step-up re-proves a named operator's authenticator.
const OPERATOR_SESSION_ONLY = [
  "app/api/admin/auth/operator-totp/setup/route.ts",
  "app/api/admin/auth/step-up/route.ts",
];

const OPERATOR_ROUTES = ALL_ROUTES.filter(
  (f) => !CLUB_ROUTE_PREFIXES.some((p) => f.startsWith(p)) && !PUBLIC_AUTH.includes(f),
);

// Routes that answer a signed-in club user 401 rather than 403. Refused either
// way; listed so a change in either direction is noticed.
const ANSWERS_401_TO_CLUB_ROLES = [
  "app/api/admin/applications/route.ts GET",
  "app/api/admin/applications/[id]/approve/route.ts POST",
  "app/api/admin/applications/[id]/reject/route.ts POST",
  "app/api/admin/auth/operator-totp/setup/route.ts GET",
  "app/api/admin/auth/operator-totp/setup/route.ts POST",
  "app/api/admin/auth/step-up/route.ts POST",
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ORIGIN = "http://localhost:3847";
const ADMIN_SECRET = "matrix-test-admin-secret-value";
const savedEnv = { ...process.env };

function urlFor(file: string): string {
  return ORIGIN + "/" + file.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, "fixture-$1");
}

function makeReq(file: string, method: string, extraHeaders: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { origin: ORIGIN, host: "localhost:3847", ...extraHeaders };
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({});
  }
  return new Request(urlFor(file), init);
}

const ctx = { params: Promise.resolve({ id: "fixture-id", index: "0" }) };

async function loadHandlers(file: string): Promise<Array<[string, Handler]>> {
  const mod = (await import(/* @vite-ignore */ "@/" + file.replace(/\.ts$/, ""))) as Record<string, unknown>;
  return METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler]);
}

type Persona = {
  name: string;
  session: null | { user: Record<string, unknown> };
  cookies: Record<string, string>;
  headers?: Record<string, string>;
  clubRole: boolean;
};

const clubSession = (role: string) => ({
  user: { id: `user-${role}`, role, tenantId: "tenant-club", tenantSlug: "club", totpEnabled: true, sessionVersion: 0 },
});
const authCookies = { "authjs.session-token": "opaque-club-jwt", "__Secure-authjs.session-token": "opaque-club-jwt" };

const REFUSED: Persona[] = [
  { name: "unauthenticated", session: null, cookies: {}, clubRole: false },
  { name: "club owner", session: clubSession("owner"), cookies: authCookies, clubRole: true },
  { name: "club manager", session: clubSession("manager"), cookies: authCookies, clubRole: true },
  { name: "club coach", session: clubSession("coach"), cookies: authCookies, clubRole: true },
  { name: "club member", session: clubSession("member"), cookies: authCookies, clubRole: true },
  {
    name: "club owner with a wrong admin secret",
    session: clubSession("owner"),
    cookies: { ...authCookies, matflow_admin: "guessed-secret" },
    headers: { "x-admin-secret": "guessed-secret" },
    clubRole: true,
  },
];

function reset(p: Persona) {
  state.jar = new Map(Object.entries(p.cookies));
  state.session = p.session;
  state.sideEffects = [];
  state.operatorRow = null;
}

beforeEach(() => {
  process.env.MATFLOW_ADMIN_SECRET = ADMIN_SECRET;
  delete process.env.ALLOW_ADMIN_SECRET_HEADER;
});
afterAll(() => {
  process.env = { ...savedEnv };
});

describe("route inventory", () => {
  it("every file under app/api/admin is classified", () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(0);
    const club = ALL_ROUTES.filter((f) => CLUB_ROUTE_PREFIXES.some((p) => f.startsWith(p)));
    // Snapshot of the operator set: a new operator route must be added here on
    // purpose, and then the matrix below covers it automatically.
    expect(OPERATOR_ROUTES).toEqual([
      "app/api/admin/activity/route.ts",
      "app/api/admin/applications/[id]/approve/route.ts",
      "app/api/admin/applications/[id]/reject/route.ts",
      "app/api/admin/applications/route.ts",
      "app/api/admin/auth/operator-totp/setup/route.ts",
      "app/api/admin/auth/step-up/route.ts",
      "app/api/admin/create-tenant/route.ts",
      "app/api/admin/customers/[id]/force-password-reset/route.ts",
      "app/api/admin/customers/[id]/login-email/route.ts",
      "app/api/admin/customers/[id]/member-totp-reset/route.ts",
      "app/api/admin/customers/[id]/review-lock/route.ts",
      "app/api/admin/customers/[id]/soft-delete/route.ts",
      "app/api/admin/customers/[id]/suspend/route.ts",
      "app/api/admin/customers/[id]/totp-reset/route.ts",
      "app/api/admin/customers/[id]/transfer-ownership/route.ts",
      "app/api/admin/impersonate/route.ts",
    ]);
    expect(club.length + PUBLIC_AUTH.length + OPERATOR_ROUTES.length).toBe(ALL_ROUTES.length);
  });
});

describe.each(OPERATOR_ROUTES)("%s", (file) => {
  for (const persona of REFUSED) {
    it(`refuses ${persona.name} on every handler, with no side effect`, async () => {
      const handlers = await loadHandlers(file);
      expect(handlers.length, "no HTTP handler exported").toBeGreaterThan(0);
      for (const [method, handler] of handlers) {
        reset(persona);
        const res = await handler(makeReq(file, method, persona.headers), ctx);
        const key = `${file} ${method}`;
        if (persona.clubRole) {
          const expected = ANSWERS_401_TO_CLUB_ROLES.includes(key) ? 401 : 403;
          expect(res.status, `${key} as ${persona.name}`).toBe(expected);
        } else {
          expect([401, 403], `${key} as ${persona.name}`).toContain(res.status);
        }
        expect(state.sideEffects, `${key} as ${persona.name} reached past the gate`).toEqual([]);
      }
    });
  }
});

// ── positive controls: the gate opens for operators ────────────────────────
const SHARED_SECRET_ROUTES = OPERATOR_ROUTES.filter((f) => !OPERATOR_SESSION_ONLY.includes(f));

async function getsPastGate(file: string, persona: Persona, setup?: () => void) {
  const handlers = await loadHandlers(file);
  for (const [method, handler] of handlers) {
    reset(persona);
    setup?.();
    let status: number;
    try {
      status = (await handler(makeReq(file, method, persona.headers), ctx)).status;
    } catch {
      status = 500; // DB stub threw past the gate: the gate opened.
    }
    const opened = state.sideEffects.length > 0 || ![401, 403].includes(status);
    expect(opened, `${file} ${method} as ${persona.name}: status ${status}, effects ${state.sideEffects.join(",")}`).toBe(true);
  }
}

// Was (audit 5 Oct 2026): "positive control: the bootstrap secret alone opens
// every shared-secret operator route" — true in every environment, production
// included (ISSUE Q1 High). Since 6 Oct 2026 that holds in development/test
// ONLY; the production block below is the protection.
describe("development/test only: the shared secret still opens the shared-secret operator routes", () => {
  it.each(SHARED_SECRET_ROUTES)("%s (matflow_admin cookie = MATFLOW_ADMIN_SECRET)", async (file) => {
    await getsPastGate(file, { name: "bootstrap cookie", session: null, cookies: { matflow_admin: ADMIN_SECRET }, clubRole: false });
  });
  it.each(SHARED_SECRET_ROUTES)("%s (x-admin-secret header, default flag)", async (file) => {
    await getsPastGate(file, { name: "secret header", session: null, cookies: {}, headers: { "x-admin-secret": ADMIN_SECRET }, clubRole: false });
  });
});

// ── production: the shared secret grants nothing ───────────────────────────
const PRODUCTION_SHAPES: Array<[string, Record<string, string>]> = [
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
  ["the production database", { DATABASE_URL: "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.example/neondb" }],
];

async function refusedEverywhere(persona: Persona) {
  for (const file of OPERATOR_ROUTES) {
    for (const [method, handler] of await loadHandlers(file)) {
      reset(persona);
      const res = await handler(makeReq(file, method, persona.headers), ctx);
      expect([401, 403], `${file} ${method} as ${persona.name}`).toContain(res.status);
      expect(state.sideEffects, `${file} ${method} as ${persona.name} reached past the gate`).toEqual([]);
    }
  }
}

describe("production: the shared secret is refused on every operator route, with no side effect", () => {
  it.each(PRODUCTION_SHAPES)("%s — cookie, header, and ALLOW_ADMIN_SECRET_HEADER=1 together", async (_label, env) => {
    Object.assign(process.env, env, { ALLOW_ADMIN_SECRET_HEADER: "1" });
    try {
      await refusedEverywhere({
        name: "shared secret in production",
        session: null,
        cookies: { matflow_admin: ADMIN_SECRET },
        headers: { "x-admin-secret": ADMIN_SECRET },
        clubRole: false,
      });
    } finally {
      for (const k of Object.keys(env)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  });
});

describe("only an MFA-verified session counts: other operator tokens are refused everywhere", () => {
  const enrolledRow = () => ({ id: "op-1", email: "op@example.test", name: "Op", sessionVersion: 3, totpEnabled: true, totpSecret: null });

  it("the TOTP challenge token presented as a session", async () => {
    const { issueOperatorTotpChallenge } = await import("@/lib/operator-auth");
    const token = issueOperatorTotpChallenge("op-1", 3);
    for (const file of OPERATOR_ROUTES) {
      for (const [method, handler] of await loadHandlers(file)) {
        reset({ name: "challenge-as-session", session: null, cookies: { matflow_op_session: token, matflow_op_challenge: token }, clubRole: false });
        state.operatorRow = enrolledRow();
        const res = await handler(makeReq(file, method), ctx);
        expect([401, 403], `${file} ${method}`).toContain(res.status);
        expect(state.sideEffects).toEqual([]);
      }
    }
  });

  it("the enrolment token presented as a session (and as itself, outside setup)", async () => {
    const { issueOperatorEnrolmentSession } = await import("@/lib/operator-auth");
    const token = issueOperatorEnrolmentSession("op-1", 3);
    for (const file of OPERATOR_ROUTES.filter((f) => f !== "app/api/admin/auth/operator-totp/setup/route.ts")) {
      for (const [method, handler] of await loadHandlers(file)) {
        reset({ name: "enrolment-as-session", session: null, cookies: { matflow_op_session: token, matflow_op_enrol: token }, clubRole: false });
        state.operatorRow = { ...enrolledRow(), totpEnabled: false };
        const res = await handler(makeReq(file, method), ctx);
        expect([401, 403], `${file} ${method}`).toContain(res.status);
        expect(state.sideEffects).toEqual([]);
      }
    }
  });

  it("a session in the pre-hardening format (bare-payload HMAC, never proved a code)", async () => {
    const { createHmac } = await import("node:crypto");
    const { AUTH_SECRET_VALUE } = await import("@/lib/auth-secret");
    const payload = `op-1.3.${Date.now() + 60_000}`;
    const token = `${payload}.${createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex")}`;
    await refusedEverywhereWithRow({ matflow_op_session: token }, enrolledRow());
  });

  it("a well-signed session for an operator whose TOTP is no longer enabled", async () => {
    const token = issueOperatorSession("op-1", 3);
    await refusedEverywhereWithRow({ matflow_op_session: token }, { ...enrolledRow(), totpEnabled: false });
  });

  it("an expired session", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const token = issueOperatorSession("op-1", 3);
      vi.setSystemTime(Date.now() + 8 * 60 * 60 * 1000 + 1);
      await refusedEverywhereWithRow({ matflow_op_session: token }, enrolledRow());
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tampered session (operator id swapped, signature kept)", async () => {
    const token = issueOperatorSession("op-1", 3).split(".");
    token[0] = "op-2";
    await refusedEverywhereWithRow({ matflow_op_session: token.join(".") }, { ...enrolledRow(), id: "op-2" });
  });
});

async function refusedEverywhereWithRow(cookies: Record<string, string>, row: Record<string, unknown>) {
  for (const file of OPERATOR_ROUTES) {
    for (const [method, handler] of await loadHandlers(file)) {
      reset({ name: "bad session", session: null, cookies, clubRole: false });
      state.operatorRow = row;
      const res = await handler(makeReq(file, method), ctx);
      expect([401, 403], `${file} ${method}`).toContain(res.status);
      expect(state.sideEffects, `${file} ${method}`).toEqual([]);
    }
  }
}

describe("positive control: a v1.5 operator session opens every operator route", () => {
  it.each(OPERATOR_ROUTES)("%s", async (file) => {
    const token = issueOperatorSession("op-1", 3);
    await getsPastGate(
      file,
      { name: "operator session", session: null, cookies: { matflow_op_session: token }, clubRole: false },
      () => { state.operatorRow = { id: "op-1", email: "op@example.test", name: "Op", sessionVersion: 3, totpEnabled: true, totpSecret: null }; },
    );
  });

  it("a revoked operator session (sessionVersion bumped) is refused everywhere", async () => {
    const token = issueOperatorSession("op-1", 3);
    for (const file of OPERATOR_ROUTES) {
      for (const [method, handler] of await loadHandlers(file)) {
        reset({ name: "revoked", session: null, cookies: { matflow_op_session: token }, clubRole: false });
        state.operatorRow = { id: "op-1", email: "op@example.test", name: "Op", sessionVersion: 4 };
        const res = await handler(makeReq(file, method), ctx);
        expect([401, 403], `${file} ${method}`).toContain(res.status);
        expect(state.sideEffects).toEqual([]);
      }
    }
  });
});

describe("the bootstrap secret cannot enrol operator TOTP", () => {
  it("operator-totp/setup refuses the matflow_admin cookie", async () => {
    for (const file of OPERATOR_SESSION_ONLY) {
      for (const [method, handler] of await loadHandlers(file)) {
        reset({ name: "bootstrap", session: null, cookies: { matflow_admin: ADMIN_SECRET }, clubRole: false });
        const res = await handler(makeReq(file, method), ctx);
        expect(res.status, `${file} ${method}`).toBe(401);
      }
    }
  });
});
