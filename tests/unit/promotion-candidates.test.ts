import { vi, describe, it, expect, beforeEach } from "vitest";

// Assessment Fix #1 — auto-rank-progression candidate computation.
// Covers the pure threshold helper + the listPromotionCandidates flow
// (mocked Prisma).

describe("meetsPromotionThreshold (pure)", () => {
  it("returns true when both thresholds are met", async () => {
    const { meetsPromotionThreshold } = await import("@/lib/promotion-candidates");
    const result = meetsPromotionThreshold({
      achievedAt: new Date("2025-01-01"),
      attendancesSince: 60,
      threshold: { minAttendances: 50, minMonths: 6 },
      now: new Date("2025-09-01"), // ~8 months later
    });
    expect(result).toBe(true);
  });

  it("returns false when attendance threshold is not met", async () => {
    const { meetsPromotionThreshold } = await import("@/lib/promotion-candidates");
    const result = meetsPromotionThreshold({
      achievedAt: new Date("2025-01-01"),
      attendancesSince: 30, // below minAttendances=50
      threshold: { minAttendances: 50, minMonths: 6 },
      now: new Date("2025-09-01"),
    });
    expect(result).toBe(false);
  });

  it("returns false when month threshold is not met (under-time even with high attendance)", async () => {
    const { meetsPromotionThreshold } = await import("@/lib/promotion-candidates");
    const result = meetsPromotionThreshold({
      achievedAt: new Date("2025-08-01"),
      attendancesSince: 100, // way over
      threshold: { minAttendances: 50, minMonths: 6 },
      now: new Date("2025-09-01"), // only 1 month later
    });
    expect(result).toBe(false);
  });

  it("works with minMonths=0 (no time gate)", async () => {
    const { meetsPromotionThreshold } = await import("@/lib/promotion-candidates");
    const result = meetsPromotionThreshold({
      achievedAt: new Date("2025-08-25"),
      attendancesSince: 50,
      threshold: { minAttendances: 50, minMonths: 0 },
      now: new Date("2025-09-01"),
    });
    expect(result).toBe(true);
  });
});

describe("defaultThresholdsFor (per-discipline)", () => {
  it("returns BJJ-specific defaults (50 attendances, 6 months)", async () => {
    const { defaultThresholdsFor } = await import("@/lib/promotion-candidates");
    expect(defaultThresholdsFor("BJJ")).toEqual({ minAttendances: 50, minMonths: 6 });
  });

  it("returns Wrestling-specific defaults (faster ladder)", async () => {
    const { defaultThresholdsFor } = await import("@/lib/promotion-candidates");
    expect(defaultThresholdsFor("Wrestling")).toEqual({ minAttendances: 30, minMonths: 3 });
  });

  it("returns Judo-specific defaults (slower ladder)", async () => {
    const { defaultThresholdsFor } = await import("@/lib/promotion-candidates");
    expect(defaultThresholdsFor("Judo")).toEqual({ minAttendances: 60, minMonths: 12 });
  });

  it("returns fallback for unknown discipline", async () => {
    const { defaultThresholdsFor } = await import("@/lib/promotion-candidates");
    expect(defaultThresholdsFor("Quidditch")).toEqual({ minAttendances: 30, minMonths: 6 });
  });
});

// ── listPromotionCandidates with mocked Prisma ──────────────────────────────

const { memberRankFindManyMock, requirementFindManyMock, attendanceCountMock } = vi.hoisted(() => ({
  memberRankFindManyMock: vi.fn(),
  requirementFindManyMock: vi.fn(),
  attendanceCountMock: vi.fn(),
}));

