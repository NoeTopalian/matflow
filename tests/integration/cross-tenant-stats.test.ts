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
vi.mock("@/lib/streak", () => ({
  getWeekKey: vi.fn((d: Date) => d.toISOString().split("T")[0]),
  calculateStreak: vi.fn().mockReturnValue(2),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: vi.fn() },
    attendanceRecord: { count: vi.fn(), findMany: vi.fn() },
    // Sprint 4-A US-401: route now also reads classInstance.findFirst for nextClass.
    classInstance: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/me/route";

const mockAuth = vi.mocked(auth);
const mockCount = vi.mocked(prisma.attendanceRecord.count as (...args: unknown[]) => unknown);
const mockFindMany = vi.mocked(prisma.attendanceRecord.findMany as (...args: unknown[]) => unknown);

const TENANT_A_MEMBER = {
  id: "member-a",
  name: "Alice",
  email: "alice@a.com",
  phone: null,
  membershipType: "Monthly",
  status: "active",
  joinedAt: new Date("2025-01-01"),
  memberRanks: [],
  _count: { attendances: 40 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { tenantId: "tenant-A", memberId: "member-a", email: "alice@a.com" },
  } as never);
  vi.mocked(prisma.member.findFirst as (...args: unknown[]) => unknown).mockResolvedValue(TENANT_A_MEMBER as never);
  // Tenant A has 2 this-week, 8 this-month, 40 this-year, plus last-8-weeks count for the new avgClassesPerWeek
  mockCount
    .mockResolvedValueOnce(2)   // thisWeek
    .mockResolvedValueOnce(8)   // thisMonth
    .mockResolvedValueOnce(40)  // thisYear
    .mockResolvedValueOnce(20); // last8w (Sprint 4-A US-401)
  mockFindMany.mockResolvedValue([]);
});

describe("GET /api/member/me — cross-tenant stats isolation", () => {
  it("returns stats scoped to tenant-A member (not polluted by other tenants)", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.stats.thisWeek).toBe(2);
    expect(body.stats.thisMonth).toBe(8);
    expect(body.stats.thisYear).toBe(40);
  });

  it("queries attendanceRecord with the tenant-A memberId only", async () => {
    await GET();
    const calls = mockCount.mock.calls as [{ where: { memberId: string } }][];
    for (const call of calls) {
      expect(call[0].where.memberId).toBe("member-a");
    }
  });

  it("does not include totalClasses from other tenants (uses member._count.attendances)", async () => {
    const res = await GET();
    const body = await res.json();
    // totalClasses comes from member._count.attendances (scoped by the tenant-scoped member lookup)
    expect(body.stats.totalClasses).toBe(40);
  });
});
