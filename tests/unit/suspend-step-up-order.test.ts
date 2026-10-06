/**
 * Review of lane I (6 Oct 2026, nit): POST /api/admin/customers/[id]/suspend
 * spent the operator's single-use step-up grant BEFORE reading the club, so a
 * suspend refused with 404 / 409 still burnt the grant and the operator had to
 * re-authenticate for the retry. The grant is now checked after the club read
 * and its refusals, as the impersonate route does; a refused grant still
 * writes nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  tenant: null as null | Record<string, unknown>,
  writes: [] as unknown[],
  audit: [] as unknown[],
  stepUp: null as null | Response,
  stepUpCalls: 0,
}));

vi.mock("@/lib/prisma-tenant", () => {
  const tx = {
    tenant: {
      findUnique: async () => (st.tenant ? { ...st.tenant } : null),
      updateMany: async (args: { where: Row; data: Row }) => {
        st.writes.push(args);
        if (!st.tenant) return { count: 0 };
        Object.assign(st.tenant, args.data);
        return { count: 1 };
      },
    },
    user: { updateMany: async (a: unknown) => { st.writes.push(a); return { count: 1 }; } },
    member: { findMany: async () => [], updateMany: async (a: unknown) => { st.writes.push(a); return { count: 1 }; } },
    auditLog: { findFirst: async () => null },
  };
  return {
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
    withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
  };
});
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ authed: true, named: true, operatorId: "op_1", operatorEmail: "op@example.test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (a: unknown) => { st.audit.push(a); }) }));
vi.mock("@/lib/operator-step-up", () => ({
  requireStepUp: async () => { st.stepUpCalls += 1; return st.stepUp; },
  stepUpTarget: (t: string) => t,
}));

import { POST } from "@/app/api/admin/customers/[id]/suspend/route";

const params = { params: Promise.resolve({ id: "t1" }) };
const post = () =>
  POST(
    new Request("http://localhost/api/admin/customers/t1/suspend", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Unpaid for three months" }),
    }),
    params,
  );

beforeEach(() => {
  st.writes = [];
  st.audit = [];
  st.stepUp = null;
  st.stepUpCalls = 0;
});

describe("a refused suspend does not spend the step-up grant", () => {
  it("unknown club → 404, grant untouched", async () => {
    st.tenant = null;
    expect((await post()).status).toBe(404);
    expect(st.stepUpCalls).toBe(0);
  });

  it("already suspended → 409, grant untouched", async () => {
    st.tenant = { id: "t1", name: "BJJ", subscriptionStatus: "suspended", deletedAt: null };
    expect((await post()).status).toBe(409);
    expect(st.stepUpCalls).toBe(0);
  });

  it("soft-deleted → 409, grant untouched", async () => {
    st.tenant = { id: "t1", name: "BJJ", subscriptionStatus: "active", deletedAt: new Date("2026-10-01T00:00:00Z") };
    expect((await post()).status).toBe(409);
    expect(st.stepUpCalls).toBe(0);
  });

  it("a live club: the grant is checked once, and a refused grant writes nothing", async () => {
    st.tenant = { id: "t1", name: "BJJ", subscriptionStatus: "active", deletedAt: null };
    st.stepUp = new Response(JSON.stringify({ error: "Step-up required" }), { status: 403 });
    expect((await post()).status).toBe(403);
    expect(st.stepUpCalls).toBe(1);
    expect(st.writes).toEqual([]);
    expect(st.audit).toEqual([]);
    expect(st.tenant.subscriptionStatus).toBe("active");
  });

  it("control: a live club with a good grant suspends", async () => {
    st.tenant = { id: "t1", name: "BJJ", subscriptionStatus: "active", deletedAt: null };
    expect((await post()).status).toBe(200);
    expect(st.stepUpCalls).toBe(1);
    expect(st.tenant.subscriptionStatus).toBe("suspended");
  });
});
