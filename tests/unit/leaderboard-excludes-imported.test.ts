import { describe, it, expect, vi } from "vitest";

/**
 * The public TV leaderboard counts only attendance made in MatFlow. Imported
 * history (checkInMethod "import") is the previous system's record; a public
 * screen must never publish it. Both the current-month and the prior-month
 * aggregates (the prior one drives the movement arrows) carry the exclusion.
 */

const { groupByMock, memberFindManyMock } = vi.hoisted(() => ({
  groupByMock: vi.fn(),
  memberFindManyMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: <T,>(fn: () => Promise<T>) => fn,
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ attendanceRecord: { groupBy: groupByMock }, member: { findMany: memberFindManyMock } }),
}));

import { getLeaderboard } from "@/lib/leaderboard";

describe("getLeaderboard — imported attendance is never published", () => {
  it("excludes checkInMethod import from both monthly aggregates, tenant-scoped", async () => {
    groupByMock.mockResolvedValue([{ memberId: "m1", _count: { _all: 4 } }]);
    memberFindManyMock.mockResolvedValue([{ id: "m1", name: "Alex Johnson", leaderboardOptOut: false }]);

    const res = await getLeaderboard("t1", "Europe/London");

    expect(groupByMock).toHaveBeenCalledTimes(2);
    for (const [args] of groupByMock.mock.calls) {
      expect(args.where).toMatchObject({
        tenantId: "t1",
        checkInMethod: { not: "import" },
        member: { leaderboardOptOut: false },
      });
    }
    expect(res.entries[0]).toMatchObject({ name: "Alex J.", checkIns: 4 });
  });
});
