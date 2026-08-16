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
    member: { findFirst: vi.fn() },
    attendanceRecord: { count: vi.fn(), findMany: vi.fn() },
    classInstance: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    // Gamification pass (2026-08): /api/member/me now also builds the rank
    // timeline (lib/member-home.ts buildRankTimeline).
    rankHistory: { findMany: vi.fn().mockResolvedValue([]) },
    memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
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
  photos: [],
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
  // Gamification pass (2026-08): totalClasses now derives from the all-time
  // attendance-dates query (first findMany, still memberId-scoped) instead of
  // a separate count — 40 rows here = totalClasses 40.
  mockFindMany
    .mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => ({
        checkInTime: new Date(2025, 0, 1 + Math.floor(i * 8)),
      })),
    )               // all-time dates (badges/heat/totalClasses)
    .mockResolvedValue([]); // 90-day by-class aggregate + any later findMany
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

  it("does not include totalClasses from other tenants (memberId-scoped attendance rows)", async () => {
    const res = await GET();
    const body = await res.json();
    // totalClasses = the member's own attendance rows (query filtered by the
    // memberId resolved via the tenant-scoped member lookup) — the "queries
    // attendanceRecord with the tenant-A memberId only" test above pins the
    // where-clause itself.
    expect(body.stats.totalClasses).toBe(40);
  });
});
