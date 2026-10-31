/**
 * T8c (17 Oct 2026) — getReportsData returns `membership`: movement and
 * headcount by club month, replayed from status history.
 *
 * Pins, with a mocked transaction:
 * - every membership read carries the tenantId, and events are read for
 *   training members only (no guardians);
 * - the current month's headcount equals the "Active members" tile;
 * - the TeamUp ledger is planned in memory for ledger members with no
 *   back-filled events (per member), and back-filled events are used as they
 *   are;
 * - "TeamUp history without dates" counts only members the planner could
 *   not date for want of a date;
 * - the series is club-wide: the class and age filters never reach it.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findMany: vi.fn(), count: vi.fn() },
    classInstance: { findMany: vi.fn() },
    // The coverage start (lib/attendance-coverage, 28 Oct 2026): records since 2020, so every period here is covered
    // and its counts read as they always did. A plain function, so a mock reset never clears it.
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn(), findFirst: async () => ({ checkInTime: new Date("2020-01-01T12:00:00.000Z") }) },
    member: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    payment: { count: vi.fn(), findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    memberStatusEvent: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    importedMembership: { findMany: vi.fn() },
    // No import job: the attendance coverage read skips its imported-history probes (31 Oct 2026).
    importJob: { findMany: vi.fn(), findFirst: async () => null },
  },
}));

import { prisma } from "@/lib/prisma";
import { getReportsData } from "@/lib/reports";

type Args = { where?: Record<string, unknown>; select?: Record<string, unknown>; distinct?: string[] };

const IMPORT_DAY = new Date("2026-10-03T11:39:57.000Z");
const MEMBERS = [
  { id: "m1", status: "active", joinedAt: new Date("2024-02-01T00:00:00Z"), cancelledAt: null, email: "a@x.test", importJobId: "job1" },
  { id: "m2", status: "cancelled", joinedAt: new Date("2025-01-10T00:00:00Z"), cancelledAt: new Date("2026-06-30T00:00:00Z"), email: "b@x.test", importJobId: "job1" },
  { id: "m3", status: "active", joinedAt: new Date("2026-10-09T09:00:00Z"), cancelledAt: null, email: "c@x.test", importJobId: null },
];
const OPENING = (memberId: string, toStatus: string) => ({
  id: `ev-${memberId}`, memberId, fromStatus: null, toStatus, reason: "import", sourceAction: "import_create", sourceJobId: "job1", occurredAt: IMPORT_DAY, createdAt: IMPORT_DAY,
});
const EVENTS = [
  OPENING("m1", "active"),
  OPENING("m2", "cancelled"),
  { id: "ev-m3", memberId: "m3", fromStatus: null, toStatus: "active", reason: "staff_edit", sourceAction: null, sourceJobId: null, occurredAt: MEMBERS[2].joinedAt, createdAt: MEMBERS[2].joinedAt },
];
const LEDGER = [
  { id: "l1", memberId: "m1", importJobId: "job1", type: "recurring", status: "active", entitlement: "current", startDate: new Date("2024-02-01T00:00:00Z"), expiryDate: null, cancelledDate: null, completedAt: null },
  { id: "l2", memberId: "m2", importJobId: "job1", type: "recurring", status: "cancelled", entitlement: "history", startDate: new Date("2025-01-10T00:00:00Z"), expiryDate: null, cancelledDate: new Date("2026-06-30T00:00:00Z"), completedAt: null },
];

function setup({ events = EVENTS, backfilled = [] as string[] }: { events?: typeof EVENTS; backfilled?: string[] } = {}) {
  vi.mocked(prisma.class.findMany).mockResolvedValue([{ id: "c1", name: "Kids" }] as never);
  vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.classInstance.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.member.groupBy).mockResolvedValue([{ status: "active", _count: 2 }, { status: "cancelled", _count: 1 }] as never);
  vi.mocked(prisma.member.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.member.findMany).mockImplementation(((args: Args) => {
    const sel = args.select ?? {};
    if ("cancelledAt" in sel && "status" in sel && "joinedAt" in sel) return Promise.resolve(MEMBERS.map(({ id, status, joinedAt, cancelledAt }) => ({ id, status, joinedAt, cancelledAt })) as never);
    if ("email" in sel) return Promise.resolve(MEMBERS.filter((m) => (args.where?.id as { in: string[] }).in.includes(m.id)).map(({ id, email, importJobId }) => ({ id, email, importJobId })) as never);
    return Promise.resolve([] as never);
  }) as never);
  vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ timezone: "Europe/London" } as never);
  vi.mocked(prisma.memberStatusEvent.findMany).mockResolvedValue(events as never);
  vi.mocked(prisma.memberStatusEvent.count).mockResolvedValue(0 as never);
  // Two groupBy reads in the planner: members with back-filled events (where
  // sourceAction), and each member's first event.
  vi.mocked(prisma.memberStatusEvent.groupBy).mockImplementation(((args: Args) =>
    Promise.resolve(
      (args.where && "sourceAction" in args.where
        ? backfilled.map((memberId) => ({ memberId, _count: { _all: 1 } }))
        : [{ memberId: "m1", _min: { occurredAt: IMPORT_DAY } }, { memberId: "m2", _min: { occurredAt: IMPORT_DAY } }]) as never,
    )) as never);
  vi.mocked(prisma.importedMembership.findMany).mockImplementation(((args: Args) =>
    Promise.resolve((args.distinct ? [{ memberId: "m1" }, { memberId: "m2" }] : LEDGER) as never)) as never);
  vi.mocked(prisma.importJob.findMany).mockResolvedValue([{ id: "job1", createdAt: IMPORT_DAY }] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The window is the twelve club months ending now: pin now so the months asserted below stay in it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T10:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getReportsData — membership (T8c)", () => {
  it("every membership read is tenant-scoped, and events are read for training members only", async () => {
    setup();
    await getReportsData("tenant-A");
    const ev = vi.mocked(prisma.memberStatusEvent.findMany).mock.calls[0][0] as Args;
    expect(ev.where).toMatchObject({ tenantId: "tenant-A", member: { tenantId: "tenant-A", accountType: { not: "parent" } } });
    const ledger = vi.mocked(prisma.importedMembership.findMany).mock.calls.map((c) => (c[0] as Args).where);
    for (const w of ledger) expect(w).toMatchObject({ tenantId: "tenant-A" });
    const members = vi.mocked(prisma.member.findMany).mock.calls.map((c) => (c[0] as Args).where);
    for (const w of members) expect(w).toMatchObject({ tenantId: "tenant-A" });
    expect(vi.mocked(prisma.tenant.findUnique).mock.calls[0][0]).toMatchObject({ where: { id: "tenant-A" } });
  });

  it("today's headcount equals the Active members tile, history before the import comes from the ledger, and is estimated", async () => {
    setup();
    const data = await getReportsData("tenant-A");
    const m = data.membership;
    expect(m.headcountByMonth).toHaveLength(12);
    expect(m.headcountByMonth[11].headcount).toBe(data.summary.activeMembers);
    expect(m.historySource).toBe("ledger");
    expect(m.boundary).toBe(IMPORT_DAY.toISOString());
    // m2 cancelled 30 Jun 2026 (from the ledger); m3 joined in MatFlow on 9 Oct.
    const by = (k: string) => m.movementsByMonth.find((r) => r.month === k)!;
    expect(by("2026-06")).toMatchObject({ lostCancelled: 1, basis: "estimated" });
    // October starts before the import day, so it is partly estimated.
    expect(by("2026-10")).toMatchObject({ new: 1, imported: 0, basis: "mixed" });
    expect(m.headcountByMonth[11].basis).toBe("recorded");
    expect(m.headcountByMonth.find((r) => r.month === "2026-05")!.headcount).toBe(2);
    expect(m.headcountByMonth.find((r) => r.month === "2026-07")!.headcount).toBe(1);
    expect(m.undatedHistory).toBe(0);
  });

  it("uses back-filled events as they are and never plans the ledger again", async () => {
    const backfill = [
      { id: "bf1", memberId: "m1", fromStatus: null, toStatus: "active", reason: "import", sourceAction: "import_backfill", sourceJobId: "job1", occurredAt: new Date("2024-02-01T00:00:00Z"), createdAt: new Date("2026-10-18T00:00:00Z") },
      { id: "bf2", memberId: "m2", fromStatus: null, toStatus: "active", reason: "import", sourceAction: "import_backfill", sourceJobId: "job1", occurredAt: new Date("2025-01-10T00:00:00Z"), createdAt: new Date("2026-10-18T00:00:00Z") },
      { id: "bf3", memberId: "m2", fromStatus: "active", toStatus: "cancelled", reason: "import", sourceAction: "import_backfill", sourceJobId: "job1", occurredAt: new Date("2026-06-29T23:00:00Z"), createdAt: new Date("2026-10-18T00:00:00Z") },
    ];
    setup({ events: [...EVENTS, ...backfill] as typeof EVENTS, backfilled: ["m1", "m2"] });
    const data = await getReportsData("tenant-A");
    expect(data.membership.historySource).toBe("backfill");
    expect(vi.mocked(prisma.importJob.findMany)).not.toHaveBeenCalled();
    expect(data.membership.movementsByMonth.find((r) => r.month === "2026-06")).toMatchObject({ lostCancelled: 1, basis: "estimated" });
    // The back-filled rows do not move the boundary: it stays the import day.
    expect(data.membership.boundary).toBe(IMPORT_DAY.toISOString());
  });

  it("an imported member with no ledger rows takes earlier history from their join date; undated ledger members are counted from the import day", async () => {
    setup();
    const undated = LEDGER.filter((l) => l.memberId === "m2").map((l) => ({ ...l, cancelledDate: null }));
    vi.mocked(prisma.importedMembership.findMany).mockImplementation(((args: Args) =>
      Promise.resolve((args.distinct ? [{ memberId: "m2" }] : undated) as never)) as never);
    const data = await getReportsData("tenant-A");
    // m1: no ledger rows, opened by the import, joined Feb 2024 -> active since then.
    expect(data.membership.fromJoinDates).toBe(1);
    expect(data.membership.headcountByMonth[0].headcount).toBe(1);
    // m2: ledger row with no cancellation date -> no earlier history, counted from the import day.
    expect(data.membership.undatedHistory).toBe(1);
    expect(data.membership.headcountByMonth[11].headcount).toBe(data.summary.activeMembers);
  });

  it("idempotency is per member: a ledger member without back-filled events is still planned from the ledger", async () => {
    // m1 was back-filled; m2 came in later and has none yet.
    const backfill = [
      { id: "bf1", memberId: "m1", fromStatus: null, toStatus: "active", reason: "import", sourceAction: "import_backfill", sourceJobId: "job1", occurredAt: new Date("2024-02-01T00:00:00Z"), createdAt: new Date("2026-10-18T00:00:00Z") },
    ];
    setup({ events: [...EVENTS, ...backfill] as typeof EVENTS, backfilled: ["m1"] });
    const data = await getReportsData("tenant-A");
    expect(data.membership.historySource).toBe("backfill");
    // m2's cancellation on 30 Jun 2026 comes from the ledger planned in memory.
    expect(data.membership.movementsByMonth.find((r) => r.month === "2026-06")).toMatchObject({ lostCancelled: 1, basis: "estimated" });
    expect(data.membership.headcountByMonth.find((r) => r.month === "2026-05")!.headcount).toBe(2);
    expect(data.membership.undatedHistory).toBe(0);
  });

  it("an erased ledger member is not counted as TeamUp history without dates", async () => {
    setup();
    vi.mocked(prisma.member.findMany).mockImplementation(((args: Args) => {
      const sel = args.select ?? {};
      if ("cancelledAt" in sel && "status" in sel && "joinedAt" in sel) return Promise.resolve(MEMBERS.map(({ id, status, joinedAt, cancelledAt }) => ({ id, status, joinedAt, cancelledAt })) as never);
      if ("email" in sel) {
        return Promise.resolve(
          MEMBERS.filter((m) => (args.where?.id as { in: string[] }).in.includes(m.id)).map(({ id, email, importJobId }) => ({
            id,
            email: id === "m2" ? "deleted-m2@deleted.invalid" : email,
            importJobId,
          })) as never,
        );
      }
      return Promise.resolve([] as never);
    }) as never);
    const data = await getReportsData("tenant-A");
    expect(data.membership.undatedHistory).toBe(0);
  });

  it("a member who predates the event log and is cancelled by staff after it counts as one lost", async () => {
    setup();
    const cancelledByStaff = { id: "ev-m3c", memberId: "m3", fromStatus: "active", toStatus: "cancelled", reason: "staff_edit", sourceAction: null, sourceJobId: null, occurredAt: new Date("2026-10-12T10:00:00Z"), createdAt: new Date("2026-10-12T10:00:00Z") };
    // m3 has no creation event: their first event is the cancellation.
    const members = MEMBERS.map((m) => (m.id === "m3" ? { ...m, status: "cancelled", joinedAt: new Date("2025-03-01T00:00:00Z"), cancelledAt: new Date("2026-10-12T10:00:00Z") } : m));
    vi.mocked(prisma.member.findMany).mockImplementation(((args: Args) => {
      const sel = args.select ?? {};
      if ("cancelledAt" in sel && "status" in sel && "joinedAt" in sel) return Promise.resolve(members.map(({ id, status, joinedAt, cancelledAt }) => ({ id, status, joinedAt, cancelledAt })) as never);
      if ("email" in sel) return Promise.resolve(members.filter((m) => (args.where?.id as { in: string[] }).in.includes(m.id)).map(({ id, email, importJobId }) => ({ id, email, importJobId })) as never);
      return Promise.resolve([] as never);
    }) as never);
    vi.mocked(prisma.memberStatusEvent.findMany).mockResolvedValue([EVENTS[0], EVENTS[1], cancelledByStaff] as never);
    const data = await getReportsData("tenant-A");
    expect(data.membership.movementsByMonth.find((r) => r.month === "2026-10")).toMatchObject({ lostCancelled: 1 });
    expect(data.membership.fromJoinDates).toBe(1);
  });

  it("is club-wide: the class and age filters never reach the membership reads", async () => {
    setup();
    const a = await getReportsData("tenant-A");
    vi.clearAllMocks();
    setup();
    const b = await getReportsData("tenant-A", { classId: "c1", ageGroup: "kids" });
    const ev = vi.mocked(prisma.memberStatusEvent.findMany).mock.calls[0][0] as Args;
    expect(JSON.stringify(ev.where)).not.toMatch(/classInstance|kids|junior/);
    expect(b.membership.headcountByMonth.map((h) => h.headcount)).toEqual(a.membership.headcountByMonth.map((h) => h.headcount));
  });
});
