// Security campaign lane C — SEC-019 (property-level authorization / mass
// assignment) and SEC-036 (prototype pollution at the JSON parser boundary).
//
// Every app/api route handler that reads a request body is invoked with a
// body made of security-sensitive keys the route has no business accepting
// (role, tenant, identity, credential, MFA, verification, billing and row-id
// fields, at the top level AND nested under data/where/user, plus a raw
// `__proto__` key and a `constructor.prototype` chain). Each sensitive value
// is a unique canary string. The database, mail, Stripe and Blob layers are
// recording fakes. The invariant: no canary ever appears in the arguments of a
// database, mail, Stripe or Blob call, and Object.prototype is never polluted,
// whatever the route answers.
//
// Positive controls:
//  1. The detector itself: a planted handler that spreads the raw body into a
//     write IS flagged (so a green sweep is not a blind detector).
//  2. Reachability: routes listed in LEGIT get a valid body merged with the
//     canaries and must answer 2xx AND write the legitimate field — proving
//     the canaries travelled through validation into a real write path.
//
// Synthetic only: ids/values carry the secC- prefix; nothing touches a database.

import { vi, describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Call = { layer: string; target: string; method: string; args: unknown[] };

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const state = { session: null as unknown };
  const record: Record<string, unknown> = {
    id: "secC-row-1",
    tenantId: "secC-tenant",
    name: "secC Existing",
    title: "secC Existing",
    email: "existing@secc.example",
    role: "coach",
    status: "active",
    accountType: "adult",
    paymentStatus: "paid",
    pricePence: 100,
    currency: "GBP",
    billingCycle: "monthly",
    isActive: true,
    deletedAt: null,
    erasedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    sessionVersion: 0,
    version: 0,
    order: 1,
    stripes: 0,
  };
  function model(layer: string, name: string): unknown {
    return new Proxy(
      {},
      {
        get(_t, method) {
          if (method === "then" || typeof method === "symbol") return undefined;
          return async (...args: unknown[]) => {
            calls.push({ layer, target: name, method: String(method), args });
            const m = String(method);
            if (m === "count") return 1;
            if (/Many$/.test(m) && m !== "findMany") return { count: 1 };
            if (m === "findMany" || m === "groupBy") return [{ ...record }];
            if (m === "aggregate") return { _count: 1, _sum: {}, _max: {} };
            return { ...record };
          };
        },
      },
    );
  }
  const db: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (prop === "$transaction") {
          return async (arg: unknown) =>
            typeof arg === "function" ? (arg as (t: unknown) => unknown)(db) : Promise.all(arg as unknown[]);
        }
        if (String(prop).startsWith("$")) {
          return async (...args: unknown[]) => {
            calls.push({ layer: "db", target: String(prop), method: "raw", args });
            return [];
          };
        }
        return model("db", String(prop));
      },
    },
  );
  return { calls, state, db, model };
});

vi.mock("@/lib/prisma-tenant", async (orig) => ({
  ...(await orig<object>()),
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(h.db),
  withRlsBypass: async (fn: (tx: unknown) => unknown) => fn(h.db),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.db, default: h.db }));
vi.mock("@/auth", () => ({
  auth: async () => h.state.session,
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: { GET: async () => new Response(null), POST: async () => new Response(null) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<object>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, remaining: 99 }),
  checkCronAuthAttempt: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit-log", async (orig) => ({
  ...(await orig<object>()),
  logAudit: async (...args: unknown[]) => {
    h.calls.push({ layer: "audit", target: "logAudit", method: "call", args });
  },
}));
vi.mock("@/lib/admin-auth", async (orig) => ({
  ...(await orig<object>()),
  isAdminAuthed: async () => true,
  isAdminPageAuthed: async () => true,
  checkOperatorSession: async () => true,
}));
vi.mock("@/lib/operator-context", async (orig) => ({
  ...(await orig<object>()),
  getOperatorContext: async () => ({ operatorId: "secC-operator", named: true, sessionVersion: 0 }),
}));
vi.mock("@/lib/operator-step-up", async (orig) => ({
  ...(await orig<object>()),
  requireStepUp: async () => ({
    operatorId: "secC-operator",
    sessionVersion: 0,
    action: "x",
    targetId: "x",
    tenantId: "secC-tenant",
    versionDigest: "v",
    requestId: "secC-rq",
  }),
  consumeStepUpGrant: async () => ({ kind: "spent" }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {}, has: () => false }),
  headers: async () => new Headers({ host: "localhost" }),
}));
// Outbound layers: every exported function becomes a recorder.
function recorderModule(layer: string, mod: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mod)) {
    out[k] =
      typeof v === "function" && !/^[A-Z]/.test(k)
        ? async (...args: unknown[]) => {
            h.calls.push({ layer, target: k, method: "call", args });
            return { ok: true, sent: false, id: "secC-out" };
          }
        : v;
  }
  return out;
}
vi.mock("@/lib/email", async (orig) => recorderModule("email", await orig<Record<string, unknown>>()));
vi.mock("@vercel/blob", async (orig) => recorderModule("blob", await orig<Record<string, unknown>>()));
vi.mock("@/lib/stripe/subscriptions", async (orig) => recorderModule("stripe", await orig<Record<string, unknown>>()));
// googleapis is not installed locally; the Drive layer is replaced outright (names from lib/google-drive.ts).
vi.mock("@/lib/google-drive", () =>
  recorderModule(
    "drive",
    Object.fromEntries(
      ["buildOAuthClient", "buildAuthUrl", "verifyState", "getAuthedClientForTenant", "listFolders", "listFilesInFolder", "extractFileText", "indexFolder", "exchangeCodeAndStore", "revokeConnection"].map((k) => [k, () => undefined]),
    ),
  ),
);

