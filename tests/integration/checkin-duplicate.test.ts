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
    member: { findFirst: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    attendanceRecord: { create: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst as (...args: unknown[]) => unknown);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst as (...args: unknown[]) => unknown);
const mockAttCreate = vi.mocked(prisma.attendanceRecord.create as (...args: unknown[]) => unknown);

const SESSION = { user: { tenantId: "t1", email: "m@t.com", role: "member" } };
const ACTIVE_INSTANCE = { id: "inst-1", class: { tenantId: "t1" }, isCancelled: false };

function makeReq(body: object) {
  return new Request("http://localhost/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(SESSION as never);
  mockMemberFindFirst.mockResolvedValue({ id: "member-1" } as never);
  mockInstanceFindFirst.mockResolvedValue(ACTIVE_INSTANCE as never);
});

describe("POST /api/checkin — duplicate prevention", () => {
  it("succeeds (201) on first check-in", async () => {
    mockAttCreate.mockResolvedValue({ id: "rec-1", memberId: "member-1", classInstanceId: "inst-1" } as never);
    const res = await POST(makeReq({ classInstanceId: "inst-1", checkInMethod: "self" }));
    expect(res.status).toBe(201);
  });

  it("returns 409 'Already checked in' on duplicate (P2002)", async () => {
    mockAttCreate.mockRejectedValue({ code: "P2002" });
    const res = await POST(makeReq({ classInstanceId: "inst-1", checkInMethod: "self" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already checked in");
  });

  it("returns 409 'Class has been cancelled' for a cancelled class", async () => {
    mockInstanceFindFirst.mockResolvedValue({ ...ACTIVE_INSTANCE, isCancelled: true } as never);
    const res = await POST(makeReq({ classInstanceId: "inst-1", checkInMethod: "self" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Class has been cancelled");
  });

  it("returns 404 when class instance not found", async () => {
    mockInstanceFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ classInstanceId: "no-such-inst", checkInMethod: "self" }));
    expect(res.status).toBe(404);
  });
});
