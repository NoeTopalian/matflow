/**
 * Task 3c — staff schedule edits were silently discarded.
 *
 * TimetableManager has always sent `schedules` in the PATCH body. The route's
 * `updateSchema` had no `schedules` key, so Zod stripped it, `class.updateMany`
 * never touched ClassSchedule, the client merged the OLD rows back into state,
 * and the toast said "Class updated". There was no PUT/PATCH for ClassSchedule
 * anywhere in the codebase: a class's day or time could only ever be set at
 * creation time. RULES §2 — a success message must mean success.
 *
 * The ruling was to IMPLEMENT the save, not disable the fields, so these tests
 * cover both halves of that: the slots are reconciled, AND the ClassInstance
 * rows those slots had already generated are reconciled with them. That second
 * half is not optional — /api/member/schedule joins instances to the grid by
 * `${classId}-${startTime}`, so moving a class from 18:00 to 19:00 orphans
 * every generated instance and check-in silently vanishes: task 3a's failure,
 * reached in one click instead of four weeks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const { logAuditMock } = vi.hoisted(() => ({
  // Typed via the generic rather than an unused parameter, so `calls[0][0]`
  // is typed for the audit-metadata assertion without tripping no-unused-vars.
  logAuditMock: vi.fn<(args: { metadata: Record<string, unknown> }) => Promise<unknown>>(
    async () => ({}),
  ),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));

const mockPrisma = {
  class: { findFirst: vi.fn(), updateMany: vi.fn() },
  classSchedule: { findMany: vi.fn(), updateMany: vi.fn(), createMany: vi.fn() },
  classInstance: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
  classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(mockPrisma)),
}));

/** 2026-08-19 is a Wednesday; the Mondays after it are the 24th and the 31st. */
const NOW = new Date(2026, 7, 19, 9, 30, 0);
const midnight = (y: number, m: number, d: number) => new Date(y, m, d, 0, 0, 0, 0);

const MON_18 = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" };
const MON_19 = { dayOfWeek: 1, startTime: "19:00", endTime: "20:00" };
const THU_07 = { dayOfWeek: 4, startTime: "07:00", endTime: "08:00" };

