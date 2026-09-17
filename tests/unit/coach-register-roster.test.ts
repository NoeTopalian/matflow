// GET /api/coach/instances/[id]/register — the roster is not the subscriber
// list.
//
// It used to be built from `ClassSubscription` alone, so a member who was
// scanned in with a card, or marked on Mark Attendance, or added to the club
// that morning, was invisible on the very register the coach uses to see who
// is here. The scanner's demo script promises "open today's register to show
// the same names ticked" — and for an unsubscribed member that was false.
// The roster is now subscribers ∪ everyone with an AttendanceRecord for the
// instance; the latter carry `walkIn: true`. X-6 lane A, F1.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  requireApiStaffMock,
  instanceFindFirstMock,
  subscriptionFindManyMock,
  attendanceFindManyMock,
  attendanceGroupByMock,
  waitlistFindManyMock,
  memberFindManyMock,
} = vi.hoisted(() => ({
  requireApiStaffMock: vi.fn(),
  instanceFindFirstMock: vi.fn(),
  subscriptionFindManyMock: vi.fn(),
  attendanceFindManyMock: vi.fn(),
  attendanceGroupByMock: vi.fn(),
  waitlistFindManyMock: vi.fn(),
  memberFindManyMock: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: requireApiStaffMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: instanceFindFirstMock },
      classSubscription: { findMany: subscriptionFindManyMock },
      attendanceRecord: { findMany: attendanceFindManyMock, groupBy: attendanceGroupByMock },
      classWaitlist: { findMany: waitlistFindManyMock },
      member: { findMany: memberFindManyMock },
    }),
}));

import { GET } from "@/app/api/coach/instances/[id]/register/route";

const member = (id: string, name: string) => ({
  id,
  name,
  email: `${id}@example.test`,
  status: "active",
  accountType: "adult",
  membershipType: null,
  waiverAccepted: true,
  waiverAcceptedAt: null,
  memberRanks: [],
});

const params = Promise.resolve({ id: "inst-1" });

describe("the register roster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiStaffMock.mockResolvedValue({ ok: true, tenantId: "tenant-1", userId: "owner-1", role: "owner" });
    instanceFindFirstMock.mockResolvedValue({
      id: "inst-1",
      date: new Date("2026-09-18T00:00:00Z"),
      startTime: "12:30",
      endTime: "13:30",
      class: { id: "class-1", name: "Demo", location: null, coachName: null, maxCapacity: null, color: null },
    });
    waitlistFindManyMock.mockResolvedValue([]);
    attendanceGroupByMock.mockResolvedValue([]);
  });

  it("lists a scanned-in member who never subscribed, flagged as a walk-in and ticked", async () => {
    subscriptionFindManyMock.mockResolvedValue([{ member: member("booked", "Booked Person") }]);
    attendanceFindManyMock.mockResolvedValue([
      { memberId: "booked", checkInTime: new Date("2026-09-18T12:31:00Z"), checkInMethod: "admin" },
      { memberId: "walkin", checkInTime: new Date("2026-09-18T12:32:00Z"), checkInMethod: "qr" },
    ]);
    memberFindManyMock.mockResolvedValue([member("walkin", "Walk In")]);

    const body = await (await GET(new Request("http://x"), { params })).json();
    const byId = Object.fromEntries(body.expected.map((m: { memberId: string }) => [m.memberId, m]));

    expect(Object.keys(byId).sort()).toEqual(["booked", "walkin"]);
    expect(byId.walkin.walkIn).toBe(true);
    expect(byId.walkin.attended).toBe(true);
    expect(byId.walkin.attendedMethod).toBe("qr");
    expect(byId.booked.walkIn).toBe(false);

    // The walk-in lookup is tenant-scoped and asks only for the ids not already booked.
    const args = memberFindManyMock.mock.calls[0][0] as { where: { id: { in: string[] }; tenantId: string } };
    expect(args.where.id.in).toEqual(["walkin"]);
    expect(args.where.tenantId).toBe("tenant-1");
  });

  it("does not query members at all when every attendee is a subscriber", async () => {
    subscriptionFindManyMock.mockResolvedValue([{ member: member("booked", "Booked Person") }]);
    attendanceFindManyMock.mockResolvedValue([
      { memberId: "booked", checkInTime: new Date("2026-09-18T12:31:00Z"), checkInMethod: "admin" },
    ]);
    const body = await (await GET(new Request("http://x"), { params })).json();
    expect(body.expected).toHaveLength(1);
    expect(memberFindManyMock).not.toHaveBeenCalled();
  });

  it("a walk-in's last visit is looked up like anyone else's", async () => {
    subscriptionFindManyMock.mockResolvedValue([]);
    attendanceFindManyMock.mockResolvedValue([
      { memberId: "walkin", checkInTime: new Date("2026-09-18T12:32:00Z"), checkInMethod: "kiosk" },
    ]);
    memberFindManyMock.mockResolvedValue([member("walkin", "Walk In")]);
    attendanceGroupByMock.mockResolvedValue([{ memberId: "walkin", _max: { checkInTime: new Date("2026-09-11T12:00:00Z") } }]);
    const body = await (await GET(new Request("http://x"), { params })).json();
    expect(body.expected[0].lastVisitAt).toBe("2026-09-11T12:00:00.000Z");
    const groupArgs = attendanceGroupByMock.mock.calls[0][0] as { where: { memberId: { in: string[] } } };
    expect(groupArgs.where.memberId.in).toEqual(["walkin"]);
  });
});
