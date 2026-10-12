// Operator auth hardening (lane A, 6 Oct 2026) — audit OPERATOR-ADMIN-SECURITY
// 2026-10-05 Q1 (shared secret = anonymous production operator power; TOTP
// optional) and the Q1/Q6 Low (operator-totp/setup had no origin check).
//
// Drives the real routes and libs against an in-memory Operator table that
// honours the conditional updates the code relies on. Red on revert:
//   - sharedAdminSecretPermitted() returning true  → the production cases fail
//   - operator-login issuing a session without TOTP → "never issues a session"
//   - consumeOperatorTotp not spending the step     → the replay cases fail
//   - setup without assertSameOrigin                → the CSRF cases fail
//   - logout without the sessionVersion bump        → "a copied cookie dies"

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { generateSecret, generateSync } from "otplib";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET = "operator-hardening-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    ops: new Map<string, Record<string, unknown>>(),
    audit: [] as Array<Record<string, unknown>>,
    auditFail: false,
  };
});

// ── an Operator table with Postgres-like conditional updates ───────────────
type Row = Record<string, unknown>;
const tableFactory = vi.hoisted(() => (ops: Map<string, Record<string, unknown>>) => {
  type Row = Record<string, unknown>;
  const h = { ops };
  // (indentation below kept flat for readability of the matcher)
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
const findRow = (where: Row) => [...h.ops.values()].find((r) => matches(r, where));
return {
  findUnique: vi.fn(async ({ where }: { where: Row }) => {
    const r = findRow(where);
    return r ? { ...r } : null;
  }),
  update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const r = findRow(where);
    if (!r) throw new Error("not found");
    apply(r, data);
    return { ...r };
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    let count = 0;
    for (const r of h.ops.values()) if (matches(r, where)) { apply(r, data); count++; }
    return { count };
  }),
};
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));

// $transaction rolls the in-memory table back on a throw, like Postgres
// (lane H, 6 Oct 2026: enrolment + its audit row are one transaction).
vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = { operator: tableFactory(h.ops), $executeRaw: async () => 0 };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = new Map([...h.ops].map(([k, v]) => [k, { ...v }]));
    try {
      return await fn(client);
    } catch (err) {
      h.ops.clear();
      for (const [k, v] of snapshot) h.ops.set(k, v);
      throw err;
    }
  };
  return { prisma: client };
});
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
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
  sharedAdminSecretPermitted,
  adminSecretHeaderAllowed,
  isAdminAuthed,
} from "@/lib/admin-auth";
import {
  OP_SESSION_HMAC_DOMAIN,
  issueOperatorEnrolmentSession,
  issueOperatorSession,
  issueOperatorTotpChallenge,
  newOperatorEnrolmentTicket,
  OP_ENROLMENT_TICKET_HEADER,
  resolveOperatorFromCookie,
} from "@/lib/operator-auth";

const ORIGIN = "http://localhost:3847";
const PASSWORD = "Operator-Password-123";
const SECRET_ENV = "hardening-shared-admin-secret";
const saved = { ...process.env };

function req(path: string, method = "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
}

/** Apply a response's Set-Cookie headers to the jar, like a browser would. */
function absorb(res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    const value = pair.slice(i + 1);
    if (attrs.some((a) => a.toLowerCase() === "max-age=0") || value === "") h.jar.delete(name);
    else h.jar.set(name, value);
  }
}
const setCookieNames = (res: Response) =>
  res.headers.getSetCookie().filter((c) => !/Max-Age=0/.test(c)).map((c) => c.split("=")[0]);

function seedOperator(over: Row = {}): Row {
  const row: Row = {
    id: "op-noe",
    email: "op@example.test",
    name: "Op",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "super_admin",
    totpEnabled: false,
    totpSecret: null,
    totpLastUsedStep: null,
    failedLoginCount: 0,
    lockedUntil: null,
    sessionVersion: 0,
    stepUpNonceHash: null,
    stepUpExpiresAt: null,
    enrolmentTicketHash: null,
    enrolmentTicketExpiresAt: null,
    lastLoginAt: null,
    ...over,
  };
  h.ops.set(row.id as string, row);
  return row;
}

