/**
 * The waiver hard gate at CHECK-IN (round 4, L-D).
 *
 * `docs/spec.md` F4 specifies a hard block — "cannot check in at all" without a
 * signed waiver — and the product enforced it in exactly one place:
 * `components/kiosk/KioskPage.tsx`, which routed an unsigned member to the
 * waiver screen instead of posting. The API behind that screen ran rank,
 * roster, window and capacity and never asked about the waiver, so the two
 * calls anyone reading the lobby tablet can make — GET /api/kiosk/[token]/
 * members for a `kioskMemberToken`, POST /api/kiosk/[token]/checkin with it —
 * answered 201 and wrote an AttendanceRecord for a member who had signed
 * nothing. Measured on the wire, not inferred.
 *
 * The shape under test is the same one capacity has: the gate holds for the
 * paths where the MEMBER decides (self, kiosk) and is not asked at all on a
 * staff override (admin, qr, auto), so a front-desk judgement — someone who
 * has just signed on paper, a coach part-way through a card scan — still
 * admits. And the refusal costs nothing: no row, and no pack credit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordCreateMock = vi.fn();
const memberFindUniqueMock = vi.fn();
const packFindFirstMock = vi.fn();
const packUpdateManyMock = vi.fn();
const packFindUniqueMock = vi.fn();
const redemptionCreateMock = vi.fn();

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: memberFindUniqueMock },
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
            maxCapacity: null,
            requiredRankId: null,
            maxRankId: null,
            requiredRank: null,
            maxRank: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
          },
        }),
      },
      attendanceRecord: { create: recordCreateMock, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: {
        findFirst: packFindFirstMock,
        updateMany: packUpdateManyMock,
        findUnique: packFindUniqueMock,
      },
      classPackRedemption: { create: redemptionCreateMock },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
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
  enforceCapacity: false,
  checkedInByUserId: null,
};

/** A member row as the check-in reads it: subscription on file, waiver as given. */
function member(waiverAccepted: boolean | null | undefined) {
  return { paymentStatus: "paid", stripeSubscriptionId: "sub_1", waiverAccepted };
}

beforeEach(() => {
  vi.clearAllMocks();
  memberFindUniqueMock.mockResolvedValue(member(true));
  recordCreateMock.mockResolvedValue({
    id: "ar-1",
    tenantId: "t-1",
    memberId: "m-1",
    classInstanceId: "ci-1",
    checkInMethod: "self",
  });
  packFindFirstMock.mockResolvedValue(null);
  packUpdateManyMock.mockResolvedValue({ count: 0 });
  packFindUniqueMock.mockResolvedValue(null);
});

describe("check-in against Member.waiverAccepted", () => {
  it("refuses an unsigned member checking themselves in, and writes nothing", async () => {
    memberFindUniqueMock.mockResolvedValue(member(false));
    const result = await performCheckin({ ...BASE, method: "self", enforceWaiverGate: true });
    expect(result.kind).toBe("waiver_unsigned");
    // A refusal that still wrote the row would leave the club with an
    // attendance record and no liability cover — worse than no gate at all.
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("refuses the kiosk path the exploit used — a signed member token for an unsigned member", async () => {
    // `POST /api/kiosk/[token]/checkin` verifies the HMAC `kioskMemberToken`
    // and hands the memberId straight to performCheckin. The token being valid
    // says who they are, never that they have signed.
    memberFindUniqueMock.mockResolvedValue(member(false));
    const result = await performCheckin({ ...BASE, method: "kiosk", enforceWaiverGate: true });
    expect(result.kind).toBe("waiver_unsigned");
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("admits a member who has signed", async () => {
    memberFindUniqueMock.mockResolvedValue(member(true));
    const result = await performCheckin({ ...BASE, method: "kiosk", enforceWaiverGate: true });
    expect(result.kind).toBe("success");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("admits a kid whose parent signed the kids waiver", async () => {
    // `app/api/waiver/sign-for-child` flips `waiverAccepted` on the KID's own
    // Member row, so the parent-signed waiver is the flag this gate reads —
    // no special case, and the parent's own row is never consulted. The
    // check-in route resolves the parent-of-kid branch to method "self".
    memberFindUniqueMock.mockResolvedValue(member(true));
    const result = await performCheckin({
      ...BASE,
      memberId: "kid-1",
      method: "self",
      enforceWaiverGate: true,
    });
    expect(result.kind).toBe("success");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("does not ask the question on a staff mark, so an unsigned member can still be admitted at the desk", async () => {
    memberFindUniqueMock.mockResolvedValue(member(false));
    const result = await performCheckin({ ...BASE, method: "admin", enforceWaiverGate: false });
    expect(result.kind).toBe("success");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("does not stop a card scan mid-register either", async () => {
    memberFindUniqueMock.mockResolvedValue(member(false));
    const result = await performCheckin({ ...BASE, method: "qr", enforceWaiverGate: false });
    expect(result.kind).toBe("success");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("refuses BEFORE a pack credit is spent", async () => {
    // The refusal sits above both write branches. If it sat inside the
    // coverage transaction instead, an unsigned member would be turned away
    // one paid class lighter.
    memberFindUniqueMock.mockResolvedValue({
      paymentStatus: "unpaid",
      stripeSubscriptionId: null,
      waiverAccepted: false,
    });
    packFindFirstMock.mockResolvedValue({ id: "pack-1" });
    const result = await performCheckin({
      ...BASE,
      method: "self",
      requireCoverage: true,
      enforceWaiverGate: true,
    });
    expect(result.kind).toBe("waiver_unsigned");
    expect(packUpdateManyMock).not.toHaveBeenCalled();
    expect(redemptionCreateMock).not.toHaveBeenCalled();
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("fails closed on anything that is not exactly true", async () => {
    // The column is a non-null boolean in the schema, so this is belt and
    // braces — but a gate that admits on a missing field is not a gate.
    for (const flag of [null, undefined] as const) {
      vi.clearAllMocks();
      memberFindUniqueMock.mockResolvedValue(member(flag));
      const result = await performCheckin({ ...BASE, method: "kiosk", enforceWaiverGate: true });
      expect(result.kind).toBe("waiver_unsigned");
      expect(recordCreateMock).not.toHaveBeenCalled();
    }
  });

  it("reads the flag off the member row it already loads, not a second query", async () => {
    await performCheckin({ ...BASE, method: "kiosk", enforceWaiverGate: true });
    expect(memberFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(memberFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "m-1" },
      select: { paymentStatus: true, stripeSubscriptionId: true, waiverAccepted: true },
    });
  });
});
