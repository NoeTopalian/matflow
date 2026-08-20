/**
 * lib/class-instances.ts — the single weekday-walk shared by the two manual
 * generation endpoints, the nightly cron, and the schedule-edit reconciliation
 * (tasks 3a and 3c).
 *
 * It matters that all four emit byte-identical rows: the deduplication is
 * ClassInstance's @@unique([classId, date, startTime]), so a builder that
 * drifted by an hour or a day would make the nightly job re-insert everything
 * the buttons had already made, every night, forever.
 *
 * The window is a COUNT OF DAYS, not an end date. See the invariance block at
 * the bottom of this file for why: taking an end date and comparing
 * `current <= to` included both endpoints, so "the next N weeks" emitted N+1
 * occurrences of whichever weekday the window started on.
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

/** A second slot on a different weekday, matching the shape used downstream. */
const thursday = { ...monday, dayOfWeek: 4, startTime: "07:00" };

describe("buildInstanceRows", () => {
  it("emits one row per weekly occurrence inside the window", () => {
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      days: 56,
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
      days: 28,
    });
    for (const r of rows) {
      expect([r.date.getHours(), r.date.getMinutes(), r.date.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it("includes an occurrence on the window's final day", () => {
    // days: 6 spans WED..WED+5, and WED+5 is the Monday. The last index is
    // `days - 1`, so the final day is inside the window.
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      days: 6,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].date.getDate()).toBe(days(5).getDate());
  });

  it("excludes an occurrence one day past the window", () => {
    // days: 5 spans WED..WED+4, so the Monday at WED+5 is outside it. This is
    // the boundary that used to be inclusive.
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday] }], {
      from: WED,
      days: 5,
    });
    expect(rows).toEqual([]);
  });

  it("never emits a date outside the window", () => {
    const rows = buildInstanceRows([{ id: "c1", schedules: [monday, thursday] }], {
      from: WED,
      days: 56,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.date.getTime()).toBeGreaterThanOrEqual(WED.getTime());
      expect(r.date.getTime()).toBeLessThanOrEqual(days(55).getTime());
    }
  });

  it("handles several classes and several schedules at once", () => {
    const rows = buildInstanceRows(
      [
        { id: "c1", schedules: [monday, thursday] },
        { id: "c2", schedules: [monday] },
      ],
      { from: WED, days: 28 },
    );
    // 4 weeks: 4 Mondays + 4 Thursdays for c1, 4 Mondays for c2.
    expect(rows.filter((r) => r.classId === "c1")).toHaveLength(8);
    expect(rows.filter((r) => r.classId === "c2")).toHaveLength(4);
  });

  it("does not start before the schedule's own startDate", () => {
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, startDate: days(20) }] }],
      { from: WED, days: 56 },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.date.getTime()).toBeGreaterThanOrEqual(days(20).getTime());
  });

  it("stops at the schedule's endDate — a finished course stops minting classes", () => {
    // The nightly job is exactly where a course that ended in March would keep
    // generating unnoticed until September.
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, endDate: days(20) }] }],
      { from: WED, days: 56 },
    );
    expect(rows).toHaveLength(3); // Mondays at +5, +12, +19
    for (const r of rows) expect(r.date.getTime()).toBeLessThanOrEqual(days(20).getTime());
  });

  it("emits nothing for a schedule whose endDate has already passed", () => {
    const rows = buildInstanceRows(
      [{ id: "c1", schedules: [{ ...monday, endDate: days(-10) }] }],
      { from: WED, days: 56 },
    );
    expect(rows).toEqual([]);
  });

  it("emits nothing for a class with no schedules", () => {
    expect(buildInstanceRows([{ id: "c1", schedules: [] }], { from: WED, days: 56 })).toEqual([]);
  });

  it("emits nothing for a zero-length window", () => {
    expect(
      buildInstanceRows([{ id: "c1", schedules: [monday] }], { from: WED, days: 0 }),
    ).toEqual([]);
  });
});

// ─── The regression this block exists for ────────────────────────────────────

describe("buildInstanceRows — the count never depends on which weekday it starts", () => {
  /**
   * The bug: the window used to be an end date (`from + N*7`) compared with
   * `current <= to`, which includes BOTH endpoints. A window advertised as N
   * weeks therefore spanned N*7 + 1 days and emitted an N+1th occurrence of
   * whichever weekday `from` landed on. Asking for "the next 1 week" on a
   * Monday produced two Mondays.
   *
   * It surfaced as a date-dependent test: the same call produced 52 candidates
   * on five days of the week and 53 on the two the fixture's schedules used,
   * so it went red when the calendar reached one of them. Per RULES §6 a test
   * that passes or fails for reasons unrelated to correctness is not a test —
   * but the cause here was a genuine off-by-one in the route, not naive
   * fixture arithmetic, so the route was fixed and this pins the property.
   *
   * Every start weekday is exercised, so it cannot go quiet again.
   */
  const WEEKDAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  for (let offset = 0; offset < 7; offset++) {
    const start = days(offset);
    const name = WEEKDAY_NAMES[start.getDay()];

    it(`gives exactly 4 per schedule over 4 weeks, starting on a ${name}`, () => {
      const rows = buildInstanceRows([{ id: "c1", schedules: [monday, thursday] }], {
        from: start,
        days: 4 * 7,
      });
      // Not a coincidence of the calendar: a window of exactly 28 days holds
      // exactly four of every weekday, wherever it starts.
      expect(rows).toHaveLength(8);
      expect(rows.filter((r) => r.date.getDay() === 1)).toHaveLength(4);
      expect(rows.filter((r) => r.date.getDay() === 4)).toHaveLength(4);
    });

    it(`gives exactly 26 per schedule over 26 weeks, starting on a ${name}`, () => {
      // The window the failing assertion used: 26 weeks x 2 schedules = 52,
      // now true by construction rather than by luck of the date.
      const rows = buildInstanceRows([{ id: "c1", schedules: [monday, thursday] }], {
        from: start,
        days: 26 * 7,
      });
      expect(rows).toHaveLength(52);
    });
  }
});