beforeEach(() => {
  h.jar.clear();
  h.ops.clear();
  h.audit.length = 0;
  h.auditFail = false;
  process.env.MATFLOW_ADMIN_SECRET = SECRET_ENV;
  delete process.env.ALLOW_ADMIN_SECRET_HEADER;
});
afterEach(() => {
  for (const k of ["NODE_ENV", "VERCEL_ENV", "DATABASE_URL", "ALLOW_ADMIN_SECRET_HEADER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
});

const PROD: Array<[string, Record<string, string>]> = [
  ["NODE_ENV=production", { NODE_ENV: "production" }],
  ["VERCEL_ENV=production", { VERCEL_ENV: "production" }],
  ["production database", { DATABASE_URL: "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.example/neondb" }],
];

// ── 1. the shared secret ───────────────────────────────────────────────────
describe("shared MATFLOW_ADMIN_SECRET", () => {
  it("is permitted in a development/test process", () => {
    expect(sharedAdminSecretPermitted()).toBe(true);
  });

  it.each(PROD)("is refused on %s, and ALLOW_ADMIN_SECRET_HEADER=1 cannot re-open it", async (_l, env) => {
    Object.assign(process.env, env, { ALLOW_ADMIN_SECRET_HEADER: "1" });
    expect(sharedAdminSecretPermitted()).toBe(false);
    expect(adminSecretHeaderAllowed()).toBe(false);
    h.jar.set("matflow_admin", SECRET_ENV);
    expect(await isAdminAuthed(req("/api/admin/activity", "GET", undefined, { "x-admin-secret": SECRET_ENV }))).toBe(false);
  });

  it.each(PROD)("POST /api/admin/auth/login on %s refuses the CORRECT secret and sets no cookie", async (_l, env) => {
    Object.assign(process.env, env);
    const { POST } = await import("@/app/api/admin/auth/login/route");
    const res = await POST(req("/api/admin/auth/login", "POST", { secret: SECRET_ENV }));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("POST /api/admin/auth/login still works in development (local tooling)", async () => {
    const { POST } = await import("@/app/api/admin/auth/login/route");
    const res = await POST(req("/api/admin/auth/login", "POST", { secret: SECRET_ENV }));
    expect(res.status).toBe(200);
    expect(setCookieNames(res)).toEqual(["matflow_admin"]);
  });

  it("there is no fallback after a failed named login: the response carries no operator authority", async () => {
    seedOperator({ totpEnabled: true, totpSecret: generateSecret() });
    Object.assign(process.env, { NODE_ENV: "production" });
    h.jar.set("matflow_admin", SECRET_ENV);
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    const res = await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: "wrong-password" }));
    expect(res.status).toBe(401);
    expect(setCookieNames(res)).toEqual([]);
  });
});

// ── 2. mandatory MFA ───────────────────────────────────────────────────────
describe("operator-login never issues a session on the password alone", () => {
  it("an operator with no authenticator gets an ENROLMENT cookie only", async () => {
    seedOperator();
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    const res = await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, enrolmentRequired: true });
    expect(setCookieNames(res)).toEqual(["matflow_op_enrol"]);
    expect(res.headers.getSetCookie().find((c) => c.startsWith("matflow_op_enrol="))).toContain("Path=/api/admin/auth");
  });

  it("an enrolled operator gets a CHALLENGE cookie only", async () => {
    seedOperator({ totpEnabled: true, totpSecret: generateSecret() });
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    const res = await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD }));
    expect(await res.json()).toEqual({ ok: true, totpRequired: true });
    expect(setCookieNames(res)).toEqual(["matflow_op_challenge"]);
  });

  it("the enrolment token and the challenge token are not operator sessions", async () => {
    seedOperator({ totpEnabled: true, totpSecret: generateSecret() });
    expect(await resolveOperatorFromCookie(issueOperatorEnrolmentSession("op-noe", 0))).toBeNull();
    expect(await resolveOperatorFromCookie(issueOperatorTotpChallenge("op-noe", 0))).toBeNull();
    expect(await resolveOperatorFromCookie(issueOperatorSession("op-noe", 0))).not.toBeNull();
  });
});

/** An enrolment ticket as scripts/operator-access.mjs create/recover issues it (review D3). */
function giveTicket(over: { expiresAt?: Date } = {}): string {
  const t = newOperatorEnrolmentTicket();
  const row = h.ops.get("op-noe")!;
  row.enrolmentTicketHash = t.hash;
  row.enrolmentTicketExpiresAt = over.expiresAt ?? t.expiresAt;
  return t.ticket;
}
const SETUP = "/api/admin/auth/operator-totp/setup";
const getSetup = (ticket?: string) =>
  req(SETUP, "GET", undefined, ticket === undefined ? {} : { [OP_ENROLMENT_TICKET_HEADER]: ticket });

