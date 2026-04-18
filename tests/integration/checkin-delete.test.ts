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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    attendanceRecord: { deleteMany: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { DELETE } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);
const mockDeleteMany = vi.mocked(prisma.attendanceRecord.deleteMany as (...args: unknown[]) => unknown);

const STAFF_SESSION = { user: { tenantId: "tenant-A", role: "owner" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteMany.mockResolvedValue({ count: 1 } as never);
});

function deleteReq(params: string) {
  return new Request(`http://localhost/api/checkin?${params}`, { method: "DELETE" });
}

describe("DELETE /api/checkin — tenant scoping", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await DELETE(deleteReq("classInstanceId=inst-1&memberId=m-1"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-staff role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "tenant-A", role: "member" } } as never);
    const res = await DELETE(deleteReq("classInstanceId=inst-1&memberId=m-1"));
    expect(res.status).toBe(403);
  });

  it("returns 400 when parameters are missing", async () => {
    mockAuth.mockResolvedValue(STAFF_SESSION as never);
    const res = await DELETE(deleteReq("classInstanceId=inst-1")); // memberId missing
    expect(res.status).toBe(400);
  });

  it("succeeds when staff deletes a valid record", async () => {
    mockAuth.mockResolvedValue(STAFF_SESSION as never);
    const res = await DELETE(deleteReq("classInstanceId=inst-1&memberId=m-1"));
    expect(res.status).toBe(200);
  });

  it("scopes deleteMany to the session tenantId (prevents cross-tenant deletion)", async () => {
    mockAuth.mockResolvedValue(STAFF_SESSION as never);
    await DELETE(deleteReq("classInstanceId=inst-1&memberId=m-1"));
    const call = (mockDeleteMany.mock.calls[0] as [{ where: { classInstance: { class: { tenantId: string } } } }])[0];
    expect(call.where.classInstance.class.tenantId).toBe("tenant-A");
  });
});