function patchReq(body: unknown) {
  return new Request("http://test/api/classes/c1", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

type ScheduleChange = {
  slotsAdded: number;
  slotsRemoved: number;
  instancesRemoved: string[];
  instancesKept: string[];
  instancesCreated: number;
};

async function patch(body: unknown) {
  const { PATCH } = await import("@/app/api/classes/[id]/route");
  const res = await PATCH(patchReq(body), { params: Promise.resolve({ id: "c1" }) });
  return { res, body: (await res.json()) as { scheduleChange: ScheduleChange | null } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", schedules: [] });
  mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.classSchedule.findMany.mockResolvedValue([
    { id: "s-mon18", ...MON_18, isActive: true, startDate: new Date(2020, 0, 1), endDate: null },
  ]);
  mockPrisma.classSchedule.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.classSchedule.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.classInstance.findMany.mockResolvedValue([]);
  mockPrisma.classInstance.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.classInstance.createMany.mockResolvedValue({ count: 0 });
  mockPrisma.classRoster.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.classSubscription.findMany.mockResolvedValue([]);
  mockPrisma.classSubscription.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.rankSystem.findFirst.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── The headline: the field is no longer discarded ──────────────────────────

describe("Task 3c — PATCH /api/classes/[id] actually saves `schedules`", () => {
  it("moves a class from Monday 18:00 to Monday 19:00", async () => {
    const { res } = await patch({ name: "Fundamentals", schedules: [MON_19] });
    expect(res.status).toBe(200);

    // The old slot is deactivated, not deleted — it is the only record that
    // this class once ran at that time, and every reader filters isActive.
    expect(mockPrisma.classSchedule.updateMany).toHaveBeenCalledWith({
      // ClassSchedule carries no tenantId, so the write scopes through the
      // class relation as well as the proven-owned classId (RULES §4).
      where: { id: { in: ["s-mon18"] }, class: { tenantId: "t1" } },
      data: { isActive: false },
    });
    // The new slot is created.
    expect(mockPrisma.classSchedule.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ classId: "c1", dayOfWeek: 1, startTime: "19:00", endTime: "20:00" })],
    });
  });

  it("leaves an unchanged slot completely alone", async () => {
    await patch({ name: "Renamed", schedules: [MON_18] });

    expect(mockPrisma.classSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.classSchedule.createMany).not.toHaveBeenCalled();
    // …and therefore no instance churn either.
    expect(mockPrisma.classInstance.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.classInstance.createMany).not.toHaveBeenCalled();
  });

  it("adds a second day without disturbing the first", async () => {
    await patch({ schedules: [MON_18, THU_07] });

    expect(mockPrisma.classSchedule.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(mockPrisma.classSchedule.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ dayOfWeek: 4, startTime: "07:00" })],
    });
  });

  it("reactivates a dormant slot instead of piling up a new row each time", async () => {
    // Toggling a slot off and on again used to be the shape that accumulates
    // rows forever, because removal is a soft deactivate.
    mockPrisma.classSchedule.findMany.mockResolvedValue([
      { id: "s-mon18", ...MON_18, isActive: true, startDate: new Date(2020, 0, 1), endDate: null },
      { id: "s-thu07", ...THU_07, isActive: false, startDate: new Date(2020, 0, 1), endDate: null },
    ]);

    await patch({ schedules: [MON_18, THU_07] });

    expect(mockPrisma.classSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s-thu07"] }, class: { tenantId: "t1" } },
      data: { isActive: true },
    });
    expect(mockPrisma.classSchedule.createMany).not.toHaveBeenCalled();
  });

  it("does not touch ClassSchedule at all when the body carries no `schedules`", async () => {
    await patch({ name: "Just a rename" });

    expect(mockPrisma.classSchedule.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.classSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.classInstance.deleteMany).not.toHaveBeenCalled();
  });

  it("never forwards `schedules` to class.updateMany", async () => {
    await patch({ name: "Fundamentals", schedules: [MON_19] });
    const data = mockPrisma.class.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("schedules");
    expect(data).not.toHaveProperty("roster");
    expect(data.name).toBe("Fundamentals");
  });
});

// ─── The half that keeps check-in alive ──────────────────────────────────────

