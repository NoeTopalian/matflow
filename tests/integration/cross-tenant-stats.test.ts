import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
    // findFirst: lib/attendance-coverage.ts (Round 10). No coverage spans here (no club records found).
    attendanceRecord: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    tenant: { findUnique: vi.fn().mockResolvedValue({ timezone: "Europe/London" }) },
    // computeMemberStats reads upcoming instances as a list since 30 Sep 2026
    // (pickNextClass, 5f9122d); the mock follows. No assertion changed.
    classInstance: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    // Gamification pass (2026-08): /api/member/me now also builds the rank
    // timeline (lib/member-home.ts buildRankTimeline).
    rankHistory: { findMany: vi.fn().mockResolvedValue([]) },
    memberRank: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
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
  // Tenant A has 2 this-week, 8 this-month, 40 this-year. Since Round 10 (16 Nov 2026) the windowed counts come from the
  // member's own rows (dated by session), not separate COUNTs, so the rows carry the dates: "now" is Wed 18 Nov 2026.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
  // Gamification pass (2026-08): totalClasses derives from the all-time
  // attendance query (memberId-scoped) instead of a separate count — 40 rows
  // here = totalClasses 40. Achievements pass (2026-08): that query is now the
  // ONLY attendance findMany — the 90-day "most attended" list and the heat
  // strip are sliced from these same rows in memory, so each row carries its
  // class as well as its timestamp.
  const at = (iso: string) => ({ checkInTime: new Date(iso), classInstance: { class: { id: "c1", name: "Class A" } } });
  mockFindMany.mockResolvedValue([
    ...Array.from({ length: 32 }, (_, i) => at(`2026-03-${String(1 + (i % 28)).padStart(2, "0")}T18:00:00Z`)), // this year
    ...Array.from({ length: 6 }, () => at("2026-11-05T18:00:00Z")), // this month, not this week
    ...Array.from({ length: 2 }, () => at("2026-11-17T18:00:00Z")), // this week
  ]);
});
afterEach(() => vi.useRealTimers());

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
    // The member's rows: every findMany is scoped to the tenant-A member, and there is at least one.
    const calls = mockFindMany.mock.calls as [{ where: { memberId?: string } }][];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[0].where.memberId).toBe("member-a");
    // The club's coverage reads (Round 10) are scoped to tenant-A.
    const cov = vi.mocked(prisma.attendanceRecord.findFirst as (...args: unknown[]) => unknown).mock.calls as [{ where: { tenantId?: string } }][];
    for (const call of cov) expect(call[0].where.tenantId).toBe("tenant-A");
    // No COUNT is used for the member's windows any more.
    expect(mockCount).not.toHaveBeenCalled();
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
