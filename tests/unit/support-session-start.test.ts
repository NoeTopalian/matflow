/**
 * Starting a support session — POST /api/admin/impersonate (remediation lane B,
 * 6 Oct 2026). Real route, real lib/impersonation, real lib/operator-step-up
 * and lib/operator-auth; cookies, Prisma and the audit writer are stand-ins.
 *
 * Start needs: a named operator with a live MFA session; a fresh step-up grant
 * for "support.impersonate" bound to THIS club and THIS person (single use); a
 * reason of at least 10 characters; a club that admits sign-in; and no support
 * session already live in this browser.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  operator: null as null | Record<string, unknown>,
  users: new Map<string, Record<string, unknown>>(),
  audit: [] as Record<string, unknown>[],
  secretAuthed: false,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (st.jar.has(name) ? { name, value: st.jar.get(name)! } : undefined),
    set: (name: string, value: string) => { st.jar.set(name, value); },
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
        for (const k of ["stepUpNonceHash", "supportNonceHash"]) {
          if (k in where && op[k] !== where[k]) return { count: 0 };
        }
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
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (a: Record<string, unknown>) => { st.audit.push(a); }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => st.secretAuthed }));

import { POST } from "@/app/api/admin/impersonate/route";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { issueStepUpGrant, STEP_UP_HEADER } from "@/lib/operator-step-up";
import { IMPERSONATION_COOKIE, signImpersonationToken } from "@/lib/impersonation";

const OP = "op-noe";
const owner = (id: string, status = "active", deletedAt: Date | null = null) => ({
  id, tenantId: "t-club", email: `${id}@example.test`, name: "Owner", role: "owner", sessionVersion: 2,
  tenant: { subscriptionStatus: status, deletedAt },
});

beforeEach(() => {
  st.jar.clear();
  st.audit = [];
  st.secretAuthed = false;
  st.operator = {
    id: OP, email: "noe@example.test", name: "Noe", sessionVersion: 3, totpEnabled: true,
    stepUpNonceHash: null, stepUpExpiresAt: null, supportNonceHash: null, supportExpiresAt: null,
  };
  st.users = new Map([["u-owner", owner("u-owner")], ["u-other", owner("u-other")]]);
  st.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP, 3));
});

async function grant(target: string) {
  return (await issueStepUpGrant({ operatorId: OP, action: "support.impersonate", targetId: target })).grant;
}
function startReq(body: Record<string, unknown>, stepUp?: string) {
  return new Request("http://localhost/api/admin/impersonate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(stepUp ? { [STEP_UP_HEADER]: stepUp } : {}) },
    body: JSON.stringify(body),
  });
}
const GOOD = { targetUserId: "u-owner", reason: "owner reported a timetable fault" };

describe("POST /api/admin/impersonate", () => {
  it("positive control: named operator + bound grant + reason + active club → started, bound, audited", async () => {
    const res = await POST(startReq(GOOD, await grant("t-club/u-owner")));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, readOnly: true, redirectTo: "/dashboard" });
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(true);
    expect(st.operator!.supportNonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(st.audit[0]).toMatchObject({ action: "admin.impersonate.start", userId: "u-owner", actAsUserId: OP });
  });

  it("refused without a step-up grant: nothing started", async () => {
    const res = await POST(startReq(GOOD));
    expect(res.status).toBe(403);
    expect((await res.json()).stepUpRequired).toBe(true);
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(false);
    expect(st.operator!.supportNonceHash).toBeNull();
  });

  it("refused with a grant for a DIFFERENT person (target substitution)", async () => {
    const res = await POST(startReq(GOOD, await grant("t-club/u-other")));
    expect(res.status).toBe(403);
    expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(false);
  });

  it("refused with a grant for a different ACTION", async () => {
    const g = (await issueStepUpGrant({ operatorId: OP, action: "owner.totp_reset", targetId: "t-club/u-owner" })).grant;
    expect((await POST(startReq(GOOD, g))).status).toBe(403);
  });

  it("a grant is single use: replaying it for a second start is refused", async () => {
    const g = await grant("t-club/u-owner");
    expect((await POST(startReq(GOOD, g))).status).toBe(200);
    st.jar.delete(IMPERSONATION_COOKIE);
    expect((await POST(startReq(GOOD, g))).status).toBe(403);
  });

  it("refused with a reason under 10 characters — and the grant is not spent", async () => {
    const g = await grant("t-club/u-owner");
    expect((await POST(startReq({ ...GOOD, reason: "too short" }, g))).status).toBe(400);
    expect(st.operator!.stepUpNonceHash).not.toBeNull();
  });

  it("refused to the shared-secret sentinel (no named operator, no authenticator)", async () => {
    st.jar.delete(OP_SESSION_COOKIE);
    st.secretAuthed = true;
    const res = await POST(startReq(GOOD, "irrelevant"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/named operator/);
  });

  it("refused to a revoked operator session (sessionVersion moved)", async () => {
    st.operator!.sessionVersion = 4;
    expect((await POST(startReq(GOOD, await grant("t-club/u-owner")))).status).toBe(403);
  });

  it("refused while a support session is already live in this browser (no second, no nesting)", async () => {
    st.jar.set(IMPERSONATION_COOKIE, signImpersonationToken({
      adminUserId: OP, opSv: 3, targetUserId: "u-other", targetTenantId: "t-club", tsv: 2, reason: "earlier support", n: "nonce-0123456789abcdef",
    }));
    const res = await POST(startReq(GOOD, await grant("t-club/u-owner")));
    expect(res.status).toBe(409);
  });

  it.each([["suspended", "suspended", null], ["deleted", "active", new Date()]] as const)(
    "refused for a %s club, before the grant is spent",
    async (_l, status, deletedAt) => {
      st.users.set("u-owner", owner("u-owner", status, deletedAt));
      const g = await grant("t-club/u-owner");
      expect((await POST(startReq(GOOD, g))).status).toBe(409);
      expect(st.operator!.stepUpNonceHash).not.toBeNull();
      expect(st.jar.has(IMPERSONATION_COOKIE)).toBe(false);
    },
  );

  it("404 for an unknown person", async () => {
    // Lane C (9 Oct 2026): no grant can be issued for a person who does not
    // exist (the step-up route resolves their version first), so any header
    // will do: the 404 comes before the grant is looked at.
    expect((await POST(startReq({ ...GOOD, targetUserId: "nobody" }, "not-a-grant"))).status).toBe(404);
    await expect(grant("t-club/nobody")).rejects.toThrow(/subject not found/);
  });
});
