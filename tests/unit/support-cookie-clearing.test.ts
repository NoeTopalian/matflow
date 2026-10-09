/**
 * Review of lane I (6 Oct 2026), run with NODE_ENV=production so the cookie
 * names and Secure flags are the deployed ones.
 *
 * D-I1: DELETE /api/admin/impersonate cleared the session cookie with
 * `store.delete(name)`, which sends Set-Cookie WITHOUT `Secure`. Browsers ignore
 * such a write for a `__Secure-` cookie, so in production the stop left the
 * session token in place. Every clear of the session and support cookies now
 * sets an empty value with the same attributes it was written with, Secure
 * included, and maxAge 0.
 *
 * Stale carrier: hasAuthJsSession counted a leftover support CARRIER (no
 * identity) as a club session, so a new start skipped writing a fresh carrier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encode } from "next-auth/jwt";

vi.hoisted(() => {
  (process.env as Record<string, string>).NODE_ENV = "production";
  // Production refuses every operator not named here (OPERATOR_ALLOWED_IDS,
  // admin hub lane B, 9 Oct 2026); this suite's operator is OP below.
  (process.env as Record<string, string>).OPERATOR_ALLOWED_IDS = "op-noe";
  // The audit row now carries a keyed address digest (review D5, 9 Oct 2026);
  // in production the digest refuses to run unkeyed, as the live app never is.
  (process.env as Record<string, string>).AUTH_SECRET = "unit-test-secret-0123456789";
});

const SECRET = "unit-test-secret-0123456789";

const st = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  writes: [] as Array<{ name: string; value: string; opts: Record<string, unknown> }>,
  bareDeletes: [] as string[],
  operator: null as null | Record<string, unknown>,
  users: new Map<string, Record<string, unknown>>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (st.jar.has(name) ? { name, value: st.jar.get(name)! } : undefined),
    set: (name: string, value: string, o?: Record<string, unknown>) => {
      st.writes.push({ name, value, opts: o ?? {} });
      if (o?.maxAge === 0) st.jar.delete(name);
      else st.jar.set(name, value);
    },
    delete: (name: string) => {
      st.bareDeletes.push(name);
      st.jar.delete(name);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "unit-test-secret-0123456789" }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    operator: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        st.operator && st.operator.id === where.id ? { ...st.operator } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(st.operator!, data); return st.operator; },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const op = st.operator;
        if (!op || op.id !== where.id) return { count: 0 };
        if ("stepUpNonceHash" in where && op.stepUpNonceHash !== where.stepUpNonceHash) return { count: 0 };
        if ("stepUpExpiresAt" in where && !(((op.stepUpExpiresAt as Date | null)?.getTime() ?? 0) > Date.now())) return { count: 0 };
        Object.assign(op, data);
        return { count: 1 };
      },
    },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  // Lane C (9 Oct 2026): the grant is spent inside the start row's
  // transaction, so the transaction client carries the Operator table too.
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => {
    const { prisma } = (await import("@/lib/prisma")) as unknown as { prisma: { operator: unknown } };
    return fn({
      operator: prisma.operator,
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => st.users.get(where.id) ?? null,
        findFirst: async ({ where }: { where: { tenantId?: string; role?: string } }) =>
          [...st.users.values()].find((u) => u.tenantId === where.tenantId && (!where.role || u.role === where.role)) ?? null,
      },
    });
  },
  withTenantContext: vi.fn(),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => false }));

import { POST, DELETE } from "@/app/api/admin/impersonate/route";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { issueStepUpGrant, STEP_UP_HEADER } from "@/lib/operator-step-up";
import { IMPERSONATION_COOKIE, clearImpersonationCookie } from "@/lib/impersonation";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";

const OP = "op-noe";

beforeEach(() => {
  st.jar.clear();
  st.writes = [];
  st.bareDeletes = [];
  st.operator = {
    id: OP, email: "noe@example.test", name: "Noe", sessionVersion: 3, totpEnabled: true,
    stepUpNonceHash: null, stepUpExpiresAt: null, supportNonceHash: null, supportExpiresAt: null,
  };
  st.users = new Map([["u-owner", {
    id: "u-owner", tenantId: "t-club", email: "u-owner@example.test", name: "Owner", role: "owner", sessionVersion: 2,
    tenant: { subscriptionStatus: "active", deletedAt: null },
  }]]);
  st.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP, 3));
});

async function grant() {
  return (await issueStepUpGrant({ operatorId: OP, action: "support.impersonate", targetId: "t-club/u-owner" })).grant;
}
function startReq(opts: { stepUp?: string; cookie?: string } = {}) {
  return new Request("https://matflow.example/api/admin/impersonate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.stepUp ? { [STEP_UP_HEADER]: opts.stepUp } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify({ targetUserId: "u-owner", reason: "owner reported a timetable fault" }),
  });
}

describe("production cookie names (the premise of D-I1)", () => {
  it("the session cookie is the __Secure- one", () => {
    expect(SESSION_COOKIE_NAME).toBe("__Secure-authjs.session-token");
  });
});

describe("D-I1: stopping support clears cookies with Secure + maxAge 0", () => {
  it("DELETE clears the __Secure- session token and the support cookie with Secure, never a bare delete", async () => {
    expect((await POST(startReq({ stepUp: await grant() }))).status).toBe(200);
    expect(st.jar.has(SESSION_COOKIE_NAME)).toBe(true);
    st.writes = [];

    const res = await DELETE(new Request("https://matflow.example/api/admin/impersonate", { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(st.bareDeletes).toEqual([]);

    const session = st.writes.find((w) => w.name === SESSION_COOKIE_NAME)!;
    expect(session).toBeDefined();
    expect(session.value).toBe("");
    expect(session.opts).toMatchObject({ secure: true, maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" });

    const support = st.writes.find((w) => w.name === IMPERSONATION_COOKIE)!;
    expect(support).toBeDefined();
    expect(support.value).toBe("");
    expect(support.opts).toMatchObject({ secure: true, maxAge: 0, path: "/", httpOnly: true, sameSite: "strict" });

    expect(st.jar.has(SESSION_COOKIE_NAME)).toBe(false);
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(false);
  });

  it("clearImpersonationCookie on its own (expiry / failed binding paths) sets Secure + maxAge 0", async () => {
    st.jar.set(IMPERSONATION_COOKIE, "x");
    await clearImpersonationCookie();
    expect(st.bareDeletes).toEqual([]);
    expect(st.writes.at(-1)).toMatchObject({ name: IMPERSONATION_COOKIE, value: "", opts: { secure: true, maxAge: 0, path: "/" } });
  });
});

describe("stale carrier: a leftover carrier is not a club session", () => {
  it("a start in a browser holding only a carrier writes a fresh carrier", async () => {
    const stale = await encode({ token: { supportCarrier: true }, secret: SECRET, salt: SESSION_COOKIE_NAME, maxAge: 60 });
    const res = await POST(startReq({ stepUp: await grant(), cookie: `${SESSION_COOKIE_NAME}=${stale}` }));
    expect(res.status).toBe(200);
    const fresh = st.writes.find((w) => w.name === SESSION_COOKIE_NAME);
    expect(fresh, "a fresh carrier must be written").toBeDefined();
    expect(fresh!.value).not.toBe(stale);
    expect(fresh!.opts).toMatchObject({ secure: true, httpOnly: true });
  });

  it("control: a real club session is still kept (no carrier written)", async () => {
    const club = await encode({
      token: { id: "u-op-club", tenantId: "t-hq", role: "owner", sessionVersion: 1 },
      secret: SECRET, salt: SESSION_COOKIE_NAME, maxAge: 3600,
    });
    const res = await POST(startReq({ stepUp: await grant(), cookie: `${SESSION_COOKIE_NAME}=${club}` }));
    expect(res.status).toBe(200);
    expect(st.writes.find((w) => w.name === SESSION_COOKIE_NAME)).toBeUndefined();
  });
});
