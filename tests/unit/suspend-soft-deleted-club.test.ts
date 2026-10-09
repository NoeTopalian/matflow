/**
 * E2E finding (6 Oct 2026, low): suspend POST accepted a soft-deleted club
 * (200), and un-suspend then wrote an admitting status ("active") onto a club
 * whose deletedAt was still set. A club marked for deletion is closed; suspension
 * is not a state it can enter or leave. Both directions now refuse it with 409
 * and write nothing (no status flip, no session bumps, no audit row).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const st = vi.hoisted(() => ({
  tenant: null as null | Record<string, unknown>,
  writes: [] as Array<{ model: string; method: string; args: unknown }>,
  audit: [] as unknown[],
}));

function matches(row: Row, where: Row) {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

vi.mock("@/lib/prisma-tenant", () => {
  const tx = {
    tenant: {
      findUnique: async () => (st.tenant ? { ...st.tenant } : null),
      updateMany: async (args: { where: Row; data: Row }) => {
        st.writes.push({ model: "tenant", method: "updateMany", args });
        if (!st.tenant || !matches(st.tenant, args.where)) return { count: 0 };
        Object.assign(st.tenant, args.data);
        return { count: 1 };
      },
    },
    user: { updateMany: async (args: unknown) => { st.writes.push({ model: "user", method: "updateMany", args }); return { count: 1 }; } },
    member: {
      findMany: async () => [],
      updateMany: async (args: unknown) => { st.writes.push({ model: "member", method: "updateMany", args }); return { count: 1 }; },
    },
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
// Lane C (9 Oct 2026): requireStepUp returns the verified grant; the spend is
// consumeStepUpGrant inside the transaction (pinned in operator-step-up.test.ts).
vi.mock("@/lib/operator-step-up", () => ({
  requireStepUp: async () => ({ operatorId: "op_1", sessionVersion: 0, action: "tenant.suspend", targetId: "t1", tenantId: "t1", versionDigest: "v", requestId: "rq-test" }),
  consumeStepUpGrant: async () => ({ kind: "spent" }),
  refuseStepUp: () => new Response(null, { status: 403 }),
  StepUpRefusedError: class StepUpRefusedError extends Error {},
  stepUpTarget: (t: string) => t,
}));

import { POST, DELETE } from "@/app/api/admin/customers/[id]/suspend/route";

const params = { params: Promise.resolve({ id: "t1" }) };
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/admin/customers/t1/suspend", {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  st.writes = [];
  st.audit = [];
});

describe("a soft-deleted club cannot be suspended or un-suspended", () => {
  it("POST on a soft-deleted club → 409, nothing written", async () => {
    st.tenant = { id: "t1", name: "Closed BJJ", subscriptionStatus: "cancelled", deletedAt: new Date("2026-10-01T00:00:00Z"), suspendedPreviousStatus: null, suspensionBilling: null };
    const res = await POST(req("POST", { reason: "Unpaid for three months" }), params);
    expect(res.status).toBe(409);
    expect(st.writes).toEqual([]);
    expect(st.audit).toEqual([]);
    expect(st.tenant.subscriptionStatus).toBe("cancelled");
  });

  it("DELETE on a suspended-then-soft-deleted club → 409, status stays suspended, deletedAt kept", async () => {
    const deletedAt = new Date("2026-10-01T00:00:00Z");
    st.tenant = { id: "t1", name: "Closed BJJ", subscriptionStatus: "suspended", deletedAt, suspendedPreviousStatus: "active", suspensionBilling: { policy: "member-billing-unchanged" } };
    const res = await DELETE(req("DELETE"), params);
    expect(res.status).toBe(409);
    expect(st.writes).toEqual([]);
    expect(st.audit).toEqual([]);
    expect(st.tenant).toMatchObject({ subscriptionStatus: "suspended", deletedAt });
  });

  it("the flips are conditional on deletedAt: null (a soft-delete racing in between is a 409)", async () => {
    st.tenant = { id: "t1", name: "Live BJJ", subscriptionStatus: "active", deletedAt: null, suspendedPreviousStatus: null, suspensionBilling: null };
    expect((await POST(req("POST", { reason: "Unpaid for three months" }), params)).status).toBe(200);
    const flip = st.writes.find((w) => w.model === "tenant")!.args as { where: Row };
    expect(flip.where).toMatchObject({ deletedAt: null });

    st.writes = [];
    expect((await DELETE(req("DELETE"), params)).status).toBe(200);
    const back = st.writes.find((w) => w.model === "tenant")!.args as { where: Row };
    expect(back.where).toMatchObject({ deletedAt: null });
  });

  it("control: a live club still suspends and comes back", async () => {
    st.tenant = { id: "t1", name: "Live BJJ", subscriptionStatus: "trial", deletedAt: null, suspendedPreviousStatus: null, suspensionBilling: null };
    expect((await POST(req("POST", { reason: "Unpaid for three months" }), params)).status).toBe(200);
    expect(st.tenant.subscriptionStatus).toBe("suspended");
    expect((await DELETE(req("DELETE"), params)).status).toBe(200);
    expect(st.tenant.subscriptionStatus).toBe("trial");
  });
});
