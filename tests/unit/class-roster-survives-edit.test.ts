/**
 * Task 3d — editing a comp class wiped its roster.
 *
 * The bug was a two-ended one and both ends are pinned here:
 *
 *   READ END  — /dashboard/timetable never selected `rosterMembers`, so every
 *               ClassRow reached the edit form with `roster: undefined`. The
 *               form therefore initialised `useRoster = false` for EVERY class
 *               and submitted `requiredRankId: null, maxRankId: null` with no
 *               `roster` array.
 *   WRITE END — PATCH /api/classes/[id] computed
 *               `wantsRankGate = requiredRankId !== undefined || maxRankId !== undefined`,
 *               which those present-but-null keys satisfy, and the rank-gate
 *               branch hard-deletes ClassRoster. Renaming a comp class turned
 *               it into an open class, with a "Class updated" toast.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));

const mockPrisma = {
  class: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
  classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
  classSchedule: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  classInstance: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  attendanceRecord: { findMany: vi.fn(), count: vi.fn() },
  classWaitlist: { findMany: vi.fn() },
  rankSystem: { findFirst: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(mockPrisma)),
}));

vi.mock("@/lib/authz", () => ({
  requireStaff: vi.fn(async () => ({
    session: { user: { id: "u1", role: "owner", tenantId: "t1", primaryColor: "var(--color-primary)" } },
  })),
}));
vi.mock("@/components/dashboard/TimetableManager", () => ({ default: () => null }));

function patchReq(body: unknown) {
  return new Request("http://test/api/classes/c1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.findMany.mockResolvedValue([]);
  mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1" });
  mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.classRoster.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.classRoster.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.classSubscription.findMany.mockResolvedValue([]);
  mockPrisma.classSubscription.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.classSchedule.findMany.mockResolvedValue([]);
  mockPrisma.classSchedule.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.classSchedule.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.classInstance.findMany.mockResolvedValue([]);
  mockPrisma.classInstance.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.classInstance.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.attendanceRecord.findMany.mockResolvedValue([]);
  mockPrisma.classWaitlist.findMany.mockResolvedValue([]);
  mockPrisma.rankSystem.findFirst.mockResolvedValue(null);
  mockPrisma.rankSystem.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe("Task 3d — read end: the timetable page loads each class's roster", () => {
  it("selects rosterMembers so the edit form can open in comp-class mode", async () => {
    const TimetablePage = (await import("@/app/dashboard/timetable/page")).default;
    await TimetablePage();

    const args = mockPrisma.class.findMany.mock.calls[0]?.[0] as {
      include?: Record<string, unknown>;
    };
    expect(args.include).toMatchObject({ rosterMembers: { select: { memberId: true } } });
  });

  it("maps rosterMembers onto ClassRow.roster, which is what drives useRoster", async () => {
    mockPrisma.class.findMany.mockResolvedValue([
      {
        id: "c1",
        name: "Comp Team",
        coachName: null,
        coachUserId: null,
        coachUser: null,
        location: null,
        duration: 60,
        maxCapacity: null,
        color: null,
        description: null,
        requiredRankId: null,
        requiredRank: null,
        maxRankId: null,
        maxRank: null,
        schedules: [],
        rosterMembers: [{ memberId: "m1" }, { memberId: "m2" }],
      },
    ]);

    const TimetablePage = (await import("@/app/dashboard/timetable/page")).default;
    const element = (await TimetablePage()) as {
      props: { initialClasses: Array<{ id: string; roster?: { memberId: string }[] }> };
    };

    expect(element.props.initialClasses[0].roster).toEqual([
      { memberId: "m1" },
      { memberId: "m2" },
    ]);
  });
});

describe("Task 3d — write end: only a REAL rank gate clears the roster", () => {
  it("a plain rename with null rank ids leaves ClassRoster untouched", async () => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(
      // Exactly what TimetableManager submits for a non-roster edit.
      patchReq({ name: "Comp Team (Tuesdays)", requiredRankId: null, maxRankId: null }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockPrisma.classRoster.deleteMany).not.toHaveBeenCalled();
  });

  it("...and still clears the rank columns on the Class row", async () => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    await PATCH(patchReq({ name: "Renamed", requiredRankId: null, maxRankId: null }), {
      params: Promise.resolve({ id: "c1" }),
    });

    // Not wiping the roster must not silently stop honouring the rank fields —
    // a success message has to mean the whole body was applied (RULES §2).
    const update = mockPrisma.class.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).toMatchObject({
      name: "Renamed",
      requiredRankId: null,
      maxRankId: null,
    });
  });

  it("naming an actual rank still switches the class into rank-gate mode", async () => {
    mockPrisma.rankSystem.findFirst.mockResolvedValue({
      id: "r-blue",
      order: 2,
      discipline: "BJJ",
    });

    const { PATCH } = await import("@/app/api/classes/[id]/route");
    await PATCH(patchReq({ requiredRankId: "r-blue" }), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(mockPrisma.classRoster.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", tenantId: "t1" },
    });
  });

  it("a maxRank-only gate also clears the roster", async () => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    await PATCH(patchReq({ maxRankId: "r-white" }), {
      params: Promise.resolve({ id: "c1" }),
    });

    expect(mockPrisma.classRoster.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", tenantId: "t1" },
    });
  });

  it("an explicit roster array still replaces the roster", async () => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    await PATCH(
      patchReq({ requiredRankId: null, maxRankId: null, roster: [{ memberId: "m1" }] }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    expect(mockPrisma.classRoster.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", tenantId: "t1" },
    });
    expect(mockPrisma.classRoster.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: "t1", classId: "c1", memberId: "m1", addedByUserId: "u1" }],
      skipDuplicates: true,
    });
  });
});
