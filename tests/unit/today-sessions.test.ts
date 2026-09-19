// A class on the timetable must be offered for check-in today whether or not
// a cron has ever run: on production none has (CRON_SECRET absent), POST
// /api/classes minted nothing until 18 Sep, and the only Generate button sat
// in Mark Attendance's empty state for owner/manager. Noe, 18 Sep 10:22: "it
// doesn't come up with the option to sign people into classes happening at
// this moment." Materialise today's rows on read, idempotently.
import { describe, it, expect, vi } from "vitest";
import { clubDayMarker, ensureTodayInstances } from "@/lib/today-sessions";

describe("clubDayMarker", () => {
  // Round-3 day-marker migration: the marker is UTC midnight of the club's
  // calendar date. It used to be the PROCESS's midnight of that date, so these
  // assertions read in UTC now — and that is the point, not a translation. The
  // old spelling made the returned instant depend on where the code ran, which
  // is how one club day got two byte patterns and skipDuplicates stopped
  // deduplicating.
  it("is UTC midnight of the CLUB's calendar date, not the process's", () => {
    // 23:30 UTC on Thu 17 Sep is already Fri 18 Sep in London (BST).
    const m = clubDayMarker(new Date("2026-09-17T23:30:00Z"), "Europe/London");
    expect([m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()]).toEqual([2026, 8, 18]);
    expect(m.toISOString()).toBe("2026-09-18T00:00:00.000Z");
  });

  it("uses the club date for a zone west of UTC too", () => {
    // 02:00 UTC on Fri 18 Sep is still Thu 17 Sep in New York.
    const m = clubDayMarker(new Date("2026-09-18T02:00:00Z"), "America/New_York");
    expect([m.getUTCMonth(), m.getUTCDate()]).toEqual([8, 17]);
    expect(m.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("does not depend on the host's zone: the same club day is one instant", () => {
    // The invariant the migration exists for. `Date.UTC` is a pure function of
    // (now, club zone); `new Date(y, m, d)` was a function of the host too, so
    // Vercel wrote 00:00Z and a BST laptop wrote 23:00Z of the day before for
    // the very same club day.
    for (const tz of ["Pacific/Kiritimati", "Asia/Makassar", "Europe/London", "America/Los_Angeles"]) {
      const m = clubDayMarker(new Date("2026-09-19T19:00:00.000Z"), tz);
      expect(m.getTime() % 86_400_000, `${tz}: marker ${m.toISOString()} is not a UTC midnight`).toBe(0);
    }
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
    expect(call.data[0].date.getUTCDay()).toBe(5);
    expect(call.data[0].date.toISOString()).toBe("2026-09-18T00:00:00.000Z");
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