describe("enrolment: password → authenticator → full session", () => {
  async function signInUnenrolled() {
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
  }

  it("completes, mints a full session, bumps sessionVersion and kills the enrolment cookie", async () => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const g = await setup.GET(getSetup(ticket));
    const { secret } = (await g.json()) as { secret: string };
    expect(typeof secret).toBe("string");

    const res = await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket }));
    expect(res.status).toBe(200);
    expect(setCookieNames(res)).toEqual(["matflow_op_session"]);
    absorb(res);
    expect(h.jar.has("matflow_op_enrol")).toBe(false);
    expect(h.ops.get("op-noe")).toMatchObject({ totpEnabled: true, sessionVersion: 1 });
    expect(await resolveOperatorFromCookie(h.jar.get("matflow_op_session"))).toMatchObject({ id: "op-noe" });
    expect(h.audit.map((a) => a.action)).toContain("admin.operator.totp_enrolled");
  });

  it("refuses a wrong code and issues nothing", async () => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    await setup.GET(getSetup(ticket));
    const res = await setup.POST(req(SETUP, "POST", { code: "000000", ticket }));
    expect(res.status).toBe(401);
    expect(setCookieNames(res)).toEqual([]);
    expect(h.ops.get("op-noe")!.totpEnabled).toBe(false);
  });

  it.each([
    ["a foreign origin", "https://evil.example"],
    ["a sibling sub-domain", "https://evil.matflow.studio"],
  ])("POST refuses %s (CSRF) before touching anything", async (_l, origin) => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const { secret } = (await (await setup.GET(getSetup(ticket))).json()) as { secret: string };
    const before = { ...h.ops.get("op-noe") };
    const res = await setup.POST(new Request("https://matflow.studio/api/admin/auth/operator-totp/setup", {
      method: "POST",
      headers: { origin, host: "matflow.studio", "content-type": "application/json" },
      body: JSON.stringify({ code: generateSync({ secret }), ticket }),
    }));
    expect(res.status).toBe(403);
    expect(h.ops.get("op-noe")).toEqual(before);
  });

  it("the shared-secret cookie and the challenge cookie cannot enrol", async () => {
    seedOperator();
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    h.jar.set("matflow_admin", SECRET_ENV);
    h.jar.set("matflow_op_challenge", issueOperatorTotpChallenge("op-noe", 0));
    const ticket = giveTicket();
    expect((await setup.GET(getSetup(ticket))).status).toBe(401);
    expect((await setup.POST(req(SETUP, "POST", { code: "123456", ticket }))).status).toBe(401);
  });

  it("a revoked (sessionVersion bumped) enrolment cookie is refused", async () => {
    seedOperator();
    await signInUnenrolled();
    h.ops.get("op-noe")!.sessionVersion = 5;
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    expect((await setup.GET(getSetup(giveTicket()))).status).toBe(401);
  });
});

