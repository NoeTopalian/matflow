/**
 * P2-1 (audit 2026-08-16): check-in undo leaked a paid class-pack credit.
 *
 * Both undo paths deleted the AttendanceRecord and nothing else. Because
 * ClassPackRedemption.attendanceRecordId is a bare String with no FK, the
 * redemption row survived as an orphan and MemberClassPack.creditsRemaining
 * was never given back — the member paid for a class they no longer attended.
 *
 * Guarded here:
 *   1. DELETE /api/checkin                          (staff undo)
 *   2. POST /api/coach/instances/[id]/attendance    (coach unmark, attended:false)
 *
 * Both must, in the SAME transaction as the attendance delete: find the
 * redemptions for the records being deleted, delete them, and increment the
 * pack's creditsRemaining by one per redemption.
 */
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
  attendanceFindManyMock,
  attendanceDeleteManyMock,
  attendanceUpsertMock,
  redemptionFindManyMock,
  redemptionDeleteManyMock,
  packUpdateMock,
  memberFindFirstMock,
  classInstanceFindFirstMock,
  logAuditMock,
} = vi.hoisted(() => ({
  attendanceFindManyMock: vi.fn(),
  attendanceDeleteManyMock: vi.fn(),
  attendanceUpsertMock: vi.fn(),
  redemptionFindManyMock: vi.fn(),
  redemptionDeleteManyMock: vi.fn(),
  packUpdateMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  classInstanceFindFirstMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    attendanceRecord: {
      findMany: attendanceFindManyMock,
      deleteMany: attendanceDeleteManyMock,
      upsert: attendanceUpsertMock,
    },
    classPackRedemption: {
      findMany: redemptionFindManyMock,
      deleteMany: redemptionDeleteManyMock,
    },
    memberClassPack: { update: packUpdateMock },
    member: { findFirst: memberFindFirstMock },
    classInstance: { findFirst: classInstanceFindFirstMock },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", tenantId: "t-1", role: "owner", email: "owner@example.com" },
  })),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiStaff: vi.fn(async () => ({
    ok: true,
    session: {} as unknown,
    tenantId: "t-1",
    userId: "user-1",
    role: "owner",
  })),
}));

vi.mock("@/lib/authz", () => ({
  requireStaff: vi.fn(async () => ({
    session: {} as unknown,
    tenantId: "t-1",
    userId: "user-1",
    role: "owner",
  })),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

import { DELETE as staffUndo } from "@/app/api/checkin/route";
import { POST as coachAttendance } from "@/app/api/coach/instances/[id]/attendance/route";

beforeEach(() => {
  vi.clearAllMocks();
  memberFindFirstMock.mockResolvedValue({ id: "m-1" });
  classInstanceFindFirstMock.mockResolvedValue({ id: "ci-1" });
  attendanceDeleteManyMock.mockResolvedValue({ count: 1 });
  redemptionDeleteManyMock.mockResolvedValue({ count: 1 });
  packUpdateMock.mockResolvedValue({});
  logAuditMock.mockResolvedValue(undefined);
});

function staffUndoReq() {
  return new Request("http://localhost/api/checkin?classInstanceId=ci-1&memberId=m-1", {
    method: "DELETE",
  });
}

function coachUnmarkReq(attended: boolean) {
  return new Request("http://localhost/api/coach/instances/ci-1/attendance", {
    method: "POST",
    body: JSON.stringify({ memberId: "m-1", attended }),
  });
}
const coachParams = { params: Promise.resolve({ id: "ci-1" }) };

describe("DELETE /api/checkin — staff undo", () => {
  it("pack-covered check-in: deletes the redemption and gives the credit back", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "ar-1" }]);
    redemptionFindManyMock.mockResolvedValue([{ id: "red-1", memberPackId: "pack-1" }]);

    const res = await staffUndo(staffUndoReq());
    expect(res.status).toBe(200);

    expect(redemptionDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["red-1"] } } });
    expect(packUpdateMock).toHaveBeenCalledWith({
      where: { id: "pack-1" },
      data: { creditsRemaining: { increment: 1 } },
    });
    // Attendance is deleted by the ids we resolved, not a blind deleteMany.
    expect(attendanceDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["ar-1"] } } });
  });

  it("non-pack check-in: attendance deleted, no redemption or credit touched", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "ar-1" }]);
    redemptionFindManyMock.mockResolvedValue([]);

    const res = await staffUndo(staffUndoReq());
    expect(res.status).toBe(200);

    expect(attendanceDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(redemptionDeleteManyMock).not.toHaveBeenCalled();
    expect(packUpdateMock).not.toHaveBeenCalled();
  });

  it("nothing to undo: no attendance rows → no deletes at all", async () => {
    attendanceFindManyMock.mockResolvedValue([]);

    const res = await staffUndo(staffUndoReq());
    expect(res.status).toBe(200);

    expect(redemptionFindManyMock).not.toHaveBeenCalled();
    expect(attendanceDeleteManyMock).not.toHaveBeenCalled();
    expect(packUpdateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/coach/instances/[id]/attendance — unmark", () => {
  it("pack-covered attendance: unmark deletes the redemption and gives the credit back", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "ar-1" }]);
    redemptionFindManyMock.mockResolvedValue([{ id: "red-1", memberPackId: "pack-1" }]);

    const res = await coachAttendance(coachUnmarkReq(false), coachParams);
    expect(res.status).toBe(200);

    expect(redemptionDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["red-1"] } } });
    expect(packUpdateMock).toHaveBeenCalledWith({
      where: { id: "pack-1" },
      data: { creditsRemaining: { increment: 1 } },
    });
    expect(attendanceDeleteManyMock).toHaveBeenCalledWith({ where: { id: { in: ["ar-1"] } } });
  });

  it("non-pack attendance: unmark touches neither redemption nor credits", async () => {
    attendanceFindManyMock.mockResolvedValue([{ id: "ar-1" }]);
    redemptionFindManyMock.mockResolvedValue([]);

    const res = await coachAttendance(coachUnmarkReq(false), coachParams);
    expect(res.status).toBe(200);

    expect(attendanceDeleteManyMock).toHaveBeenCalledTimes(1);
    expect(redemptionDeleteManyMock).not.toHaveBeenCalled();
    expect(packUpdateMock).not.toHaveBeenCalled();
  });

  it("marking attended (not unmarking) leaves packs alone", async () => {
    attendanceUpsertMock.mockResolvedValue({ id: "ar-1" });

    const res = await coachAttendance(coachUnmarkReq(true), coachParams);
    expect(res.status).toBe(200);

    expect(attendanceUpsertMock).toHaveBeenCalledTimes(1);
    expect(attendanceDeleteManyMock).not.toHaveBeenCalled();
    expect(redemptionDeleteManyMock).not.toHaveBeenCalled();
    expect(packUpdateMock).not.toHaveBeenCalled();
  });
});