describe("Task 3c — the instances a moved slot orphaned", () => {
  /** Two upcoming 18:00 Mondays and one that already matches the new 19:00 slot. */
  function upcomingInstances() {
    mockPrisma.classInstance.findMany.mockResolvedValue([
      { id: "i-empty", date: midnight(2026, 7, 24), startTime: "18:00", _count: { attendances: 0, waitlists: 0 } },
      { id: "i-booked", date: midnight(2026, 7, 31), startTime: "18:00", _count: { attendances: 2, waitlists: 0 } },
      { id: "i-waitlisted", date: midnight(2026, 8, 7), startTime: "18:00", _count: { attendances: 0, waitlists: 1 } },
      { id: "i-valid", date: midnight(2026, 7, 24), startTime: "19:00", _count: { attendances: 0, waitlists: 0 } },
    ]);
    mockPrisma.classSchedule.findMany
      .mockResolvedValueOnce([
        { id: "s-mon18", ...MON_18, isActive: true, startDate: new Date(2020, 0, 1), endDate: null },
      ])
      // Second read: the post-reconciliation active set.
      .mockResolvedValue([{ ...MON_19, startDate: new Date(2020, 0, 1), endDate: null }]);
  }

  it("deletes the orphans nobody has booked, and reports them by id", async () => {
    upcomingInstances();
    const { body } = await patch({ schedules: [MON_19] });

    // ClassInstance carries no tenantId, so the delete scopes through the class
    // relation as well as the proven-owned classId (RULES §4).
    expect(mockPrisma.classInstance.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["i-empty"] }, class: { tenantId: "t1" } },
    });
    // RULES §5: which rows, not just how many.
    expect(body.scheduleChange?.instancesRemoved).toEqual(["i-empty"]);
  });

  it("KEEPS an orphan that members have already checked into or queued for", async () => {
    upcomingInstances();
    const { body } = await patch({ schedules: [MON_19] });

    const deleted = mockPrisma.classInstance.deleteMany.mock.calls[0][0].where.id.in as string[];
    // Deleting these would destroy a register, so they survive and are named
    // for the operator to deal with by hand.
    expect(deleted).not.toContain("i-booked");
    expect(deleted).not.toContain("i-waitlisted");
    expect(body.scheduleChange?.instancesKept).toEqual(["i-booked", "i-waitlisted"]);
  });

  it("leaves instances that still match a live slot alone", async () => {
    upcomingInstances();
    await patch({ schedules: [MON_19] });
    const deleted = mockPrisma.classInstance.deleteMany.mock.calls[0][0].where.id.in as string[];
    expect(deleted).not.toContain("i-valid");
  });

  it("only ever considers sessions from today forward — the past is the register", async () => {
    upcomingInstances();
    await patch({ schedules: [MON_19] });

    const where = mockPrisma.classInstance.findMany.mock.calls[0][0].where as {
      classId: string;
      date: { gte: Date };
    };
    expect(where.classId).toBe("c1");
    expect(where.date.gte).toEqual(midnight(2026, 7, 19));
  });

  it("regenerates the new slot immediately rather than waiting for the nightly cron", async () => {
    upcomingInstances();
    mockPrisma.classInstance.createMany.mockResolvedValue({ count: 8 });
    const { body } = await patch({ schedules: [MON_19] });

    const args = mockPrisma.classInstance.createMany.mock.calls[0][0] as {
      data: Array<{ classId: string; startTime: string; date: Date }>;
      skipDuplicates: boolean;
    };
    // A class whose time just changed would otherwise have no check-in until
    // tomorrow's run. Idempotent against the unique slot key (task 3b), so this
    // and the cron cannot fight.
    expect(args.skipDuplicates).toBe(true);
    expect(args.data.every((d) => d.startTime === "19:00" && d.date.getDay() === 1)).toBe(true);
    expect(args.data).toHaveLength(8); // 56-day horizon
    expect(body.scheduleChange?.instancesCreated).toBe(8);
  });
});

// ─── Telling the operator (RULES §2 and §5) ──────────────────────────────────

describe("Task 3c — the save reports what it did", () => {
  it("returns a scheduleChange summary alongside the class", async () => {
    const { body } = await patch({ schedules: [MON_19] });
    expect(body.scheduleChange).toMatchObject({ slotsAdded: 1, slotsRemoved: 1 });
  });

  it("returns scheduleChange: null when the body carried no schedules", async () => {
    const { body } = await patch({ name: "Renamed" });
    expect(body.scheduleChange).toBeNull();
  });

  it("writes the removed session ids into the audit log, not just a count", async () => {
    mockPrisma.classInstance.findMany.mockResolvedValue([
      { id: "i-empty", date: midnight(2026, 7, 24), startTime: "18:00", _count: { attendances: 0, waitlists: 0 } },
    ]);
    mockPrisma.classSchedule.findMany
      .mockResolvedValueOnce([
        { id: "s-mon18", ...MON_18, isActive: true, startDate: new Date(2020, 0, 1), endDate: null },
      ])
      .mockResolvedValue([{ ...MON_19, startDate: new Date(2020, 0, 1), endDate: null }]);

    await patch({ schedules: [MON_19] });

    const metadata = logAuditMock.mock.calls[0][0].metadata as {
      scheduleChange?: ScheduleChange;
    };
    expect(metadata.scheduleChange?.instancesRemoved).toEqual(["i-empty"]);
  });
});
