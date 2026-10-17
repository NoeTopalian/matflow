// T6d — squad (roster-only) classes at the desk.
//
// Acceptance 3: the desk register for a squad class says so. The register
// payload carries `instance.rosterOnly`, and each row says whether that member
// is on the roster (`notOnRoster`), read tenant-scoped. The session picker's
// list (/api/coach/today) carries `rosterOnly` too, so the desk sees "Squad
// only" before it opens the register.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const m = vi.hoisted(() => ({
  requireApiStaff: vi.fn(),
  instanceFindFirst: vi.fn(),
  instanceFindMany: vi.fn(),
  instanceCreateMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  attendanceFindMany: vi.fn(),
  attendanceGroupBy: vi.fn(),
  waitlistFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  redemptionFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  classFindMany: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: m.requireApiStaff }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: { findUnique: m.tenantFindUnique },
      class: { findMany: m.classFindMany },
      classInstance: { findFirst: m.instanceFindFirst, findMany: m.instanceFindMany, createMany: m.instanceCreateMany },
      classSubscription: { findMany: m.subscriptionFindMany },
      attendanceRecord: { findMany: m.attendanceFindMany, groupBy: m.attendanceGroupBy },
      classWaitlist: { findMany: m.waitlistFindMany },
      member: { findMany: m.memberFindMany },
      classPackRedemption: { findMany: m.redemptionFindMany },
    }),
}));

import { GET as registerGET } from "@/app/api/coach/instances/[id]/register/route";
import { GET as todayGET } from "@/app/api/coach/today/route";

const member = (id: string, name: string, onRoster: boolean) => ({
  id, name, email: `${id}@example.test`, status: "active", accountType: "adult",
  membershipType: "Unlimited", membershipTierId: "t-beg", membershipTier: { name: "Beginners" },
  classRosters: onRoster ? [{ id: `r-${id}` }] : [],
  waiverAccepted: true, waiverAcceptedAt: null, memberRanks: [],
});

function squadInstance(rosterCount: number, allowedTiers: { tier: { id: string; name: string } }[] = []) {
  return {
    id: "inst-1",
    date: new Date("2026-10-17T00:00:00Z"),
    startTime: "18:00",
    endTime: "19:00",
    class: {
      id: "class-squad", name: "Comp Squad", location: null, coachName: null, maxCapacity: null, color: null, isKids: false,
      allowedTiers, _count: { rosterMembers: rosterCount },
    },
  };
}

const params = Promise.resolve({ id: "inst-1" });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "tenant-1", userId: "owner-1", role: "owner" });
  m.waitlistFindMany.mockResolvedValue([]);
  m.attendanceGroupBy.mockResolvedValue([]);
  m.redemptionFindMany.mockResolvedValue([]);
  m.attendanceFindMany.mockResolvedValue([]);
  m.memberFindMany.mockResolvedValue([]);
  m.subscriptionFindMany.mockResolvedValue([]);
});

describe("register — a squad class", () => {
  it("acceptance 3: the register payload says the class is squad only", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(2));
    const body = await (await registerGET(new Request("http://x"), { params })).json();
    expect(body.instance.rosterOnly).toBe(true);
  });

  it("an open class is not squad only", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(0));
    const body = await (await registerGET(new Request("http://x"), { params })).json();
    expect(body.instance.rosterOnly).toBe(false);
  });

  it("flags a booked or walked-in member who is not on the roster; a rostered one is not flagged", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(1));
    m.subscriptionFindMany.mockResolvedValue([{ member: member("on", "On Squad", true) }]);
    m.attendanceFindMany.mockResolvedValue([
      { id: "a1", memberId: "off", checkInTime: new Date("2026-10-17T18:01:00Z"), checkInMethod: "admin" },
    ]);
    m.memberFindMany.mockResolvedValue([member("off", "Off Squad", false)]);
    const body = await (await registerGET(new Request("http://x"), { params })).json();
    const byId = Object.fromEntries(body.expected.map((r: { memberId: string }) => [r.memberId, r]));
    expect(byId.on.notOnRoster).toBe(false);
    expect(byId.off.notOnRoster).toBe(true);
  });

  it("reads roster membership tenant-scoped, for this class only", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(1));
    m.attendanceFindMany.mockResolvedValue([
      { id: "a1", memberId: "off", checkInTime: new Date("2026-10-17T18:01:00Z"), checkInMethod: "admin" },
    ]);
    m.memberFindMany.mockResolvedValue([member("off", "Off Squad", false)]);
    await registerGET(new Request("http://x"), { params });
    const subSelect = m.subscriptionFindMany.mock.calls[0][0].include.member.select;
    const walkInSelect = m.memberFindMany.mock.calls[0][0].select;
    for (const select of [subSelect, walkInSelect]) {
      expect(select.classRosters).toEqual({ where: { tenantId: "tenant-1", classId: "class-squad" }, select: { id: true }, take: 1 });
    }
  });

  it("at an open class nobody is flagged", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(0));
    m.subscriptionFindMany.mockResolvedValue([{ member: member("x", "Anyone", false) }]);
    const body = await (await registerGET(new Request("http://x"), { params })).json();
    expect(body.expected[0].notOnRoster).toBe(false);
  });

  it("a rostered member on a plan the class's memberships exclude is not asked about the plan (roster governs)", async () => {
    m.instanceFindFirst.mockResolvedValue(squadInstance(1, [{ tier: { id: "t-adv", name: "Advanced" } }]));
    m.subscriptionFindMany.mockResolvedValue([{ member: member("on", "On Squad", true) }]);
    const body = await (await registerGET(new Request("http://x"), { params })).json();
    expect(body.expected[0].tierNotIncluded).toBe(false);
    expect(body.expected[0].notOnRoster).toBe(false);
  });
});

describe("/api/coach/today — the squad flag on the session list", () => {
  beforeEach(() => {
    m.tenantFindUnique.mockResolvedValue({ timezone: "Europe/London" });
    m.classFindMany.mockResolvedValue([]);
    m.instanceCreateMany.mockResolvedValue({ count: 0 });
  });

  it("asks for a roster count and returns rosterOnly per session", async () => {
    m.instanceFindMany.mockResolvedValue([
      {
        id: "i-squad", date: new Date("2026-10-17T00:00:00Z"), startTime: "18:00", endTime: "19:00", isCancelled: false, cancellationReason: null,
        class: { id: "c-squad", name: "Comp Squad", location: null, coachName: null, instructorId: null, coachUserId: null, maxCapacity: null, color: null, _count: { rosterMembers: 4 } },
        _count: { attendances: 0, waitlists: 0 },
      },
      {
        id: "i-open", date: new Date("2026-10-17T00:00:00Z"), startTime: "19:00", endTime: "20:00", isCancelled: false, cancellationReason: null,
        class: { id: "c-open", name: "Fundamentals", location: null, coachName: null, instructorId: null, coachUserId: null, maxCapacity: null, color: null, _count: { rosterMembers: 0 } },
        _count: { attendances: 0, waitlists: 0 },
      },
    ]);
    const body = (await (await todayGET()).json()) as Array<{ id: string; rosterOnly: boolean }>;
    expect(Object.fromEntries(body.map((s) => [s.id, s.rosterOnly]))).toEqual({ "i-squad": true, "i-open": false });
    const select = m.instanceFindMany.mock.calls[0][0].include.class.select;
    expect(select._count).toEqual({ select: { rosterMembers: true } });
  });
});