// ── review finding D3 (lane H, 6 Oct 2026): the out-of-band enrolment ticket ──
describe("D3: enrolment needs the single-use ticket from operator-access.mjs", () => {
  async function signInUnenrolled() {
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
  }
  const setupRoute = () => import("@/app/api/admin/auth/operator-totp/setup/route");

  it("the password alone (no ticket) cannot see the pending secret or enrol", async () => {
    seedOperator();
    giveTicket();
    await signInUnenrolled();
    const setup = await setupRoute();
    const g = await setup.GET(getSetup());
    expect(g.status).toBe(403);
    expect(((await g.json()) as Record<string, unknown>).secret).toBeUndefined();
    expect(h.ops.get("op-noe")!.totpSecret, "no pending secret minted").toBeNull();

    // An attacker who knows the password supplies their OWN secret's code.
    const res = await setup.POST(req(SETUP, "POST", { code: "123456" }));
    expect(res.status).toBe(403);
    expect(setCookieNames(res)).toEqual([]);
    expect(h.ops.get("op-noe")!.totpEnabled).toBe(false);
  });

  it("an operator row with NO ticket outstanding (e.g. pre-D3 recover) cannot enrol at all", async () => {
    seedOperator();
    await signInUnenrolled();
    const setup = await setupRoute();
    expect((await setup.GET(getSetup("0123-4567-89ab-cdef-0123-4567-89ab-cdef"))).status).toBe(403);
  });

  it("a wrong ticket is refused", async () => {
    seedOperator();
    giveTicket();
    await signInUnenrolled();
    const setup = await setupRoute();
    const wrong = newOperatorEnrolmentTicket().ticket;
    expect((await setup.GET(getSetup(wrong))).status).toBe(403);
    expect((await setup.POST(req(SETUP, "POST", { code: "123456", ticket: wrong }))).status).toBe(403);
    expect(h.ops.get("op-noe")!.totpEnabled).toBe(false);
  });

  it("an expired ticket (older than 30 minutes) is refused", async () => {
    seedOperator();
    const ticket = giveTicket({ expiresAt: new Date(Date.now() - 1000) });
    await signInUnenrolled();
    const setup = await setupRoute();
    expect((await setup.GET(getSetup(ticket))).status).toBe(403);
    expect((await setup.POST(req(SETUP, "POST", { code: "123456", ticket }))).status).toBe(403);
  });

  it("a ticket expiring BETWEEN the secret and the code is refused at the enabling write", async () => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await setupRoute();
    const { secret } = (await (await setup.GET(getSetup(ticket))).json()) as { secret: string };
    h.ops.get("op-noe")!.enrolmentTicketExpiresAt = new Date(Date.now() - 1);
    const res = await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket }));
    expect(res.status).toBe(403);
    expect(h.ops.get("op-noe")!.totpEnabled).toBe(false);
  });

  it("the ticket is consumed by the enrolment and cannot be reused", async () => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await setupRoute();
    const { secret } = (await (await setup.GET(getSetup(ticket))).json()) as { secret: string };
    expect((await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket }))).status).toBe(200);
    expect(h.ops.get("op-noe")).toMatchObject({ enrolmentTicketHash: null, enrolmentTicketExpiresAt: null });

    // The authenticator is cleared again WITHOUT a new ticket (as a pre-D3
    // recover did). The spent ticket must not open the door a second time.
    Object.assign(h.ops.get("op-noe")!, { totpEnabled: false, totpSecret: null, totpLastUsedStep: null });
    h.jar.clear();
    await signInUnenrolled();
    expect((await setup.GET(getSetup(ticket))).status).toBe(403);
    expect((await setup.POST(req(SETUP, "POST", { code: "123456", ticket }))).status).toBe(403);
  });

  it("the ticket is accepted in its printed form or without dashes, any case", async () => {
    seedOperator();
    const ticket = giveTicket();
    await signInUnenrolled();
    const setup = await setupRoute();
    const loose = " " + ticket.replace(/-/g, "").toUpperCase() + " ";
    const { secret } = (await (await setup.GET(getSetup(loose))).json()) as { secret: string };
    expect((await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket: loose }))).status).toBe(200);
  });

  it("already-enrolled operators are unaffected: password + code signs in, no ticket involved", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
    const totp = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret }) }));
    expect(res.status).toBe(200);
    expect(setCookieNames(res)).toEqual(["matflow_op_session"]);
  });
});

// ── review finding D5 (lane H, 6 Oct 2026): operator audit rows are durable ──
describe("D5: operator enrolment and sign-in rows are written before any session exists", () => {
  it("enrolment: the totp_enrolled row is written in the enabling transaction", async () => {
    seedOperator();
    const ticket = giveTicket();
    const { POST: login } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await login(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const { secret } = (await (await setup.GET(getSetup(ticket))).json()) as { secret: string };
    expect((await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket }))).status).toBe(200);
    const row = h.audit.find((a) => a.action === "admin.operator.totp_enrolled");
    expect(row, "written").toBeTruthy();
    expect(row!.tx, "inside the caller's transaction (strict)").toBeTruthy();
  });

  it("enrolment: if the row cannot be written, nothing changes and no session is issued", async () => {
    seedOperator();
    const ticket = giveTicket();
    const { POST: login } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await login(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
    const setup = await import("@/app/api/admin/auth/operator-totp/setup/route");
    const { secret } = (await (await setup.GET(getSetup(ticket))).json()) as { secret: string };
    h.auditFail = true;
    const res = await setup.POST(req(SETUP, "POST", { code: generateSync({ secret }), ticket }));
    expect(res.status).toBe(500);
    expect(setCookieNames(res)).toEqual([]);
    const op = h.ops.get("op-noe")!;
    expect(op.totpEnabled, "rolled back").toBe(false);
    expect(op.sessionVersion).toBe(0);
    expect(op.enrolmentTicketHash, "ticket not spent").not.toBeNull();
  });

  it("sign-in: a durable admin.operator.signed_in row is written", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    const { POST: login } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await login(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
    const totp = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret }) }));
    expect(res.status).toBe(200);
    expect(h.audit.find((a) => a.action === "admin.operator.signed_in")).toMatchObject({
      durable: true, tenantId: null, entityId: "op-noe", actAsUserId: "op-noe",
    });
  });

  it("sign-in: if the row cannot be written, no session is issued", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    const { POST: login } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await login(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
    h.auditFail = true;
    const totp = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret }) }));
    expect(res.status).toBe(500);
    expect(setCookieNames(res)).toEqual([]);
    expect(h.ops.get("op-noe")!.lastLoginAt, "login not completed").toBeNull();
  });
});

