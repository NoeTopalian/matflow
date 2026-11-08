import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * PR 3 (6 Nov 2026; Noe: "Save all past user data"): DELETE /api/members/[id]
 * ARCHIVES. It calls the archive helper, records `member.archive`, and deletes
 * nothing: no row (the helper is the only writer) and no photo file (the
 * Blob API is never called — the old hard delete removed every photo file).
 * The archive helper itself is covered by tests/unit/member-archive-helper
 * .test.ts and, against Postgres, tests/integration/member-archive-db.test.ts.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));

const { memberFindFirstMock, tenantFindUniqueMock, cancelSubMock, archiveHelperMock, delMock, logAuditMock } = vi.hoisted(() => ({
  memberFindFirstMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  cancelSubMock: vi.fn(),
  archiveHelperMock: vi.fn(),
  delMock: vi.fn(),
  logAuditMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

const fakeTx = {
  $queryRaw: async () => [],
  member: { findFirst: memberFindFirstMock },
  tenant: { findUnique: tenantFindUniqueMock },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakeTx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: cancelSubMock }));
vi.mock("@/lib/member-delete", () => ({ archiveParentMemberWithKidsResolution: archiveHelperMock }));
vi.mock("@vercel/blob", () => ({ del: delMock }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const TENANT = "tenant-A";
const PHOTO = `https://store123.blob.vercel-storage.com/tenants/${TENANT}/photo-a.webp`;

async function callDelete(id: string, query = "confirm=1") {
  const { DELETE } = await import("@/app/api/members/[id]/route");
  const req = new Request(`https://test.local/api/members/${id}?${query}`, {
    method: "DELETE",
    headers: { origin: "https://test.local", host: "test.local" },
  });
  return DELETE(req as never, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: TENANT, email: "owner@gym.test" } } as never);
  tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: null });
  archiveHelperMock.mockResolvedValue({ kind: "ok", name: "Sam Fighter", kidsAffected: 0, kidIds: [] });
  memberFindFirstMock.mockResolvedValue({
    id: "m-1",
    name: "Sam Fighter",
    stripeSubscriptionId: null,
    photos: [{ id: "p-1", url: PHOTO }],
    children: [],
  });
});

describe("DELETE /api/members/[id] archives the member", () => {
  it("archives through the helper, audits member.archive and deletes no photo file", async () => {
    const res = await callDelete("m-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, archived: true, kidsAffected: 0 });
    expect(archiveHelperMock).toHaveBeenCalledTimes(1);
    const [, where, strategy, by] = archiveHelperMock.mock.calls[0];
    expect(where).toEqual({ id: "m-1", tenantId: TENANT });
    expect(strategy).toBeUndefined();
    expect(by).toMatchObject({ userId: "u-owner" });
    expect(by.at).toBeInstanceOf(Date);
    expect(delMock).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.archive", entityId: "m-1" }));
    expect(logAuditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "member.delete" }));
  });

  it("only looks at current members: an already-archived member is not found", async () => {
    memberFindFirstMock.mockResolvedValue(null);
    const res = await callDelete("m-1");
    expect(res.status).toBe(404);
    expect(archiveHelperMock).not.toHaveBeenCalled();
    expect(memberFindFirstMock.mock.calls[0][0].where).toMatchObject({ id: "m-1", tenantId: TENANT, archivedAt: null });
  });

  it("cascade passes the strategy and audits the kids it archived", async () => {
    archiveHelperMock.mockResolvedValue({ kind: "ok", name: "Parent", kidsAffected: 2, kidIds: ["k1", "k2"] });
    const res = await callDelete("m-1", "strategy=cascade");
    expect(res.status).toBe(200);
    expect(archiveHelperMock.mock.calls[0][2]).toEqual({ kind: "cascade" });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member.archive", metadata: expect.objectContaining({ strategy: "cascade", kidIds: ["k1", "k2"], kidsAffected: 2 }) }),
    );
    expect(delMock).not.toHaveBeenCalled();
  });

  it("is owner only", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-mgr", role: "manager", tenantId: TENANT } } as never);
    const res = await callDelete("m-1");
    expect(res.status).toBe(403);
    expect(archiveHelperMock).not.toHaveBeenCalled();
  });

  it("writes nothing on the kids-present picker response", async () => {
    archiveHelperMock.mockResolvedValue({ kind: "kids-present", kids: [{ id: "k1", name: "Kid" }] });
    const res = await callDelete("m-1", "confirm=1");
    expect(res.status).toBe(409);
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });
});
