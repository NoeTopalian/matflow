import { vi, describe, it, expect, beforeEach } from "vitest";

// Tests the attendanceByClass top-3 aggregation in /api/member/me — Sprint 4-A US-401.

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
  getWeekKey: vi.fn().mockReturnValue("2026-W17"),
  calculateStreak: vi.fn().mockReturnValue(0),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
    },
    attendanceRecord: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    classInstance: {
      findFirst: vi.fn(),
    },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/me/route";

const mockAuth = vi.mocked(auth);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockAttCount = vi.mocked(prisma.attendanceRecord.count);
const mockAttFindMany = vi.mocked(prisma.attendanceRecord.findMany);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/member/me — attendanceByClass aggregation", () => {
  it("groups by class id, sorts desc, returns top 3", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", role: "member", tenantId: "t1", memberId: "m1", name: "M" },
    } as never);

    mockMemberFindFirst.mockResolvedValue({
      id: "m1",
      name: "M",
      email: "m@x.test",
      phone: null,
      membershipType: null,
      status: "active",
      joinedAt: new Date("2026-01-01"),
      onboardingCompleted: true,
      emergencyContactName: null,
      emergencyContactPhone: null,
      medicalConditions: null,
      dateOfBirth: null,
      waiverAccepted: false,
      waiverAcceptedAt: null,
      memberRanks: [],
      _count: { attendances: 30 },
    } as never);

    // 4 distinct classes with varying attendance: A=5, B=10, C=3, D=12
    // Top 3 should be: D=12, B=10, A=5 (C=3 dropped)
    mockAttCount.mockResolvedValue(0 as never);

    // window-attendance lookup (oneYearAgo) — empty (we only test the byClass list)
    mockAttFindMany.mockResolvedValueOnce([] as never);
    // byClassAgg — last 90 days grouped attendance
    const byClassRows = [
      ...Array(5).fill({ classInstance: { class: { id: "A", name: "Class A" } } }),
      ...Array(10).fill({ classInstance: { class: { id: "B", name: "Class B" } } }),
      ...Array(3).fill({ classInstance: { class: { id: "C", name: "Class C" } } }),
      ...Array(12).fill({ classInstance: { class: { id: "D", name: "Class D" } } }),
    ];
    mockAttFindMany.mockResolvedValueOnce(byClassRows as never);

    mockInstanceFindFirst.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();

    expect(body.stats.attendanceByClass).toHaveLength(3);
    expect(body.stats.attendanceByClass[0]).toEqual({ id: "D", name: "Class D", count: 12 });
    expect(body.stats.attendanceByClass[1]).toEqual({ id: "B", name: "Class B", count: 10 });
    expect(body.stats.attendanceByClass[2]).toEqual({ id: "A", name: "Class A", count: 5 });
  });

  it("computes avgClassesPerWeek as count/8 rounded to one decimal", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", role: "member", tenantId: "t1", memberId: "m1", name: "M" },
    } as never);
    mockMemberFindFirst.mockResolvedValue({
      id: "m1", name: "M", email: "m@x.test", phone: null, membershipType: null, status: "active",
      joinedAt: new Date("2026-01-01"), onboardingCompleted: true,
      emergencyContactName: null, emergencyContactPhone: null, medicalConditions: null,
      dateOfBirth: null, waiverAccepted: false, waiverAcceptedAt: null,
      memberRanks: [], _count: { attendances: 0 },
    } as never);
    mockAttFindMany.mockResolvedValueOnce([] as never);
    mockAttFindMany.mockResolvedValueOnce([] as never);

    // Order: thisWeek, thisMonth, thisYear, last8w (last8w is the 4th count call)
    mockAttCount
      .mockResolvedValueOnce(0 as never)  // thisWeek
      .mockResolvedValueOnce(0 as never)  // thisMonth
      .mockResolvedValueOnce(0 as never)  // thisYear
      .mockResolvedValueOnce(20 as never); // last8w → 20/8 = 2.5

    mockInstanceFindFirst.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();
    expect(body.stats.avgClassesPerWeek).toBe(2.5);
  });

  it("returns nextClass null when no upcoming instance", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", role: "member", tenantId: "t1", memberId: "m1", name: "M" },
    } as never);
    mockMemberFindFirst.mockResolvedValue({
      id: "m1", name: "M", email: "m@x.test", phone: null, membershipType: null, status: "active",
      joinedAt: new Date("2026-01-01"), onboardingCompleted: true,
      emergencyContactName: null, emergencyContactPhone: null, medicalConditions: null,
      dateOfBirth: null, waiverAccepted: false, waiverAcceptedAt: null,
      memberRanks: [], _count: { attendances: 0 },
    } as never);
    mockAttCount.mockResolvedValue(0 as never);
    mockAttFindMany.mockResolvedValue([] as never);
    mockInstanceFindFirst.mockResolvedValue(null);

    const res = await GET();
    const body = await res.json();
    expect(body.nextClass).toBeNull();
  });
});