const CANARY = "secC-canary";
/** Sensitive keys a client must never be able to assign; every value is a canary. */
const SENSITIVE: Record<string, unknown> = {
  role: `${CANARY}-role`,
  tenantId: `${CANARY}-tenant`,
  tenant: { connect: { id: `${CANARY}-tenant-connect` } },
  ownerId: `${CANARY}-owner`,
  userId: `${CANARY}-user`,
  operatorId: `${CANARY}-operator`,
  isOperator: `${CANARY}-is-operator`,
  isAdmin: `${CANARY}-is-admin`,
  passwordHash: `${CANARY}-password-hash`,
  totpSecret: `${CANARY}-totp-secret`,
  totpEnabled: `${CANARY}-totp-enabled`,
  totpRecoveryCodes: [`${CANARY}-recovery-code`],
  mfaVerified: `${CANARY}-mfa-verified`,
  emailVerified: `${CANARY}-email-verified`,
  loginEmailProvisionalSince: `${CANARY}-provisional`,
  sessionVersion: `${CANARY}-session-version`,
  noLogin: `${CANARY}-no-login`,
  erasedAt: `${CANARY}-erased`,
  deletedAt: `${CANARY}-deleted`,
  stripeCustomerId: `${CANARY}-stripe-customer`,
  stripeAccountId: `${CANARY}-stripe-account`,
  subscriptionStatus: `${CANARY}-subscription`,
  createdById: `${CANARY}-created-by`,
  id: `${CANARY}-row-id`,
  data: { tenantId: `${CANARY}-nested-data-tenant`, role: `${CANARY}-nested-data-role` },
  where: { tenantId: `${CANARY}-nested-where-tenant` },
  user: { role: `${CANARY}-nested-user-role`, tenantId: `${CANARY}-nested-user-tenant` },
  member: { tenantId: `${CANARY}-nested-member-tenant`, passwordHash: `${CANARY}-nested-member-hash` },
  constructor: { prototype: { secCPolluted: `${CANARY}-ctor-proto` } },
};
/** Raw JSON so the `__proto__` key survives serialisation (JSON.stringify drops it). */
function canaryJson(extra: Record<string, unknown> = {}, omit: string[] = []): string {
  const sensitive = Object.fromEntries(Object.entries(SENSITIVE).filter(([k]) => !omit.includes(k)));
  const body = JSON.stringify({ ...sensitive, ...extra });
  return body.replace(/^\{/, `{"__proto__":{"secCPolluted":"${CANARY}-proto"},`);
}

function leaks(): Call[] {
  return h.calls.filter((c) => c.layer !== "audit" && JSON.stringify(c.args, (_k, v) => (typeof v === "bigint" ? String(v) : v)).includes(CANARY));
}
function writes(): Call[] {
  return h.calls.filter((c) => c.layer === "db" && /^(create|update|upsert|delete|createMany|updateMany|deleteMany|raw)/.test(c.method));
}

const OWNER = {
  user: { id: "secC-user-owner", tenantId: "secC-tenant", role: "owner", email: "owner@secc.example", name: "secC Owner", sessionVersion: 0 },
  expires: "2099-01-01T00:00:00Z",
};
const MEMBER = {
  user: { id: "secC-user-member", memberId: "secC-member", tenantId: "secC-tenant", role: "member", email: "member@secc.example", name: "secC Member", sessionVersion: 0 },
  expires: "2099-01-01T00:00:00Z",
};

const ROOT = path.resolve(__dirname, "../..");
function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts") out.push(p);
    }
  };
  walk(path.join(ROOT, "app/api"));
  return out.sort();
}
const BODY_ROUTES = routeFiles()
  .map((f) => ({ file: f, src: fs.readFileSync(f, "utf8") }))
  .filter(({ src }) => /\.json\(\s*\)/.test(src))
  .map(({ file }) => ({
    file,
    url: "/" + path.relative(ROOT, file).replace(/\\/g, "/").replace(/^app\//, "").replace(/\/route\.ts$/, ""),
  }));

function paramsFor(url: string) {
  const p: Record<string, string> = {};
  for (const m of url.matchAll(/\[(?:\.\.\.)?([^\]]+)\]/g)) p[m[1]] = `secC-param-${m[1]}`;
  return { params: Promise.resolve(p) };
}
function concrete(url: string) {
  return url.replace(/\[(?:\.\.\.)?([^\]]+)\]/g, (_m, n) => `secC-param-${n}`);
}

