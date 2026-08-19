// Task 3c — a staff schedule edit, end to end against real Postgres.
//
// The unit tests in tests/unit/class-schedule-save.test.ts pin the decisions;
// this one proves the whole reconciliation actually round-trips: the Prisma
// calls are valid, the slot rows really flip, the orphaned sessions really go,
// the booked one really survives, and the new time really has instances to
// check into. That last point is the entire user-visible fix — without it,
// changing a class's time silently kills check-in exactly the way task 3a did,
// only in one click instead of four weeks.
//
// Mode A (Neon test branch + tests/setup-test-db.ts gate); skips if
// DATABASE_URL is unset.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH } from "@/app/api/classes/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

/** The next `n`th Monday at local midnight, strictly after today. */
function upcomingMonday(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== 1);
  d.setDate(d.getDate() + (n - 1) * 7);
  return d;
}

type ScheduleChange = {
  slotsAdded: number;
  slotsRemoved: number;
  instancesRemoved: string[];
  instancesKept: string[];
  instancesCreated: number;
};

describe.skipIf(!HAS_DB)("PATCH /api/classes/[id] — schedule edit reconciliation", () => {
  let tenantId: string;
  let classId: string;
  let memberId: string;
  let emptyInstanceId: string;
  let bookedInstanceId: string;
  let body: { scheduleChange: ScheduleChange };

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: `Sched ${STAMP}`, slug: `sched-${STAMP}` },
      });
      tenantId = tenant.id;
      const cls = await tx.class.create({
        data: {
          tenantId,
          name: "Fundamentals",
          duration: 60,
          schedules: {
            create: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
          },
        },
      });
      classId = cls.id;
      const member = await tx.member.create({
        data: { tenantId, name: "Ann", email: `ann-${STAMP}@example.test` },
      });
      memberId = member.id;

      // Two upcoming Mondays at the OLD time. One is empty; one has a member
      // already checked in, which is real state a schedule edit must not eat.
      const empty = await tx.classInstance.create({
        data: { classId, date: upcomingMonday(1), startTime: "18:00", endTime: "19:00" },
      });
      emptyInstanceId = empty.id;
      const booked = await tx.classInstance.create({
        data: { classId, date: upcomingMonday(2), startTime: "18:00", endTime: "19:00" },
      });
      bookedInstanceId = booked.id;
      await tx.attendanceRecord.create({
        data: { tenantId, memberId, classInstanceId: booked.id, checkInMethod: "admin" },
      });
    });

    mockAuth.mockResolvedValue({
      user: { id: "u1", role: "owner", tenantId },
    } as never);

    // Move the class from Monday 18:00 to Monday 19:00.
    const res = await PATCH(
      new Request(`https://test.local/api/classes/${classId}`, {
        method: "PATCH",
        headers: { origin: "https://test.local", host: "test.local" },
        body: JSON.stringify({
          name: "Fundamentals",
          schedules: [{ dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
        }),
      }),
      { params: Promise.resolve({ id: classId }) },
    );
    expect(res.status).toBe(200);
    body = (await res.json()) as { scheduleChange: ScheduleChange };
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { classId } });
      await tx.classSchedule.deleteMany({ where: { classId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("writes the new slot and deactivates the old one", async () => {
    const slots = await withRlsBypass((tx) =>
      tx.classSchedule.findMany({ where: { classId }, orderBy: { startTime: "asc" } }),
    );
    expect(slots).toHaveLength(2);
    expect(slots.find((s) => s.startTime === "18:00")).toMatchObject({ isActive: false });
    expect(slots.find((s) => s.startTime === "19:00")).toMatchObject({
      isActive: true,
      dayOfWeek: 1,
      endTime: "20:00",
    });
  });

  it("removes the orphaned session nobody had booked", async () => {
    const still = await withRlsBypass((tx) =>
      tx.classInstance.findUnique({ where: { id: emptyInstanceId } }),
    );
    expect(still).toBeNull();
    expect(body.scheduleChange.instancesRemoved).toContain(emptyInstanceId);
  });

  it("keeps the orphaned session a member had already checked into", async () => {
    const kept = await withRlsBypass((tx) =>
      tx.classInstance.findUnique({ where: { id: bookedInstanceId } }),
    );
    expect(kept).not.toBeNull();
    expect(kept?.startTime).toBe("18:00");
    expect(body.scheduleChange.instancesKept).toContain(bookedInstanceId);

    // And the register behind it is intact.
    const attendance = await withRlsBypass((tx) =>
      tx.attendanceRecord.count({ where: { classInstanceId: bookedInstanceId } }),
    );
    expect(attendance).toBe(1);
  });

  it("generates instances at the NEW time immediately, so check-in still works", async () => {
    const fresh = await withRlsBypass((tx) =>
      tx.classInstance.findMany({ where: { classId, startTime: "19:00" } }),
    );
    // 56-day horizon → 8 Mondays.
    expect(fresh).toHaveLength(8);
    expect(fresh.every((i) => i.endTime === "20:00")).toBe(true);
    expect(body.scheduleChange.instancesCreated).toBe(8);
  });

  it("is idempotent — re-saving the same schedule changes nothing", async () => {
    const before = await withRlsBypass((tx) => tx.classInstance.count({ where: { classId } }));

    const res = await PATCH(
      new Request(`https://test.local/api/classes/${classId}`, {
        method: "PATCH",
        headers: { origin: "https://test.local", host: "test.local" },
        body: JSON.stringify({
          name: "Fundamentals",
          schedules: [{ dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
        }),
      }),
      { params: Promise.resolve({ id: classId }) },
    );
    const second = (await res.json()) as { scheduleChange: ScheduleChange };

    // No slot moved, so no instance churn at all — and certainly no duplicate
    // set, which is what would happen without task 3b's unique key.
    expect(second.scheduleChange).toMatchObject({ slotsAdded: 0, slotsRemoved: 0, instancesCreated: 0 });
    const after = await withRlsBypass((tx) => tx.classInstance.count({ where: { classId } }));
    expect(after).toBe(before);
  });
});
