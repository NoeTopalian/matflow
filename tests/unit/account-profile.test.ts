import { vi, describe, it, expect, beforeEach } from "vitest";

// /api/account/profile (8 Oct 2026, account-editing lane R, story C1): the
// signed-in staff user edits their OWN display name. Pins: strict body (any
// other key — role, tenantId, email, verification flags, totp*, password
// flags, sessionVersion — is a 400 with nothing written); session user only
// (no id is accepted, the write is scoped to session id + tenant); support,
// member, code-owing and temporary-password sessions refused; audit in the
// same transaction with before/after of the name only; this device's token is
// re-issued with the new name, sessionVersion untouched.

const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  logAudit: vi.fn<(args: Record<string, unknown>) => Promise<void>>(async () => {}),
  row: null as null | Record<string, unknown>,
  token: null as null | Record<string, unknown>,
  encode: vi.fn<(args: { token: Record<string, unknown> }) => Promise<string>>(async () => "re-issued-jwt"),
}));

const tx = {
  user: {
    findFirst: vi.fn(async () => h.row),
    updateMany: vi.fn(async () => ({ count: 1 })),
    update: vi.fn(async () => ({})),
  },
};

vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("next-auth/jwt", () => ({ getToken: async () => h.token, encode: h.encode }));

import { GET, PATCH } from "@/app/api/account/profile/route";

const staffSession = (extra: Record<string, unknown> = {}) => ({
  user: { id: "owner-1", tenantId: "tenant-A", role: "owner", totpPending: false, mustChangePassword: false, requireTotpSetup: false, ...extra },
});
const patch = (body: unknown) =>
  PATCH(new Request("http://localhost/api/account/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  h.session = staffSession();
  h.row = { id: "owner-1", name: "Old Name", email: "owner@club.example", role: "owner", loginEmailProvisionalSince: null, totpEnabled: true };
  h.token = { id: "owner-1", name: "Old Name", sessionVersion: 3, tenantId: "tenant-A" };
  tx.user.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/account/profile", () => {
  it("returns the session user's own profile, scoped to session id + tenant", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Old Name", email: "owner@club.example", role: "owner", loginEmailProvisional: false, totpEnabled: true,
    });
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "owner-1", tenantId: "tenant-A" } }));
  });
  it("refuses a signed-out caller (401) and a member (403)", async () => {
    h.session = null;
    expect((await GET()).status).toBe(401);
    h.session = { user: { id: "m1", tenantId: "tenant-A", role: "member" } };
    expect((await GET()).status).toBe(403);
  });
});

describe("PATCH /api/account/profile — success", () => {
  it("saves the trimmed name for the session user, audits before/after in the transaction, re-issues the token", async () => {
    const res = await patch({ name: "  Sean Example  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Sean Example", sessionRefreshed: true });
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: "owner-1", tenantId: "tenant-A" }, data: { name: "Sean Example" } });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const audit = h.logAudit.mock.calls[0][0];
    expect(audit).toMatchObject({
      tx, tenantId: "tenant-A", userId: "owner-1", action: "user.profile.updated", entityType: "User", entityId: "owner-1",
      metadata: { changed: ["name"], before: { name: "Old Name" }, after: { name: "Sean Example" } },
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/password|secret|totp|code/i);
    // Token re-issued with the new name, version untouched (a name is not a credential).
    expect(h.encode).toHaveBeenCalledTimes(1);
    expect(h.encode.mock.calls[0][0].token).toMatchObject({ id: "owner-1", name: "Sean Example", sessionVersion: 3 });
    expect(res.headers.get("set-cookie") ?? "").toContain("re-issued-jwt");
  });

  it.each(["manager", "coach", "admin"])("a %s can edit their own name", async (role) => {
    h.session = staffSession({ id: "u-2", role });
    h.token = { id: "u-2", name: "Old Name", sessionVersion: 0 };
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: "u-2", tenantId: "tenant-A" }, data: { name: "New Name" } });
  });

  it("an unchanged name writes nothing and audits nothing", async () => {
    const res = await patch({ name: "Old Name" });
    expect(res.status).toBe(200);
    expect((await res.json()).unchanged).toBe(true);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("never re-issues a token that belongs to someone else (token.id !== session user)", async () => {
    h.token = { id: "someone-else", name: "Other", sessionVersion: 9 };
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionRefreshed).toBe(false);
    expect(h.encode).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("says when this device's token could not be refreshed (name shows after next sign-in)", async () => {
    h.token = null;
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionRefreshed).toBe(false);
    expect(h.encode).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/account/profile — no mass assignment", () => {
  it.each([
    ["role", { name: "X", role: "owner" }],
    ["tenantId", { name: "X", tenantId: "tenant-B" }],
    ["email", { name: "X", email: "attacker@example.com" }],
    ["id", { name: "X", id: "someone-else" }],
    ["loginEmailProvisionalSince", { name: "X", loginEmailProvisionalSince: null }],
    ["totpEnabled", { name: "X", totpEnabled: false }],
    ["totpSecret", { name: "X", totpSecret: "AAAA" }],
    ["mustChangePassword", { name: "X", mustChangePassword: false }],
    ["sessionVersion", { name: "X", sessionVersion: 0 }],
    ["passwordHash", { name: "X", passwordHash: "$2a$x" }],
    ["notifyOnNewLogin", { name: "X", notifyOnNewLogin: false }],
    ["role only", { role: "owner" }],
  ])("refuses %s (400), nothing written, nothing audited", async (_k, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "x".repeat(101)],
    ["a line break", "Sean\nOwner"],
    ["a C1 control (U+0085)", "Sean\u0085Owner"],
    ["a line separator (U+2028)", "Sean\u2028Owner"],
    ["a paragraph separator (U+2029)", "Sean\u2029Owner"],
    ["a right-to-left override (U+202E)", "Sean\u202EOwner"],
    ["a left-to-right embedding (U+202A)", "Sean\u202AOwner"],
    ["a first-strong isolate (U+2068)", "Sean\u2068Owner"],
    ["a pop-directional isolate (U+2069)", "Sean\u2069Owner"],
    ["not a string", 42],
  ])("refuses a name that is %s", async (_k, name) => {
    expect((await patch({ name })).status).toBe(400);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/account/profile — refusals", () => {
  it.each([
    ["signed out", null, 401],
    ["a member", { user: { id: "m1", tenantId: "tenant-A", role: "member" } }, 403],
    ["a sign-in still owing its code", staffSession({ totpPending: true }), 403],
    ["a temporary-password session", staffSession({ mustChangePassword: true }), 403],
    ["an elevated role not yet enrolled", staffSession({ requireTotpSetup: true }), 403],
    ["a support session", staffSession({ impersonatedBy: "op-1" }), 403],
  ])("refuses %s, nothing written", async (_label, session, status) => {
    h.session = session as never;
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(status);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a session whose row is gone (or in another club) writes nothing: 401", async () => {
    h.row = null;
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(401);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("an audit failure fails the change (same transaction): 500, nothing reported saved", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await patch({ name: "New Name" });
    expect(res.status).toBe(500);
    expect(h.encode).not.toHaveBeenCalled();
  });
});
