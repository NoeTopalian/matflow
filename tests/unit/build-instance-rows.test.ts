/**
 * lib/class-instances.ts — the single weekday-walk shared by the two manual
 * generation endpoints and the nightly cron (task 3a).
 *
 * It matters that all three emit byte-identical rows: the deduplication is
 * ClassInstance's @@unique([classId, date, startTime]), so a builder that
 * drifted by an hour or a day would make the nightly job re-insert everything
 * the buttons had already made, every night, forever.
 */
import { describe, it, expect } from "vitest";
import { buildInstanceRows } from "@/lib/class-instances";

/** 2026-08-19 is a Wednesday. */
const WED = new Date(2026, 7, 19, 0, 0, 0, 0);
const days = (n: number) => {
  const d = new Date(WED);
  d.setDate(WED.getDate() + n);
  return d;
};

const monday = {
  dayOfWeek: 1,
  startTime: "18:00",
  endTime: "19:00",
  startDate: new Date(2020, 0, 1),
  endDate: null,
};

describe("buildInstanceRows", () => {
  it("emits one row per weekly occurrence inside the window", () => {
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      to: days(56),
    });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.date.getDay() === 1)).toBe(true);
    expect(rows.every((r) => r.startTime === "18:00" && r.endTime === "19:00")).toBe(true);
  });

  it("keeps the caller's midnight boundary on every emitted date", () => {
    // The unique key matches on `date`, so a drifting time-of-day would make
    // every run insert a fresh duplicate set.
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      to: days(28),
    });
    for (const r of rows) {
      expect([r.date.getHours(), r.date.getMinutes(), r.date.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it("includes an occurrence falling exactly on the window's last day", () => {
    // days(5) is the Monday after WED.
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      to: days(5),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].date.getDate()).toBe(days(5).getDate());
  });

  it("handles several classes and several schedules at once", () => {
    const rows = buildInstanceRows(
      [
        { id: "c1", schedules: [monday, { ...monday, dayOfWeek: 4, startTime: "07:00" }] },
        { id: "c2", schedules: [monday] },
      ],
      { from: WED, to: days(28) },
    );
    // 4 weeks: 4 Mondays + 4 Thursdays for c1, 4 Mondays for c2.
    expect(rows.filter((r) => r.classId === "c1")).toHaveLength(8);
    expect(rows.filter((r) => r.classId === "c2")).toHaveLength(4);
  });

  it("does not start before the schedule's own startDate", () => {
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, startDate: days(20) }] }],
      { from: WED, to: days(56) },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.date.getTime()).toBeGreaterThanOrEqual(days(20).getTime());
  });

  it("stops at the schedule's endDate — a finished course stops minting classes", () => {
    // The nightly job is exactly where a course that ended in March would keep
    // generating unnoticed until September.
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, endDate: days(20) }] }],
      { from: WED, to: days(56) },
    );
    expect(rows).toHaveLength(3); // Mondays at +5, +12, +19
    for (const r of rows) expect(r.date.getTime()).toBeLessThanOrEqual(days(20).getTime());
  });

  it("emits nothing for a schedule whose endDate has already passed", () => {
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, endDate: days(-10) }] }],
      { from: WED, to: days(56) },
    );
    expect(rows).toEqual([]);
  });

  it("emits nothing for a class with no schedules", () => {
    expect(buildInstanceRows([{ id: "c1", schedules: [] }], { from: WED, to: days(56) })).toEqual([]);
  });
});
