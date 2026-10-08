import { vi, describe, it, expect, beforeEach } from "vitest";

// POST /api/admin/customers/[id]/owner-profile (8 Oct 2026, account-editing
// lane R, story C4): a named MFA operator corrects the club owner's display
// name. Pins: operator gate first; strict body (name + reason only — no
// password, authenticator, role, tenant, email); reason >= 10; checks that
// need no secret run before the step-up grant is spent; the grant is bound to
// "owner.profile" on THIS club's THIS owner for the "name" sub-action; the
// write is conditional on the name read (409 when it moved); audit in the same
// transaction with before/after and the operator as actor; sessions untouched.

const h = vi.hoisted(() => ({
  isAdminAuthed: vi.fn(async () => true),
  requireStepUp: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  logAudit: vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => {}),
  owner: null as null | Record<string, unknown>,
}));

const tx = {
  user: {
    findFirst: vi.fn(async () => h.owner),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async () => ({})),
  },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: h.isAdminAuthed }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ operatorId: "op-1", named: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
// The REAL stepUpTarget: the binding string is what is pinned.
vi.mock("@/lib/operator-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator-step-up")>()),
  requireStepUp: h.requireStepUp,
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));

import { POST } from "@/app/api/admin/customers/[id]/owner-profile/route";
import { STEP_UP_ACTIONS } from "@/lib/operator-step-up";

const call = (body: unknown, tenant = "tenant-A") =>
  POST(
    new Request(`http://localhost/api/admin/customers/${tenant}/owner-profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: tenant }) },
  );
const good = { name: "Sean Example", reason: "owner asked by phone, ticket 42" };

beforeEach(() => {
  vi.clearAllMocks();
  h.isAdminAuthed.mockResolvedValue(true);
  h.requireStepUp.mockResolvedValue(null);
  h.owner = { id: "owner-1", name: "Placeholder Owner" };
  tx.user.updateMany.mockResolvedValue({ count: 1 });
});

describe("operator owner-profile — gates", () => {
  it("refuses a non-operator before anything else", async () => {
    h.isAdminAuthed.mockResolvedValue(false);
    const res = await call(good);
    expect(res.status).toBe(403);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(h.requireStepUp).not.toHaveBeenCalled();
  });

  it("owner.profile is a step-up action the grant route will issue", () => {
    expect(STEP_UP_ACTIONS).toContain("owner.profile");
  });

  it("demands a step-up grant bound to owner.profile on THIS tenant's THIS owner for the name sub-action", async () => {
    await call(good);
    expect(h.requireStepUp).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ operatorId: "op-1" }),
      "owner.profile",
      "tenant-A/owner-1/name",
    );
  });

  it("a refused step-up writes nothing", async () => {
    h.requireStepUp.mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 403 }));
    const res = await call(good);
    expect(res.status).toBe(403);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses a tenant with no owner (404) before spending the grant", async () => {
    h.owner = null;
    const res = await call(good);
    expect(res.status).toBe(404);
    expect(h.requireStepUp).not.toHaveBeenCalled();
  });

  it("refuses an unchanged name before spending the grant", async () => {
    const res = await call({ ...good, name: "Placeholder Owner" });
    expect(res.status).toBe(400);
    expect(h.requireStepUp).not.toHaveBeenCalled();
  });
});

describe("operator owner-profile — body", () => {
  it.each([
    ["a short reason", { name: "Sean Example", reason: "short" }],
    ["no reason", { name: "Sean Example" }],
    ["a blank name", { name: "  ", reason: good.reason }],
    ["a right-to-left override in the name", { name: "Sean\u202EOwner", reason: good.reason }],
    ["a C1 control in the name", { name: "Sean\u009BOwner", reason: good.reason }],
    ["a line separator in the name", { name: "Sean\u2028Owner", reason: good.reason }],
    ["a password", { ...good, password: "ChosenPass1" }],
    ["a temporary password", { ...good, tempPassword: "ChosenPass1" }],
    ["an authenticator secret", { ...good, totpSecret: "AAAA" }],
    ["totpEnabled", { ...good, totpEnabled: false }],
    ["a role", { ...good, role: "admin" }],
    ["a tenant", { ...good, tenantId: "tenant-B" }],
    ["an email", { ...good, email: "x@example.com" }],
    ["a user id", { ...good, userId: "someone-else" }],
  ])("refuses %s (400), nothing written, no grant spent", async (_k, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(h.requireStepUp).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("operator owner-profile — change", () => {
  it("updates only the name, conditional on the name read, audits before/after with the operator as actor", async () => {
    const res = await call(good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Sean Example" });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "owner-1", tenantId: "tenant-A", role: "owner", name: "Placeholder Owner" },
      data: { name: "Sean Example" },
    });
    expect(tx.user.update).not.toHaveBeenCalled();
    const audit = h.logAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      tx, tenantId: "tenant-A", userId: "owner-1", action: "admin.owner.profile.updated", entityId: "owner-1",
      actAsUserId: "op-1",
      metadata: { reason: good.reason, changed: ["name"], before: { name: "Placeholder Owner" }, after: { name: "Sean Example" } },
    });
    // Not a credential: no session bump.
    expect(JSON.stringify(tx.user.updateMany.mock.calls[0])).not.toContain("sessionVersion");
  });

  it("the owner is looked up in THIS tenant only", async () => {
    await call(good, "tenant-Z");
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-Z", role: "owner" } }));
  });

  it("a name that moved in between is a 409, nothing audited", async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    const res = await call(good);
    expect(res.status).toBe(409);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an audit failure fails the change (500)", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await call(good);
    expect(res.status).toBe(500);
  });
});
