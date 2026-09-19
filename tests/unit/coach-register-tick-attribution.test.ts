// A staff mark names the staff member who made it.
//
// Every other check-in path stamps `checkedInById`: `POST /api/checkin` sets it
// from the session (`route.ts:151`), the card scanner sets it to the coach
// holding the tablet. `POST /api/coach/instances/[id]/attendance` created its
// row with `{ tenantId, memberId, classInstanceId, checkInMethod: "admin" }`
// and nothing else — so every row it wrote was a staff mark nobody signed, and
// AttendanceView's "by [name]" rendered blank for it.
//
// The route is reachable by any staff session, so "no screen calls it today"
// is not a defence: it is an unattributed writer sitting on the attendance
// table. Attributing it is the smaller change than removing it, and it makes
// the route agree with the other two.

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

const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;
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
  findManyMock.mockResolvedValue([]);
  ({ POST } = await import("@/app/api/coach/instances/[id]/attendance/route"));
});

describe("POST /api/coach/instances/[id]/attendance — attribution", () => {
  it("stamps the staff user who ticked on the row it creates", async () => {
    await POST(req({ memberId: "mem_1", attended: true }), { params });

    const args = upsertMock.mock.calls[0][0];
    expect(args.create.checkedInById).toBe("user_coach");
  });

  it("keeps the rest of the created row exactly as it was", async () => {
    await POST(req({ memberId: "mem_1", attended: true }), { params });

    const args = upsertMock.mock.calls[0][0];
    expect(args.create).toEqual({
      tenantId: "tenant_a",
      memberId: "mem_1",
      classInstanceId: "inst_1",
      checkInMethod: "admin",
      checkedInById: "user_coach",
    });
  });

  it("does NOT re-attribute a row that already exists — the update branch stays empty", async () => {
    // The other half of the same route, proved here so attributing the create
    // cannot quietly grow an update. A tick on someone already in is presence,
    // not authorship: rewriting `checkedInById` would take a scanned row away
    // from the coach who scanned it.
    await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(upsertMock.mock.calls[0][0].update).toEqual({});
  });

  it("names the marker whichever staff role holds the session", async () => {
    requireApiStaffMock.mockResolvedValue({
      ok: true,
      tenantId: "tenant_a",
      userId: "user_manager",
      role: "manager",
    });
    await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(upsertMock.mock.calls[0][0].create.checkedInById).toBe("user_manager");
  });

  it("un-ticking is unaffected — it deletes, it does not attribute", async () => {
    findManyMock.mockResolvedValue([{ id: "att_1" }]);
    const res = await POST(req({ memberId: "mem_1", attended: false }), { params });

    expect(res.status).toBe(200);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(deleteManyMock).toHaveBeenCalled();
  });
});
