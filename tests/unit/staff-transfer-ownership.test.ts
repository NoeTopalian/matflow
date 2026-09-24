/**
 * Owner-initiated ownership transfer (ADR-001 D7): the club always has
 * exactly one owner, the caller proves their password, both parties are
 * signed out by a session-version bump, and the action is audited.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const { authMock, findFirstMock, updateMock, logAuditMock, rateLimitMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  rateLimitMock: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => rateLimitMock(...a) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ user: { findFirst: findFirstMock, update: updateMock } })),
}));

import { POST } from "@/app/api/staff/[id]/transfer-ownership/route";

const HASH = bcrypt.hashSync("OwnerPass2026x", 4);
const OWNER = { user: { id: "user-owner", tenantId: "tenant-A", role: "owner" } };
const me = { id: "user-owner", email: "owner@club.test", name: "Olive Owner", passwordHash: HASH };
const target = { id: "user-mgr", email: "mgr@club.test", name: "Manny Manager", role: "manager" };
const req = (body: unknown) => new Request("http://localhost/api/staff/user-mgr/transfer-ownership", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id = "user-mgr") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(OWNER);
  rateLimitMock.mockResolvedValue({ allowed: true });
  findFirstMock.mockImplementation(async (args: { where: { role?: string; id?: string } }) => (args.where.role === "owner" ? me : target));
  updateMock.mockResolvedValue({});
});

describe("POST /api/staff/[id]/transfer-ownership", () => {
  it("with the right password: target becomes owner, caller becomes manager, both signed out, audited", async () => {
    const res = await POST(req({ password: "OwnerPass2026x" }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, newOwner: { id: "user-mgr" } });
    expect(updateMock).toHaveBeenCalledWith({ where: { id: "user-owner" }, data: { role: "manager", sessionVersion: { increment: 1 } } });
    expect(updateMock).toHaveBeenCalledWith({ where: { id: "user-mgr" }, data: { role: "owner", sessionVersion: { increment: 1 } } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "staff.ownership_transferred", entityId: "user-mgr", metadata: expect.objectContaining({ previousOwnerId: "user-owner", newOwnerId: "user-mgr", previousTargetRole: "manager" }) }));
  });

  it("a wrong password changes nothing", async () => {
    const res = await POST(req({ password: "nope" }), params());
    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("no password, self, an unknown target, and a target who is already owner are all refused", async () => {
    expect((await POST(req({}), params())).status).toBe(400);
    expect((await POST(req({ password: "OwnerPass2026x" }), params("user-owner"))).status).toBe(400);
    findFirstMock.mockImplementation(async (args: { where: { role?: string } }) => (args.where.role === "owner" ? me : null));
    expect((await POST(req({ password: "OwnerPass2026x" }), params("user-ghost"))).status).toBe(404);
    findFirstMock.mockImplementation(async (args: { where: { role?: string } }) => (args.where.role === "owner" ? me : { ...target, role: "owner" }));
    expect((await POST(req({ password: "OwnerPass2026x" }), params())).status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("a manager cannot transfer ownership", async () => {
    authMock.mockResolvedValue({ user: { id: "user-mgr", tenantId: "tenant-A", role: "manager" } });
    expect((await POST(req({ password: "x" }), params("user-coach"))).status).toBe(403);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("a password-less owner is pointed at support rather than let through", async () => {
    findFirstMock.mockImplementation(async (args: { where: { role?: string } }) => (args.where.role === "owner" ? { ...me, passwordHash: null } : target));
    const res = await POST(req({ password: "anything" }), params());
    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    expect((await POST(req({ password: "OwnerPass2026x" }), params())).status).toBe(429);
  });
});
