/**
 * POST /api/member/tasks/[id]/complete — who the tick is attributed to.
 *
 * Lane L-F round 2. On a member session `session.user.id` is the MEMBER's id
 * (auth.ts member branch), while `Task.completedById` and `AuditLog.userId` are
 * foreign keys to USER. The route used to write the member id straight into
 * `completedById`, which Postgres rejected; the exception was not caught, so
 * every member ticking their own action got an empty 500 and the portal rolled
 * the tick back (tests/e2e/campaign/assess/lf-2-pages-and-push.spec.ts:83,
 * round-2 log: "Expected 200, Received 500").
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: vi.fn() },
    user: { findFirst: vi.fn() },
    task: { updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";

const mockAuth = vi.mocked(auth);
const mockMemberFind = vi.mocked(prisma.member.findFirst);
const mockUserFind = vi.mocked(prisma.user.findFirst);
const mockTaskUpdate = vi.mocked(prisma.task.updateMany);
const mockTaskFind = vi.mocked(prisma.task.findFirst);
const mockAudit = vi.mocked(logAudit);

/** A member session: `id` is the member id, exactly as auth.ts mints it. */
function memberSession() {
  mockAuth.mockResolvedValue({
    user: { id: "mem-1", memberId: "mem-1", tenantId: "tenant-A" },
  } as never);
}

const req = { headers: { get: () => null } } as unknown as Request;
const params = Promise.resolve({ id: "task-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberFind.mockResolvedValue({ email: "jordan@example.com" } as never);
});

describe("POST /api/member/tasks/[id]/complete — attribution", () => {
  it("never writes the member id into completedById (the User foreign key)", async () => {
    memberSession();
    mockUserFind.mockResolvedValue(null as never);
    mockTaskUpdate.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    const data = mockTaskUpdate.mock.calls[0][0].data as { completedById?: string | null };
    expect(data.completedById, "a member with no staff account is NULL, never 'mem-1'").toBeNull();
  });

  it("resolves the member's own staff User row when they have one", async () => {
    memberSession();
    mockUserFind.mockResolvedValue({ id: "usr-9" } as never);
    mockTaskUpdate.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    const res = await POST(req, { params });

    expect(res.status).toBe(200);
    expect(mockUserFind.mock.calls[0][0]!.where).toEqual({
      tenantId: "tenant-A",
      email: "jordan@example.com",
    });
    const data = mockTaskUpdate.mock.calls[0][0].data as { completedById?: string | null };
    expect(data.completedById).toBe("usr-9");
  });

  it("audits the tick against the resolved User, never the member id", async () => {
    memberSession();
    mockUserFind.mockResolvedValue({ id: "usr-9" } as never);
    mockTaskUpdate.mockResolvedValue({ count: 1 } as never);

    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    await POST(req, { params });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const entry = mockAudit.mock.calls[0][0];
    expect(entry.userId).toBe("usr-9");
    // The member is still named — attribution is not lost when userId is NULL.
    expect(entry.metadata?.memberId).toBe("mem-1");
  });

  it("a second tick on a done action is a 409 and writes nothing", async () => {
    memberSession();
    mockUserFind.mockResolvedValue(null as never);
    mockTaskUpdate.mockResolvedValue({ count: 0 } as never);
    mockTaskFind.mockResolvedValue({
      id: "task-1", status: "done", assigneeMemberId: "mem-1", kind: "member_note",
    } as never);

    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    const res = await POST(req, { params });

    expect(res.status).toBe(409);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("another member's action is a 404 that says nothing about it", async () => {
    memberSession();
    mockUserFind.mockResolvedValue(null as never);
    mockTaskUpdate.mockResolvedValue({ count: 0 } as never);
    mockTaskFind.mockResolvedValue({
      id: "task-1", status: "open", assigneeMemberId: "mem-2", kind: "member_note",
    } as never);

    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    const res = await POST(req, { params });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("a sys: sentinel never reaches the database", async () => {
    memberSession();
    const { POST } = await import("@/app/api/member/tasks/[id]/complete/route");
    const res = await POST(req, { params: Promise.resolve({ id: "sys:waiver" }) });

    expect(res.status).toBe(400);
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });
});