type Handler = (req: Request, ctx: unknown) => Promise<Response>;
async function invoke(handler: Handler, url: string, method: string, body: string): Promise<number> {
  const req = new Request(`http://localhost${concrete(url)}`, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" },
    body,
  });
  try {
    const res = await handler(req, paramsFor(url));
    return res?.status ?? -1;
  } catch {
    return -2; // thrown out of the handler (a 500 in Next)
  }
}

afterEach(() => {
  // Defence: a polluted prototype must never leak into the next case.
  delete (Object.prototype as Record<string, unknown>).secCPolluted;
});

describe("SEC-019 detector positive control", () => {
  it("flags a handler that spreads the raw body into a write", async () => {
    h.calls.length = 0;
    const planted: Handler = async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      await (h.db as unknown as { user: { update: (a: unknown) => Promise<unknown> } }).user.update({ where: { id: "x" }, data: { ...body } });
      return new Response(null, { status: 200 });
    };
    await invoke(planted, "/api/planted", "POST", canaryJson());
    expect(leaks().length).toBeGreaterThan(0);
  });

  it("flags a handler that copies a nested object into a where clause", async () => {
    h.calls.length = 0;
    const planted: Handler = async (req) => {
      const body = (await req.json()) as { where: Record<string, unknown> };
      await (h.db as unknown as { member: { findMany: (a: unknown) => Promise<unknown> } }).member.findMany({ where: { ...body.where } });
      return new Response(null, { status: 200 });
    };
    await invoke(planted, "/api/planted", "POST", canaryJson());
    expect(leaks().length).toBeGreaterThan(0);
  });

  it("the request parser keeps a raw __proto__ key as an own property and does not pollute", async () => {
    const req = new Request("http://localhost/x", { method: "POST", body: canaryJson() });
    const parsed = (await req.json()) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
  });
});

// Routes with a valid body for a positive control:
// [url, method, session, legitimate body, field expected in a write, attack outcome, canary keys omitted].
// "same" = the canaries are silently stripped and the request succeeds exactly as the legitimate one.
// A number = the route refuses a body carrying them (a visible refusal, no write). Keys the route legitimately
// accepts and validates (staff `role`) are omitted from the canary set and tested by value separately.
type Outcome = "same" | number;
const LEGIT: Array<[string, string, "owner" | "member", Record<string, unknown>, string, Outcome?, string[]?]> = [
  ["/api/products", "POST", "owner", { name: "secC product", pricePence: 100, category: "other" }, "secC product"],
  ["/api/products/[id]", "PATCH", "owner", { name: "secC renamed product" }, "secC renamed product"],
  ["/api/ranks/[id]", "PATCH", "owner", { name: "secC rank" }, "secC rank"],
  ["/api/class-packs/[id]", "PATCH", "owner", { name: "secC pack" }, "secC pack"],
  ["/api/memberships/[id]", "PATCH", "owner", { name: "secC tier" }, "secC tier"],
  ["/api/announcements/[id]", "PATCH", "owner", { title: "secC announcement" }, "secC announcement"],
  ["/api/staff/[id]", "PATCH", "owner", { name: "secC staff rename" }, "secC staff rename", "same", ["role"]],
  ["/api/members/[id]", "PATCH", "owner", { name: "secC member rename" }, "secC member rename"],
  // Refuses a self-service body carrying tenantId/accountType/relationship keys outright (lib/family-authority.ts).
  ["/api/member/children/[id]", "PATCH", "member", { name: "secC child rename" }, "secC child rename", 403],
];

