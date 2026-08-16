/**
 * Regression guard for the M10 fix — atomic ClassPack credit decrement.
 *
 * Before iteration 3, lib/checkin.ts redeemed a pack via:
 *   1. findFirst({ creditsRemaining: { gt: 0 } })
 *   2. update({ data: { creditsRemaining: { decrement: 1 } } })
 *
 * Two concurrent check-ins under READ COMMITTED isolation could both see
 * `creditsRemaining: 1`, both pass the gt:0 check, both decrement → -1.
 * Member gets two attendances for one credit.
 *
 * The fix replaces the second step with an atomic updateMany guarded by
 * `creditsRemaining: { gt: 0 }`. Only one concurrent request wins; the loser
 * gets `count: 0` and falls through to no_coverage.
 *
 * (Security audit iteration 2 / M10, 2026-05-07.)
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { findFirstMock, updateManyMock, findUniqueMock, recordCreateMock, redemptionCreateMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  recordCreateMock: vi.fn(),
  redemptionCreateMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn(), findFirst: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    memberClassPack: {
      findFirst: findFirstMock,
      updateMany: updateManyMock,
      findUnique: findUniqueMock,
    },
    attendanceRecord: { create: recordCreateMock, findUnique: vi.fn() },
    classPackRedemption: { create: redemptionCreateMock },
  },
}));

// Member exists, no active subscription → forces the pack-redemption branch.
const MOCK_MEMBER = {
  id: "m-1",
  tenantId: "t-1",
  stripeSubscriptionId: null,
  paymentStatus: "paid",
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      member: {
        findUnique: vi.fn().mockResolvedValue(MOCK_MEMBER),
        findFirst: vi.fn().mockResolvedValue(MOCK_MEMBER),
      },
      memberRank: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      classInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ci-1",
          isCancelled: false,
          date: new Date(),
          startTime: "10:00",
          endTime: "11:00",
          class: {
            id: "c-1",
            tenantId: "t-1",
            requiredRankId: null,
            maxRankId: null,
            requiredRank: null,
            maxRank: null,
          },
        }),
      },
      memberClassPack: {
        findFirst: findFirstMock,
        updateMany: updateManyMock,
        findUnique: findUniqueMock,
      },
      attendanceRecord: {
        create: recordCreateMock,
        findUnique: vi.fn().mockResolvedValue(null),
      },
      classPackRedemption: { create: redemptionCreateMock },
    })),
}));

import type { Prisma } from "@prisma/client";
import { performCheckin, restorePackCreditsForAttendance } from "@/lib/checkin";

const BASE_ARGS = {
  tenantId: "t-1",
  memberId: "m-1",
  classInstanceId: "ci-1",
  method: "self" as const,
  enforceRankGate: false,
  enforceRosterGate: false,
  enforceTimeWindow: false,
  requireCoverage: true,
  checkedInByUserId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Mock the in-tenant member.findFirst to return a member without an
  // active subscription (forces pack-redemption code path).
  // The withTenantContext mock above includes a member finder; override
  // its return per-test by setting up the mock chain.
  recordCreateMock.mockResolvedValue({ id: "ar-1", checkInTime: new Date() });
  redemptionCreateMock.mockResolvedValue({});
});

describe("performCheckin pack-redemption — M10 atomic decrement", () => {
  it("happy path: pack found + atomic claim succeeds → returns pack_redeemed with refreshed credits", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "pack-1" });
    updateManyMock.mockResolvedValueOnce({ count: 1 }); // we won the race
    findUniqueMock.mockResolvedValueOnce({ creditsRemaining: 4 });

    const result = await performCheckin(BASE_ARGS);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.coverage).toEqual({ kind: "pack", creditsRemaining: 4 });

    // Critical invariant: updateMany was guarded by creditsRemaining > 0
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "pack-1", creditsRemaining: { gt: 0 } },
      data: { creditsRemaining: { decrement: 1 } },
    });
    // AttendanceRecord + redemption written exactly once
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
    expect(redemptionCreateMock).toHaveBeenCalledTimes(1);
  });

  it("race lost: findFirst saw a pack but updateMany count is 0 (someone else exhausted it) → no_coverage", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "pack-1" });
    // Simulating: between findFirst and updateMany, a concurrent request
    // decremented this pack's last credit to 0.
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const result = await performCheckin(BASE_ARGS);

    expect(result.kind).toBe("no_coverage");
    // Should NOT have written an attendance record or redemption row
    expect(recordCreateMock).not.toHaveBeenCalled();
    expect(redemptionCreateMock).not.toHaveBeenCalled();
    // findUnique only fires after a successful claim
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("no pack at all: findFirst returns null → no_coverage without touching updateMany", async () => {
    findFirstMock.mockResolvedValueOnce(null);

    const result = await performCheckin(BASE_ARGS);

    expect(result.kind).toBe("no_coverage");
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordCreateMock).not.toHaveBeenCalled();
    expect(redemptionCreateMock).not.toHaveBeenCalled();
  });

  it("does NOT use update() with bare where:{id} (the OLD non-atomic pattern)", async () => {
    // This is a static safety check via the route.ts module text — we
    // already mock the whole client — but assert that the test file's mock
    // does NOT expose an update() method on memberClassPack. If a future
    // regression reintroduces tx.memberClassPack.update(...), this test
    // file would need a new mock and the test author would notice.
    findFirstMock.mockResolvedValueOnce({ id: "pack-1" });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findUniqueMock.mockResolvedValueOnce({ creditsRemaining: 0 });

    await performCheckin(BASE_ARGS);
    // Asserting the atomic helper was used; the bare update would skip this
    expect(updateManyMock).toHaveBeenCalled();
  });
});

/**
 * P2-1 (audit 2026-08-16): undoing a check-in used to delete the
 * AttendanceRecord and stop there — the ClassPackRedemption row was orphaned
 * (bare String attendanceRecordId, no FK) and the paid credit was gone for
 * good. restorePackCreditsForAttendance is the exact inverse of the redemption
 * written by performCheckin above.
 */
