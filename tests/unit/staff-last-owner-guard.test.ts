/**
 * Last-owner protection (ADR-001 D7, execution prompt §4 "prevent orphaning a
 * club by removing its last owner").
 *
 * The staff route already refuses every path that could leave a club without
 * an owner: the edit schema cannot name "owner" as a role, an owner row cannot
 * be edited or deleted (the WHERE excludes it), and nobody deletes themselves.
 * Ownership moves only through the operator's audited transfer route, which
 * promotes the new owner in the same transaction. These cases pin that so a
 * later "let owners edit owners" change cannot quietly reopen the hole.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { authMock, updateManyMock, deleteManyMock, findFirstMock, logAuditMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  updateManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/auth", () => ({ auth: () => authMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ user: { updateMany: updateManyMock, deleteMany: deleteManyMock, findFirst: findFirstMock } })),
}));

const OWNER = { user: { id: "user-owner", tenantId: "tenant-A", role: "owner" } };
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/staff/x", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(OWNER);
  updateManyMock.mockResolvedValue({ count: 0 });
  deleteManyMock.mockResolvedValue({ count: 0 });
  findFirstMock.mockResolvedValue(null);
});

describe("staff/[id] — a club can never lose its last owner through this route", () => {
  it("the edit schema cannot promote anyone to owner", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    const res = await PATCH(req("PATCH", { role: "owner" }), params("user-manager"));
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("an owner row cannot be edited: the WHERE excludes owners and the miss reads as not found", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    const res = await PATCH(req("PATCH", { role: "coach" }), params("user-owner-2"));
    expect(res.status).toBe(404);
    expect(updateManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: { not: "owner" } }) }));
  });

  it("an owner row cannot be deleted, and the miss reads as not found", async () => {
    const { DELETE } = await import("@/app/api/staff/[id]/route");
    const res = await DELETE(req("DELETE"), params("user-owner-2"));
    expect(res.status).toBe(404);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: "user-owner-2", tenantId: "tenant-A", role: { not: "owner" } } });
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("an owner cannot delete themselves", async () => {
    const { DELETE } = await import("@/app/api/staff/[id]/route");
    const res = await DELETE(req("DELETE"), params("user-owner"));
    expect(res.status).toBe(400);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("a manager cannot edit or remove staff at all", async () => {
    authMock.mockResolvedValue({ user: { id: "user-mgr", tenantId: "tenant-A", role: "manager" } });
    const { PATCH, DELETE } = await import("@/app/api/staff/[id]/route");
    expect((await PATCH(req("PATCH", { role: "coach" }), params("user-coach"))).status).toBe(403);
    expect((await DELETE(req("DELETE"), params("user-coach"))).status).toBe(403);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});
