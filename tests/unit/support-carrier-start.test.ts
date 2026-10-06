/**
 * E2E flow 6 (6 Oct 2026): starting support in a CLEAN operator browser.
 *
 * Operator sign-in never mints an Auth.js session token, and auth.ts jwt() —
 * where the swap to the target happens — only runs when one is presented. So
 * POST /api/admin/impersonate, when the browser holds no Auth.js session, also
 * sets a CARRIER token: { supportCarrier: true }, no identity, support lifetime.
 * With a club session already present, nothing extra is set (today's stash
 * behaviour). The stop clears the session cookie either way.
 *
 * Real route, real lib/impersonation and next-auth/jwt; cookies, Prisma and the
 * audit writer are stand-ins (harness from support-session-start.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encode, decode } from "next-auth/jwt";

const SECRET = "unit-test-secret-0123456789";

const st = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  opts: new Map<string, Record<string, unknown>>(),
  operator: null as null | Record<string, unknown>,
  users: new Map<string, Record<string, unknown>>(),
  audit: [] as Record<string, unknown>[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (st.jar.has(name) ? { name, value: st.jar.get(name)! } : undefined),
    set: (name: string, value: string, o?: Record<string, unknown>) => {
      // maxAge 0 is a clear (how the stop clears cookies since D-I1).
      if (o?.maxAge === 0) st.jar.delete(name);
      else st.jar.set(name, value);
      st.opts.set(name, o ?? {});
    },
    delete: (name: string) => { st.jar.delete(name); },
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
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) =>
    fn({ user: { findUnique: async ({ where }: { where: { id: string } }) => st.users.get(where.id) ?? null } }),
  withTenantContext: vi.fn(),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (a: Record<string, unknown>) => { st.audit.push(a); }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => false }));

import { POST, DELETE } from "@/app/api/admin/impersonate/route";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { issueStepUpGrant, STEP_UP_HEADER } from "@/lib/operator-step-up";
import { IMPERSONATION_COOKIE, SUPPORT_SESSION_TTL_SECONDS } from "@/lib/impersonation";
import { SESSION_COOKIE_NAME } from "@/lib/auth-cookie";

const OP = "op-noe";

beforeEach(() => {
  st.jar.clear();
  st.opts.clear();
  st.audit = [];
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
  return new Request("http://localhost/api/admin/impersonate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(opts.stepUp ? { [STEP_UP_HEADER]: opts.stepUp } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify({ targetUserId: "u-owner", reason: "owner reported a timetable fault" }),
  });
}
/** The Auth.js session-token cookie the start wrote, if any. */
function sessionSet(): string | null {
  return st.jar.get(SESSION_COOKIE_NAME) ?? null;
}

describe("support start in a clean operator browser sets a carrier", () => {
  it("no Auth.js session in the browser → carrier set: no identity, support lifetime, HttpOnly", async () => {
    const res = await POST(startReq({ stepUp: await grant() }));
    expect(res.status).toBe(200);
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(true);
    const value = sessionSet();
    expect(value, "a session-token cookie must be set so jwt() runs").not.toBeNull();
    expect(st.opts.get(SESSION_COOKIE_NAME)).toMatchObject({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      // The route mirrors lib/impersonation.ts's lifetime; this pins the mirror.
      maxAge: SUPPORT_SESSION_TTL_SECONDS,
    });
    const claims = (await decode({ token: value!, secret: SECRET, salt: SESSION_COOKIE_NAME })) as Record<string, unknown>;
    // The same claim auth.ts SUPPORT_CARRIER_CLAIM reads (support-carrier-jwt.test.ts).
    expect(claims.supportCarrier).toBe(true);
    for (const k of ["id", "sub", "email", "name", "tenantId", "tenantSlug", "role", "sessionVersion", "memberId", "impersonatedBy"]) {
      expect(claims[k], `carrier must carry no ${k}`).toBeUndefined();
    }
    expect((claims.exp as number) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(SUPPORT_SESSION_TTL_SECONDS);
  });

  it("an unreadable session cookie counts as none → carrier set", async () => {
    const res = await POST(startReq({ stepUp: await grant(), cookie: `${SESSION_COOKIE_NAME}=not-a-jwe` }));
    expect(res.status).toBe(200);
    expect(sessionSet()).not.toBeNull();
  });

  it("a browser that already has a club session keeps it: no carrier written", async () => {
    const club = await encode({
      token: { id: "u-op-club", tenantId: "t-hq", role: "owner", sessionVersion: 1 },
      secret: SECRET,
      salt: SESSION_COOKIE_NAME,
      maxAge: 3600,
    });
    const res = await POST(startReq({ stepUp: await grant(), cookie: `${SESSION_COOKIE_NAME}=${club}` }));
    expect(res.status).toBe(200);
    expect(sessionSet()).toBeNull();
  });

  it("a refused start writes no carrier", async () => {
    const res = await POST(startReq());
    expect(res.status).toBe(403);
    expect(sessionSet()).toBeNull();
  });

  it("stop clears the session cookie (carrier or not) with the support cookie", async () => {
    expect((await POST(startReq({ stepUp: await grant() }))).status).toBe(200);
    expect(sessionSet()).not.toBeNull();
    const stop = await DELETE(new Request("http://localhost/api/admin/impersonate", { method: "DELETE" }));
    expect(stop.status).toBe(200);
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(false);
    expect(sessionSet()).toBeNull();
    expect(st.operator!.supportNonceHash).toBeNull();
  });
});