// SF-C5 (Low): a top-level null/array/string JSON body throws a TypeError (500) before any effect.
// Two entries are harness artefacts that 500 on EVERY body under the generic fake DB (the route reads
// fields the fake record lacks): DELETE profile-picture and POST instances/generate.
// SF-C5 fixed 9 Oct 2026 (object-shape check before destructuring on the six routes); only the two
// harness artefacts remain.
const PINNED_NULL_BODY_5XX: string[] = [
  "DELETE /api/members/[id]/profile-picture", // harness artefact
  "POST /api/instances/generate", // harness artefact
];

const results: Array<{ url: string; method: string; who: string; status: number; dbCalls: number; writes: number; leaks: number }> = [];

describe("SEC-019 / SEC-036 canary sweep over every JSON route", () => {
  beforeAll(() => {
    expect(BODY_ROUTES.length).toBeGreaterThan(100); // guard: the glob found the routes
  });

  for (const r of BODY_ROUTES) {
    for (const who of ["owner", "member"] as const) {
      it(`${r.url} as ${who}: no canary reaches a DB/mail/Stripe/Blob call; no prototype pollution`, async () => {
        h.state.session = who === "owner" ? OWNER : MEMBER;
        const mod = (await import(/* @vite-ignore */ r.file)) as Record<string, unknown>;
        const methods = ["POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
        for (const method of methods) {
          h.calls.length = 0;
          const status = await invoke(mod[method] as Handler, r.url, method, canaryJson());
          const leaked = leaks();
          results.push({ url: r.url, method, who, status, dbCalls: h.calls.filter((c) => c.layer === "db").length, writes: writes().length, leaks: leaked.length });
          expect(leaked.map((c) => `${c.layer}.${c.target}.${c.method}`), `${method} ${r.url}`).toEqual([]);
          expect(({} as Record<string, unknown>).secCPolluted, `${method} ${r.url} polluted Object.prototype`).toBeUndefined();
        }
      });
    }
  }

  for (const [url, method, who, legit, expected, outcome = "same", omit = []] of LEGIT) {
    it(`positive control ${method} ${url}: legitimate field written, canaries dropped`, async () => {
      h.state.session = who === "owner" ? OWNER : MEMBER;
      const file = BODY_ROUTES.find((r) => r.url === url)!.file;
      const mod = (await import(/* @vite-ignore */ file)) as Record<string, Handler>;
      // Control A: the legitimate body alone succeeds and writes the field.
      h.calls.length = 0;
      const okStatus = await invoke(mod[method], url, method, JSON.stringify(legit));
      expect(okStatus, `${method} ${url} legitimate body`).toBeGreaterThanOrEqual(200);
      expect(okStatus).toBeLessThan(300);
      expect(JSON.stringify(writes().map((w) => w.args))).toContain(expected);
      // Attack: the same body plus every canary — same success, field written, no canary.
      h.calls.length = 0;
      const status = await invoke(mod[method], url, method, canaryJson(legit, omit));
      if (outcome === "same") {
        expect(status).toBe(okStatus);
        expect(JSON.stringify(writes().map((w) => w.args))).toContain(expected);
      } else {
        expect(status).toBe(outcome);
        expect(writes()).toEqual([]);
      }
      expect(leaks().map((c) => `${c.layer}.${c.target}.${c.method}`)).toEqual([]);
      expect(({} as Record<string, unknown>).secCPolluted).toBeUndefined();
    });
  }

  // Type confusion at the top level: a JSON body of `null`, an array or a string. Routes that
  // destructure or read properties of the raw body without a schema throw a TypeError there,
  // which Next turns into a 500 — no data or write is involved (the throw happens before any
  // effect), but a 500 is not a refusal. Pinned so a new one is reviewed (SF-C5, Low).
  it("top-level null / array / string bodies never write and never leak; 5xx only on the pinned list", async () => {
    const fivexx = new Set<string>();
    for (const r of BODY_ROUTES) {
      const mod = (await import(/* @vite-ignore */ r.file)) as Record<string, unknown>;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function")) {
        for (const body of ["null", "[]", '"secC-canary-string"', "[{\"role\":\"secC-canary-arr\"}]"]) {
          for (const who of [OWNER, MEMBER]) {
            h.state.session = who;
            h.calls.length = 0;
            const status = await invoke(mod[method] as Handler, r.url, method, body);
            expect(leaks(), `${method} ${r.url} body ${body}`).toEqual([]);
            if (status === -2 || status === 500) fivexx.add(`${method} ${r.url}`);
          }
        }
      }
    }
    const out = process.env.SEC_C_NULL_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify([...fivexx].sort(), null, 1));
    expect([...fivexx].sort()).toEqual(PINNED_NULL_BODY_5XX);
  });

  it("summary (written to the evidence log by the runner)", () => {
    const out = process.env.SEC_C_SWEEP_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
    expect(results.length).toBeGreaterThan(0);
  });
});