describe("TOTP challenge: codes are single use across instances", () => {
  async function challenge() {
    const { POST } = await import("@/app/api/admin/auth/operator-login/route");
    absorb(await POST(req("/api/admin/auth/operator-login", "POST", { email: "op@example.test", password: PASSWORD })));
  }

  it("a code that signed in once cannot sign in again", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    const totp = await import("@/app/api/admin/auth/operator-totp/route");
    const code = generateSync({ secret });

    await challenge();
    const first = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code }));
    expect(first.status).toBe(200);
    expect(setCookieNames(first)).toEqual(["matflow_op_session"]);

    h.jar.clear();
    await challenge();
    const replay = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code }));
    expect(replay.status).toBe(401);
    expect(setCookieNames(replay)).toEqual([]);
  });

  it("two instances racing the same code: exactly one wins", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    const { consumeOperatorTotp } = await import("@/lib/operator-auth");
    const code = generateSync({ secret });
    const row = { id: "op-noe", totpSecret: secret, totpLastUsedStep: null };
    const results = await Promise.all([consumeOperatorTotp(row, code), consumeOperatorTotp(row, code)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a locked operator holding a live challenge cannot keep guessing", async () => {
    const secret = generateSecret();
    seedOperator({ totpEnabled: true, totpSecret: secret });
    await challenge();
    h.ops.get("op-noe")!.lockedUntil = new Date(Date.now() + 60_000);
    const totp = await import("@/app/api/admin/auth/operator-totp/route");
    const res = await totp.POST(req("/api/admin/auth/operator-totp", "POST", { code: generateSync({ secret }) }));
    expect(res.status).toBe(423);
    expect(setCookieNames(res)).toEqual([]);
  });
});

describe("logout revokes server-side", () => {
  it("a copied session cookie is refused after the operator signs out", async () => {
    seedOperator({ totpEnabled: true, totpSecret: generateSecret(), sessionVersion: 2 });
    const token = issueOperatorSession("op-noe", 2);
    h.jar.set("matflow_op_session", token);
    expect(await resolveOperatorFromCookie(token)).not.toBeNull();

    const { POST } = await import("@/app/api/admin/auth/logout/route");
    const res = await POST(req("/api/admin/auth/logout"));
    expect(res.status).toBe(200);
    expect(h.ops.get("op-noe")!.sessionVersion).toBe(3);
    // The copy someone else kept:
    expect(await resolveOperatorFromCookie(token)).toBeNull();
  });
});

// ── 3. the edge gate agrees with the route gate ────────────────────────────
describe("proxy.ts /admin gate", () => {
  async function page(cookies: Record<string, string>) {
    const mod = await import("../../proxy");
    const proxy = mod.default as unknown as (r: unknown) => Promise<Response>;
    const url = `${ORIGIN}/admin/tenants`;
    return proxy({
      nextUrl: new URL(url),
      url,
      headers: new Headers(),
      cookies: { get: (n: string) => (n in cookies ? { name: n, value: cookies[n] } : undefined) },
      auth: null,
    });
  }
  const toLogin = (res: Response) => res.status === 307 && new URL(res.headers.get("location")!).pathname === "/admin/login";

  it("carries the same HMAC domain as lib/operator-auth.ts", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("proxy.ts", "utf8")).toContain(`const OP_SESSION_HMAC_DOMAIN = "${OP_SESSION_HMAC_DOMAIN}"`);
  });

  it("admits an MFA session minted by issueOperatorSession", async () => {
    expect(toLogin(await page({ matflow_op_session: issueOperatorSession("op-noe", 0) }))).toBe(false);
  });

  it("sends challenge, enrolment and pre-hardening tokens to /admin/login", async () => {
    const { createHmac } = await import("node:crypto");
    const payload = `op-noe.0.${Date.now() + 60_000}`;
    const legacy = `${payload}.${createHmac("sha256", process.env.AUTH_SECRET!).update(payload).digest("hex")}`;
    for (const t of [issueOperatorTotpChallenge("op-noe", 0), issueOperatorEnrolmentSession("op-noe", 0), legacy]) {
      expect(toLogin(await page({ matflow_op_session: t }))).toBe(true);
    }
  });

  it("the shared-secret cookie opens /admin in development but not in production", async () => {
    expect(toLogin(await page({ matflow_admin: SECRET_ENV }))).toBe(false);
    for (const [, env] of PROD) {
      Object.assign(process.env, env);
      expect(toLogin(await page({ matflow_admin: SECRET_ENV }))).toBe(true);
      for (const k of Object.keys(env)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