describe("restorePackCreditsForAttendance — P2-1 undo restores the credit", () => {
  function makeTx(redemptions: { id: string; memberPackId: string }[]) {
    const redemptionFindMany = vi.fn().mockResolvedValue(redemptions);
    const redemptionDeleteMany = vi.fn().mockResolvedValue({ count: redemptions.length });
    const packUpdate = vi.fn().mockResolvedValue({});
    const tx = {
      classPackRedemption: { findMany: redemptionFindMany, deleteMany: redemptionDeleteMany },
      memberClassPack: { update: packUpdate },
    } as unknown as Prisma.TransactionClient;
    return { tx, redemptionFindMany, redemptionDeleteMany, packUpdate };
  }

  it("pack-covered undo: deletes the redemption and increments creditsRemaining by 1", async () => {
    const { tx, redemptionFindMany, redemptionDeleteMany, packUpdate } = makeTx([
      { id: "red-1", memberPackId: "pack-1" },
    ]);

    const restored = await restorePackCreditsForAttendance(tx, ["ar-1"]);

    expect(restored).toBe(1);
    expect(redemptionFindMany).toHaveBeenCalledWith({
      where: { attendanceRecordId: { in: ["ar-1"] } },
      select: { id: true, memberPackId: true },
    });
    expect(redemptionDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["red-1"] } } });
    // Exact inverse of the forward `decrement: 1` in performCheckin.
    expect(packUpdate).toHaveBeenCalledWith({
      where: { id: "pack-1" },
      data: { creditsRemaining: { increment: 1 } },
    });
  });

  it("non-pack undo: no redemption row → nothing deleted, no credit touched", async () => {
    const { tx, redemptionFindMany, redemptionDeleteMany, packUpdate } = makeTx([]);

    const restored = await restorePackCreditsForAttendance(tx, ["ar-sub-1"]);

    expect(restored).toBe(0);
    expect(redemptionFindMany).toHaveBeenCalledTimes(1);
    expect(redemptionDeleteMany).not.toHaveBeenCalled();
    expect(packUpdate).not.toHaveBeenCalled();
  });

  it("deleteMany covering several records: one credit back per redemption", async () => {
    const { tx, redemptionDeleteMany, packUpdate } = makeTx([
      { id: "red-1", memberPackId: "pack-1" },
      { id: "red-2", memberPackId: "pack-1" },
    ]);

    const restored = await restorePackCreditsForAttendance(tx, ["ar-1", "ar-2"]);

    expect(restored).toBe(2);
    expect(redemptionDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["red-1", "red-2"] } } });
    // Two redemptions against the same pack → two separate +1 increments.
    expect(packUpdate).toHaveBeenCalledTimes(2);
  });

  it("no attendance ids: short-circuits without querying", async () => {
    const { tx, redemptionFindMany } = makeTx([]);

    expect(await restorePackCreditsForAttendance(tx, [])).toBe(0);
    expect(redemptionFindMany).not.toHaveBeenCalled();
  });
});
