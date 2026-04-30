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
    member: { findFirst: vi.fn(), findUnique: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    attendanceRecord: { create: vi.fn() },
    memberRank: { findFirst: vi.fn() },
    memberClassPack: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst as (...args: unknown[]) => unknown);
const mockMemberFindUnique = vi.mocked(prisma.member.findUnique as (...args: unknown[]) => unknown);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst as (...args: unknown[]) => unknown);
const mockAttCreate = vi.mocked(prisma.attendanceRecord.create as (...args: unknown[]) => unknown);

const SESSION = { user: { tenantId: "t1", email: "admin@t.com", role: "admin" } };
// Sprint 5 US-501: route reads instance.startTime/endTime/date for parseTime check-in
// window guard, and instance.class.requiredRank/maxRank for rank gating. self-method
// also walks the coverage path (memberClassPack lookup); we return a non-active pack
// to skip into the "no_coverage" branch which still returns 201 for the happy path
// when checkInMethod is set to a non-coverage-required value.
const ACTIVE_INSTANCE = {
  id: "inst-1",
  class: {
    tenantId: "t1",
    requiredRankId: null,
    requiredRank: null,
    maxRankId: null,
    maxRank: null,
  },
  isCancelled: false,
  date: new Date(),
  startTime: "10:00",
  endTime: "11:00",
};

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
  mockMemberFindUnique.mockResolvedValue({ paymentStatus: "paid", stripeSubscriptionId: "sub_x" } as never);
  mockInstanceFindFirst.mockResolvedValue(ACTIVE_INSTANCE as never);
});

describe("POST /api/checkin — duplicate prevention", () => {
  // Use admin checkInMethod so the route's coverage gate (subscription/class-pack)
  // is bypassed — the duplicate-prevention path is what we're testing here, not coverage.
  it("succeeds (201) on first check-in", async () => {
    mockAttCreate.mockResolvedValue({ id: "rec-1", memberId: "member-1", classInstanceId: "inst-1" } as never);
    const res = await POST(makeReq({ classInstanceId: "inst-1", memberId: "member-1", checkInMethod: "admin" }));
    expect(res.status).toBe(201);
  });

  it("returns 409 'Already checked in' on duplicate (P2002)", async () => {
    mockAttCreate.mockRejectedValue({ code: "P2002" });
    const res = await POST(makeReq({ classInstanceId: "inst-1", memberId: "member-1", checkInMethod: "admin" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already checked in");
  });

  it("returns 409 'Class has been cancelled' for a cancelled class", async () => {
    mockInstanceFindFirst.mockResolvedValue({ ...ACTIVE_INSTANCE, isCancelled: true } as never);
    const res = await POST(makeReq({ classInstanceId: "inst-1", memberId: "member-1", checkInMethod: "admin" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Class has been cancelled");
  });

  it("returns 404 when class instance not found", async () => {
    mockInstanceFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ classInstanceId: "no-such-inst", memberId: "member-1", checkInMethod: "admin" }));
    expect(res.status).toBe(404);
  });
});
