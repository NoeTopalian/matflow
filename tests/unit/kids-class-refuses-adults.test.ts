// Decision 2 (30 Sep 2026): kids classes refuse adults.
//
// End-user round 3 (6.7): Ava, 32, signed herself into Kids BJJ from the
// member app and nothing said a word; three adults with no children were all
// shown "NEXT CLASS Kids BJJ" (3.5). A class can now be marked as a kids
// class; self and kiosk check-in refuse an adult into it with `kids_class`,
// children, juniors and a parent checking in their child pass, and an adult's
// own next class skips it.

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const h = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  recordCreate: vi.fn(),
  instance: { isKids: true },
  auth: vi.fn(),
  classFindFirst: vi.fn(),
  classUpdateMany: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: h.memberFindUnique },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() },
      classSubscription: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
      classInstance: {
        findFirst: vi.fn(async () => ({
          id: "ci-1", classId: "c-1", isCancelled: false,
          date: new Date("2026-09-30T00:00:00.000Z"), startTime: "14:00", endTime: "14:45",
          class: {
            id: "c-1", tenantId: "t-1", isKids: h.instance.isKids, maxCapacity: null, locationId: null,
            requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null, locationRef: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
          },
        })),
      },
      class: { findFirst: h.classFindFirst, updateMany: h.classUpdateMany },
      attendanceRecord: { create: h.recordCreate, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), findUnique: vi.fn() },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
    }),
  ),
}));
vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

import { performCheckin } from "@/lib/checkin";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { classCreateSchema } from "@/lib/schemas/class";
import { pickNextClass, type NextClassCandidate } from "@/lib/member-stats";

const SELF = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self" as const,
  enforceRankGate: true, enforceRosterGate: true, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceVenueGate: true, enforceKidsGate: true, checkedInByUserId: null,
};
const KIOSK = { ...SELF, method: "kiosk" as const, requireCoverage: false };
const ADMIN = {
  ...SELF, method: "admin" as const, enforceRankGate: false, enforceRosterGate: false, requireCoverage: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceVenueGate: false, enforceKidsGate: false,
};

function memberOf(accountType: string) {
  return {
    accountType, paymentStatus: "paid", stripeSubscriptionId: null, waiverAccepted: true, holdUntil: null,
    membershipTierId: "tier-1", nextDueAt: null, membershipTier: { locationId: null, locationRef: null },
  };
}

let PATCH: typeof import("@/app/api/classes/[id]/route")["PATCH"];
beforeAll(async () => {
  ({ PATCH } = await import("@/app/api/classes/[id]/route"));
});

beforeEach(() => {
  vi.clearAllMocks();
  h.instance.isKids = true;
  h.recordCreate.mockResolvedValue({ id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: "self" });
});

describe("self and kiosk check-in into a kids class", () => {
  it("refuses an adult with kids_class", async () => {
    h.memberFindUnique.mockResolvedValue(memberOf("adult"));
    expect((await performCheckin(SELF)).kind).toBe("kids_class");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("refuses a parent checking THEMSELVES in", async () => {
    h.memberFindUnique.mockResolvedValue(memberOf("parent"));
    expect((await performCheckin(SELF)).kind).toBe("kids_class");
  });

  it("refuses an adult at the kiosk too", async () => {
    h.memberFindUnique.mockResolvedValue(memberOf("adult"));
    expect((await performCheckin(KIOSK)).kind).toBe("kids_class");
  });

  it("admits a child — which is also what a parent checking in their child is", async () => {
    // The route resolves a parent's check-in-for-a-child to the CHILD's
    // memberId, so the gate reads the child's own account type.
    h.memberFindUnique.mockResolvedValue(memberOf("kids"));
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("admits a junior (13–17)", async () => {
    h.memberFindUnique.mockResolvedValue(memberOf("junior"));
    expect((await performCheckin(KIOSK)).kind).toBe("success");
  });

  it("an adult into an ordinary class is untouched", async () => {
    h.instance.isKids = false;
    h.memberFindUnique.mockResolvedValue(memberOf("adult"));
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a staff mark admits (the register asks first instead)", async () => {
    h.memberFindUnique.mockResolvedValue(memberOf("adult"));
    expect((await performCheckin(ADMIN)).kind).toBe("success");
  });

  it("the refusal reads the same at every door", () => {
    expect(checkinRefusal({ kind: "kids_class" })).toEqual({
      status: 403,
      body: { error: "This is a kids class.", reason: "kids_class" },
    });
  });

  it("No payment yet is not refused at the door — a first class is normal", async () => {
    h.instance.isKids = false;
    h.memberFindUnique.mockResolvedValue({ ...memberOf("adult"), paymentStatus: "pending" });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });
});

describe("the class form's Kids class switch is saved", () => {
  const base = { name: "Kids BJJ", duration: 45, schedules: [{ dayOfWeek: 3, startTime: "14:00", endTime: "14:45" }] };

  it("create keeps isKids rather than stripping it", () => {
    const parsed = classCreateSchema.safeParse({ ...base, isKids: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.isKids).toBe(true);
  });

  it("edit writes isKids to the class", async () => {
    h.auth.mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: "t-1" } });
    h.classFindFirst.mockResolvedValue({ id: "c-1", isKids: true, schedules: [] });
    h.classUpdateMany.mockResolvedValue({ count: 1 });
    const res = await PATCH(
      new Request("https://matflow.studio/api/classes/c-1", {
        method: "PATCH",
        headers: { "content-type": "application/json", Origin: "https://matflow.studio" },
        body: JSON.stringify({ isKids: true }),
      }),
      { params: Promise.resolve({ id: "c-1" }) },
    );
    expect(res.status).toBe(200);
    expect(h.classUpdateMany.mock.calls[0][0].data.isKids).toBe(true);
  });
});

describe("an adult's next class is never a kids class", () => {
  const inst = (id: string, startTime: string, isKids: boolean): NextClassCandidate => ({
    id,
    date: new Date("2026-09-30T00:00:00.000Z"),
    startTime,
    endTime: "23:00",
    class: {
      id: `c-${id}`, name: id, coachName: null, coachUser: null, location: null, isKids,
      requiredRank: null, maxRank: null, rosterMembers: [], _count: { rosterMembers: 0 },
      tenant: { timezone: "Europe/London" },
    },
  });
  // 13:00 London.
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const day = [inst("Kids BJJ", "14:00", true), inst("Adult BJJ", "14:15", false)];

  it("skips the kids class for an adult", () => {
    expect(pickNextClass(day, [], NOW, { accountType: "adult" })?.id).toBe("Adult BJJ");
    expect(pickNextClass(day, [], NOW, { accountType: "parent" })?.id).toBe("Adult BJJ");
  });

  it("still offers it to a child or a junior", () => {
    expect(pickNextClass(day, [], NOW, { accountType: "kids" })?.id).toBe("Kids BJJ");
    expect(pickNextClass(day, [], NOW, { accountType: "junior" })?.id).toBe("Kids BJJ");
  });
});
