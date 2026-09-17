// A register tick must not rewrite how an existing attendance row came to exist.
//
// POST /api/coach/instances/[id]/attendance with `attended:true` is an upsert.
// Its `update` branch used to be `{ checkInMethod: "admin" }`, so a coach whose
// register snapshot was loaded before a card scan — or a second coach's device —
// ticked the member and silently turned a `qr` row into an `admin` row while
// leaving `checkedInById` naming the scanner. The `qr` filter chip and the
// reports label are the surfaces that prove a card scan happened; this walked
// the row out of both. Plan X-5 §2-9 / A4-i.
//
// The row that was there stays exactly as it was. A member with no row still
// gets one, written as "admin" because a tick is a staff action.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  upsertMock,
  findManyMock,
  deleteManyMock,
  memberFindFirstMock,
  instanceFindFirstMock,
  logAuditMock,
  requireApiStaffMock,
} = vi.hoisted(() => ({
  upsertMock: vi.fn(),
  findManyMock: vi.fn(),
  deleteManyMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  instanceFindFirstMock: vi.fn(),
  logAuditMock: vi.fn(),
  requireApiStaffMock: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: requireApiStaffMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: instanceFindFirstMock },
      member: { findFirst: memberFindFirstMock },
      attendanceRecord: { upsert: upsertMock, findMany: findManyMock, deleteMany: deleteManyMock },
    }),
}));

type Route = typeof import("@/app/api/coach/instances/[id]/attendance/route");
let POST: Route["POST"];

function req(body: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}
const params = Promise.resolve({ id: "inst_1" });

beforeEach(async () => {
  vi.clearAllMocks();
  requireApiStaffMock.mockResolvedValue({
    ok: true,
    tenantId: "tenant_a",
    userId: "user_coach",
    role: "coach",
  });
  instanceFindFirstMock.mockResolvedValue({ id: "inst_1" });
  memberFindFirstMock.mockResolvedValue({ id: "mem_1" });
  upsertMock.mockResolvedValue({});
  ({ POST } = await import("@/app/api/coach/instances/[id]/attendance/route"));
});

describe("POST /api/coach/instances/[id]/attendance — attended:true", () => {
  it("leaves an existing row untouched: the upsert's update branch writes nothing", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0];
    // The load-bearing assertion. `{ checkInMethod: "admin" }` here rewrites a
    // scanned row's method while keeping the scanner as actor.
    expect(args.update).toEqual({});
  });

  it("still creates a row for a member who has none, as a staff action", async () => {
    await POST(req({ memberId: "mem_1", attended: true }), { params });
    const args = upsertMock.mock.calls[0][0];
    expect(args.create).toMatchObject({
      tenantId: "tenant_a",
      memberId: "mem_1",
      classInstanceId: "inst_1",
      checkInMethod: "admin",
    });
    expect(args.where).toEqual({
      memberId_classInstanceId: { memberId: "mem_1", classInstanceId: "inst_1" },
    });
  });

  it("audits the tick as attendance.mark", async () => {
    await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][0].action).toBe("attendance.mark");
  });
});