// Audit iter-1-dashboard A4H-6: the mock needs a $transaction stub because
// listPromotionCandidates now routes through withTenantContext which calls
// prisma.$transaction(callback). The stub simply passes the inner prisma
// proxy back to the callback so the per-table mocks still fire.
vi.mock("@/lib/prisma", () => {
  const txProxy = {
    memberRank: { findMany: memberRankFindManyMock },
    rankRequirement: { findMany: requirementFindManyMock },
    attendanceRecord: { count: attendanceCountMock },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  return {
    prisma: {
      ...txProxy,
      $transaction: vi.fn(async (fn: (tx: typeof txProxy) => unknown) => fn(txProxy)),
    },
  };
});

// Audit iter-1-dashboard A4H-6: also bypass withTenantContext and withRlsBypass
// so the GUC set_config calls (which would fail against a mocked client) are
// no-ops in the test path.
vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withTenantContext: <T,>(_tenantId: string, fn: (tx: unknown) => Promise<T>) => fn(prisma),
    withRlsBypass: <T,>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listPromotionCandidates", () => {
  it("returns empty array when no member ranks exist", async () => {
    memberRankFindManyMock.mockResolvedValueOnce([]);
    requirementFindManyMock.mockResolvedValueOnce([]);
    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toEqual([]);
  });

  it("includes a member who meets the BJJ default thresholds", async () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // ~6.5 months ago
    memberRankFindManyMock.mockResolvedValueOnce([
      {
        memberId: "m1",
        rankSystemId: "rs-bjj-blue",
        stripes: 3,
        achievedAt: longAgo,
        member: { id: "m1", name: "Alice", tenantId: "tenant-A" },
        rankSystem: { id: "rs-bjj-blue", name: "Blue", discipline: "BJJ", deletedAt: null },
      },
    ]);
    requirementFindManyMock.mockResolvedValueOnce([]);
    attendanceCountMock.mockResolvedValueOnce(60); // above BJJ default of 50

    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      memberId: "m1",
      memberName: "Alice",
      rankSystemName: "Blue",
      discipline: "BJJ",
      attendancesSinceRank: 60,
      thresholdSource: "discipline_default",
      threshold: { minAttendances: 50, minMonths: 6 },
    });
  });

  it("excludes a member who hasn't hit the attendance threshold yet", async () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    memberRankFindManyMock.mockResolvedValueOnce([
      {
        memberId: "m1",
        rankSystemId: "rs-bjj-blue",
        stripes: 0,
        achievedAt: longAgo,
        member: { id: "m1", name: "Bob", tenantId: "tenant-A" },
        rankSystem: { id: "rs-bjj-blue", name: "Blue", discipline: "BJJ", deletedAt: null },
      },
    ]);
    requirementFindManyMock.mockResolvedValueOnce([]);
    attendanceCountMock.mockResolvedValueOnce(20); // below 50

    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toEqual([]);
  });

  it("uses tenant override when a RankRequirement row exists", async () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    memberRankFindManyMock.mockResolvedValueOnce([
      {
        memberId: "m1",
        rankSystemId: "rs-bjj-blue",
        stripes: 2,
        achievedAt: longAgo,
        member: { id: "m1", name: "Carol", tenantId: "tenant-A" },
        rankSystem: { id: "rs-bjj-blue", name: "Blue", discipline: "BJJ", deletedAt: null },
      },
    ]);
    requirementFindManyMock.mockResolvedValueOnce([
      { rankSystemId: "rs-bjj-blue", minAttendances: 100, minMonths: 12 },
    ]);
    // 80 < custom 100, so even though they'd meet the BJJ default of 50, they
    // should NOT show — the custom override takes precedence.
    attendanceCountMock.mockResolvedValueOnce(80);

    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toEqual([]);
  });

  it("excludes ranks attached to soft-deleted RankSystems", async () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    memberRankFindManyMock.mockResolvedValueOnce([
      {
        memberId: "m1",
        rankSystemId: "rs-archived",
        stripes: 0,
        achievedAt: longAgo,
        member: { id: "m1", name: "Dave", tenantId: "tenant-A" },
        rankSystem: { id: "rs-archived", name: "Old", discipline: "BJJ", deletedAt: new Date() },
      },
    ]);
    requirementFindManyMock.mockResolvedValueOnce([]);
    attendanceCountMock.mockResolvedValueOnce(100);

    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toEqual([]);
  });

  it("sorts most-overdue first (months desc)", async () => {
    const farPast = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);   // ~13 months
    const closer = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);    // ~6.5 months
    memberRankFindManyMock.mockResolvedValueOnce([
      {
        memberId: "m-newer",
        rankSystemId: "rs-bjj-blue",
        stripes: 0,
        achievedAt: closer,
        member: { id: "m-newer", name: "Newer", tenantId: "tenant-A" },
        rankSystem: { id: "rs-bjj-blue", name: "Blue", discipline: "BJJ", deletedAt: null },
      },
      {
        memberId: "m-older",
        rankSystemId: "rs-bjj-blue",
        stripes: 0,
        achievedAt: farPast,
        member: { id: "m-older", name: "Older", tenantId: "tenant-A" },
        rankSystem: { id: "rs-bjj-blue", name: "Blue", discipline: "BJJ", deletedAt: null },
      },
    ]);
    requirementFindManyMock.mockResolvedValueOnce([]);
    attendanceCountMock.mockResolvedValueOnce(60).mockResolvedValueOnce(60);

    const { listPromotionCandidates } = await import("@/lib/promotion-candidates");
    const result = await listPromotionCandidates("tenant-A");
    expect(result).toHaveLength(2);
    expect(result[0].memberName).toBe("Older"); // most overdue first
    expect(result[1].memberName).toBe("Newer");
  });
});
