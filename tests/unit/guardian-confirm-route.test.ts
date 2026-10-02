import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * POST /api/members/[id]/guardian (2 Oct 2026): confirm or reject a guardian
 * link an import SUGGESTED. Owner + manager; tenant-scoped; an under-13's only
 * link cannot be rejected; adopting the payer address refuses a collision;
 * audited member.guardian.confirmed / rejected.
 */
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ ok: false, error: message }), headers: new Headers() }),
}));

const { logAuditMock, gateMock, memberFindFirst, memberUpdate, memberUpdateMany } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  gateMock: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn().mockResolvedValue({}),
  memberUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: gateMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ member: { findFirst: memberFindFirst, update: memberUpdate, updateMany: memberUpdateMany } })),
}));

const req = (body: unknown) =>
  new Request("http://localhost/api/members/k1/guardian", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "k1" }) };

const kid = (over: Record<string, unknown> = {}) => ({ id: "k1", name: "Kit", accountType: "kids", parentMemberId: "p1", guardianConfirmedAt: null, guardianSuggestedBy: "emergency_contact", ...over });
const parent = (over: Record<string, unknown> = {}) => ({ id: "p1", name: "Pat", email: "adult-abc@no-login.matflow.local", unverifiedEmail: "pat@example.test", accountType: "parent", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u-owner", role: "owner" });
  memberUpdateMany.mockResolvedValue({ count: 1 });
});

describe("guardian confirm / reject", () => {
  it("confirm sets guardianConfirmedAt on the child, scoped to tenant and parent, and audits", async () => {
    memberFindFirst.mockResolvedValueOnce(kid()).mockResolvedValueOnce(parent());
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    const res = await POST(req({ action: "confirm" }) as never, params);
    expect(res.status).toBe(200);
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: "p1" },
      data: { guardianConfirmedAt: expect.any(Date), guardianSuggestedBy: "emergency_contact" },
    });
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.guardian.confirmed", entityId: "k1", tenantId: "t1" }));
  });

  it("confirm with adoptUnverifiedEmail promotes the payer address to the login when free, refuses when taken", async () => {
    memberFindFirst.mockResolvedValueOnce(kid()).mockResolvedValueOnce(parent()).mockResolvedValueOnce(null); // email not taken
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    const ok = await POST(req({ action: "confirm", adoptUnverifiedEmail: true }) as never, params);
    expect(ok.status).toBe(200);
    expect(memberUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { email: "pat@example.test", unverifiedEmail: null } });

    vi.clearAllMocks();
    gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u-owner", role: "owner" });
    memberFindFirst.mockResolvedValueOnce(kid()).mockResolvedValueOnce(parent()).mockResolvedValueOnce({ id: "other" }); // taken
    const taken = await POST(req({ action: "confirm", adoptUnverifiedEmail: true }) as never, params);
    expect(taken.status).toBe(409);
    expect(memberUpdate).not.toHaveBeenCalled();
    expect(memberUpdateMany).not.toHaveBeenCalled();
  });

  it("reject on an under-13 is refused (a kid must keep a guardian); on a junior it clears the link", async () => {
    memberFindFirst.mockResolvedValueOnce(kid()).mockResolvedValueOnce(parent());
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    const refused = await POST(req({ action: "reject" }) as never, params);
    expect(refused.status).toBe(409);
    expect(memberUpdateMany).not.toHaveBeenCalled();

    memberFindFirst.mockResolvedValueOnce(kid({ accountType: "junior" })).mockResolvedValueOnce(parent());
    const ok = await POST(req({ action: "reject" }) as never, params);
    expect(ok.status).toBe(200);
    expect(memberUpdateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1", parentMemberId: "p1" },
      data: { parentMemberId: null, guardianConfirmedAt: null, guardianSuggestedBy: null },
    });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.guardian.rejected" }));
  });

  it("a coach is refused; a child with no link is 404", async () => {
    gateMock.mockResolvedValueOnce({ ok: false, response: { status: 403, json: async () => ({}), headers: new Headers() } });
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    expect((await POST(req({ action: "confirm" }) as never, params)).status).toBe(403);
    memberFindFirst.mockResolvedValueOnce(kid({ parentMemberId: null }));
    expect((await POST(req({ action: "confirm" }) as never, params)).status).toBe(404);
  });
});
