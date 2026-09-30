// A staff mark writes an audit row. The coach register's raw upsert used to
// be the only staff mark that did; every screen now marks through
// POST /api/checkin (18 Sep 2026), so the row moves here. A member's own
// check-in is not a staff action and writes none. X-9 Task 4.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const { authMock, performCheckinMock, logAuditMock, memberFindFirstMock, instanceFindFirstMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  performCheckinMock: vi.fn(),
  logAuditMock: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  memberFindFirstMock: vi.fn(),
  instanceFindFirstMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/checkin", () => ({ performCheckin: performCheckinMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: memberFindFirstMock },
      classInstance: { findFirst: instanceFindFirstMock },
    }),
}));

function req(body: unknown) {
  return new Request("http://test/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/checkin audit row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    performCheckinMock.mockResolvedValue({ kind: "success", record: { id: "rec-1" }, coverage: null });
    memberFindFirstMock.mockResolvedValue({ id: "mem-1" });
    instanceFindFirstMock.mockResolvedValue({ id: "inst-1" });
  });

  it("writes attendance.mark for a staff mark, in the same shape as attendance.unmark", async () => {
    authMock.mockResolvedValue({ user: { id: "coach-1", role: "coach", tenantId: "t1" } });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req({ classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(res.status).toBe(201);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      tenantId: "t1",
      userId: "coach-1",
      action: "attendance.mark",
      entityType: "AttendanceRecord",
      entityId: "inst-1:mem-1",
      metadata: { classInstanceId: "inst-1", memberId: "mem-1", method: "admin" },
    });
  });

  // Functional review round 3 (F11): a member's own check-in wrote no row.
  it("writes attendance.self_checkin for a member's own check-in, the member as actor", async () => {
    authMock.mockResolvedValue({ user: { id: "u-mem", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@x" } });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req({ classInstanceId: "inst-1" }));
    expect(res.status).toBe(201);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const args = logAuditMock.mock.calls[0][0];
    expect(args).toMatchObject({
      tenantId: "t1",
      userId: "mem-1",
      action: "attendance.self_checkin",
      entityType: "AttendanceRecord",
      entityId: "rec-1",
      metadata: { classInstanceId: "inst-1", memberId: "mem-1", method: "self" },
    });
    expect((args.metadata as Record<string, unknown>).onBehalfOf).toBeUndefined();
  });

  it("a parent checking in their child: the parent is the actor, the child the member", async () => {
    authMock.mockResolvedValue({ user: { id: "u-par", role: "member", tenantId: "t1", memberId: "par-1" } });
    memberFindFirstMock.mockResolvedValue({ id: "kid-1" });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req({ classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(res.status).toBe(201);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      userId: "par-1",
      action: "attendance.self_checkin",
      entityId: "rec-1",
      metadata: { classInstanceId: "inst-1", memberId: "kid-1", onBehalfOf: "kid-1" },
    });
  });

  it("writes nothing when the check-in is refused", async () => {
    authMock.mockResolvedValue({ user: { id: "u-mem", role: "member", tenantId: "t1", memberId: "mem-1" } });
    performCheckinMock.mockResolvedValue({ kind: "class_not_found" });
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req({ classInstanceId: "inst-1" }));
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
