// A class on the timetable must be offered for check-in today whether or not
// a cron has ever run: on production none has (CRON_SECRET absent), POST
// /api/classes minted nothing until 18 Sep, and the only Generate button sat
// in Mark Attendance's empty state for owner/manager. Noe, 18 Sep 10:22: "it
// doesn't come up with the option to sign people into classes happening at
// this moment." Materialise today's rows on read, idempotently.
import { describe, it, expect, vi } from "vitest";
import { clubDayMarker, ensureTodayInstances } from "@/lib/today-sessions";

describe("clubDayMarker", () => {
  it("is process-local midnight of the CLUB's calendar date, not the process's", () => {
    // 23:30 UTC on Thu 17 Sep is already Fri 18 Sep in London (BST).
    const m = clubDayMarker(new Date("2026-09-17T23:30:00Z"), "Europe/London");
    expect([m.getFullYear(), m.getMonth(), m.getDate()]).toEqual([2026, 8, 18]);
    expect([m.getHours(), m.getMinutes(), m.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("uses the club date for a zone west of UTC too", () => {
    // 02:00 UTC on Fri 18 Sep is still Thu 17 Sep in New York.
    const m = clubDayMarker(new Date("2026-09-18T02:00:00Z"), "America/New_York");
    expect([m.getMonth(), m.getDate()]).toEqual([8, 17]);
  });
});

describe("ensureTodayInstances", () => {
  const schedules = [
    { dayOfWeek: 5, startTime: "12:30", endTime: "13:30", startDate: null, endDate: null }, // Friday
    { dayOfWeek: 1, startTime: "18:00", endTime: "19:00", startDate: null, endDate: null }, // Monday
  ];

  it("creates today's rows from active schedules with skipDuplicates, and only today's", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([{ id: "c1", schedules }]);
    const tx = { class: { findMany }, classInstance: { createMany } };

    const now = new Date("2026-09-18T09:00:00Z"); // a Friday
    const created = await ensureTodayInstances(tx as never, "t1", "Europe/London", now);

    expect(created).toBe(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", isActive: true, deletedAt: null } }),
    );
    const call = createMany.mock.calls[0][0] as { data: Array<{ classId: string; date: Date; startTime: string; endTime: string }>; skipDuplicates: boolean };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(1);
    expect(call.data[0]).toMatchObject({ classId: "c1", startTime: "12:30", endTime: "13:30" });
    expect(call.data[0].date.getDay()).toBe(5);
    expect(call.data[0].date.getHours()).toBe(0);
  });

  it("makes no write when nothing is scheduled today", async () => {
    const createMany = vi.fn();
    const tx = {
      class: { findMany: vi.fn().mockResolvedValue([{ id: "c1", schedules: [schedules[1]] }]) },
      classInstance: { createMany },
    };
    const created = await ensureTodayInstances(tx as never, "t1", "Europe/London", new Date("2026-09-18T09:00:00Z"));
    expect(created).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("asks only for active, undeleted classes and active schedules", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const tx = { class: { findMany }, classInstance: { createMany: vi.fn() } };
    await ensureTodayInstances(tx as never, "t1", "Europe/London", new Date("2026-09-18T09:00:00Z"));
    const args = findMany.mock.calls[0][0] as { select: { schedules: { where: { isActive: boolean } } } };
    expect(args.select.schedules.where).toEqual({ isActive: true });
  });
});
