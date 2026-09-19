/**
 * `Class.maxCapacity` at CHECK-IN (round 3, L-D).
 *
 * The column was enforced at booking only — `/api/member/class-subscriptions/
 * [classId]`, round 1 defect L-F 1 — and by nothing on the way in. A class that
 * seats twelve took a fourteenth person through the kiosk or the member app,
 * and the coach found out standing on the mat.
 *
 * The shape under test is the honest one, not the strict one: the ceiling holds
 * for the paths where the MEMBER decides (self, kiosk) and does not for a staff
 * override (admin, qr, auto) — but an override that exceeds it comes back with
 * `overCapacity` so the number cannot drift in silence.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRawMock = vi.fn();
const attendanceCountMock = vi.fn();
const recordCreateMock = vi.fn();

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: {
        findUnique: vi.fn().mockResolvedValue({
          paymentStatus: "paid",
          stripeSubscriptionId: "sub_1",
        }),
      },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
      classInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ci-1",
          classId: "c-1",
          isCancelled: false,
          date: new Date("2026-09-19T00:00:00.000Z"),
          startTime: "10:00",
          endTime: "11:00",
          class: {
            id: "c-1",
            tenantId: "t-1",
            maxCapacity: 2,
            requiredRankId: null,
            maxRankId: null,
            requiredRank: null,
            maxRank: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
          },
        }),
      },
      attendanceRecord: { create: recordCreateMock, count: attendanceCountMock },
      memberClassPack: { findFirst: vi.fn().mockResolvedValue(null) },
      $queryRaw: queryRawMock,
    }),
  ),
}));

import { performCheckin } from "@/lib/checkin";

const BASE = {
  tenantId: "t-1",
  memberId: "m-1",
  classInstanceId: "ci-1",
  enforceRankGate: false,
  enforceRosterGate: false,
  enforceTimeWindow: false,
  requireCoverage: false,
  checkedInByUserId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  queryRawMock.mockResolvedValue([{ maxCapacity: 2 }]);
  recordCreateMock.mockResolvedValue({
    id: "ar-1",
    tenantId: "t-1",
    memberId: "m-1",
    classInstanceId: "ci-1",
    checkInMethod: "self",
  });
});

describe("check-in against Class.maxCapacity", () => {
  it("refuses a self check-in once the places are taken, and writes nothing", async () => {
    attendanceCountMock.mockResolvedValue(2); // both places gone
    const result = await performCheckin({ ...BASE, method: "self", enforceCapacity: true });
    expect(result.kind).toBe("class_full");
    if (result.kind !== "class_full") return;
    expect([result.taken, result.maxCapacity]).toEqual([2, 2]);
    // The refusal happens before the insert — a refusal that still wrote the
    // row would be worse than no gate at all.
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a kiosk check-in on the same rule", async () => {
    attendanceCountMock.mockResolvedValue(5);
    const result = await performCheckin({ ...BASE, method: "kiosk", enforceCapacity: true });
    expect(result.kind).toBe("class_full");
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("admits the last place — the ceiling is inclusive, not one short", async () => {
    attendanceCountMock.mockResolvedValue(1);
    const result = await performCheckin({ ...BASE, method: "self", enforceCapacity: true });
    expect(result.kind).toBe("success");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("lets a staff override exceed the ceiling, and SAYS SO", async () => {
    attendanceCountMock.mockResolvedValue(2);
    const result = await performCheckin({ ...BASE, method: "admin", enforceCapacity: false });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    // The override is deliberate; it is not silent. A coach who has looked at
    // the room may wave someone in, and the register then admits it is 3 of 2.
    expect(result.overCapacity).toEqual({ taken: 2, maxCapacity: 2 });
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("says nothing about capacity when the override is still inside the ceiling", async () => {
    attendanceCountMock.mockResolvedValue(0);
    const result = await performCheckin({ ...BASE, method: "admin", enforceCapacity: false });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.overCapacity).toBeUndefined();
  });

  it("is inert for a class with no ceiling — no count, no refusal", async () => {
    queryRawMock.mockResolvedValue([{ maxCapacity: null }]);
    const result = await performCheckin({ ...BASE, method: "self", enforceCapacity: true });
    expect(result.kind).toBe("success");
    // `maxCapacity IS NULL` means "no limit", so the count is never run: an
    // unbounded class must not pay for a second query on every check-in.
    expect(attendanceCountMock).not.toHaveBeenCalled();
  });

  it("locks the Class row before counting, so two last-place check-ins cannot both win", async () => {
    attendanceCountMock.mockResolvedValue(0);
    await performCheckin({ ...BASE, method: "self", enforceCapacity: true });
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    // A count followed by an insert is not enough under READ COMMITTED. The
    // guard is `SELECT ... FOR UPDATE` on the Class, in the SAME transaction as
    // the insert — the mechanism the booking route already uses.
    const sql = queryRawMock.mock.calls[0][0] as { strings?: string[] } | string[];
    const text = (Array.isArray(sql) ? sql : (sql.strings ?? [])).join(" ");
    expect(text).toContain("FOR UPDATE");
  });

  it("excludes the caller from the count, so a re-check-in is not told the class is full", async () => {
    attendanceCountMock.mockResolvedValue(2);
    await performCheckin({ ...BASE, method: "self", enforceCapacity: true });
    expect(attendanceCountMock).toHaveBeenCalledWith({
      where: { classInstanceId: "ci-1", memberId: { not: "m-1" } },
    });
  });
});
