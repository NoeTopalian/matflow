import { describe, it, expect } from "vitest";
import { getWeekKey, calculateStreak } from "@/lib/streak";

describe("getWeekKey", () => {
  it("returns the same Monday for a Monday", () => {
    expect(getWeekKey(new Date("2026-04-13T12:00:00Z"))).toBe("2026-04-13");
  });

  it("returns the preceding Monday for a Sunday (end of week)", () => {
    expect(getWeekKey(new Date("2026-04-19T12:00:00Z"))).toBe("2026-04-13");
  });

  it("returns the preceding Monday for a midweek day", () => {
    expect(getWeekKey(new Date("2026-04-15T12:00:00Z"))).toBe("2026-04-13");
  });

  it("handles Saturday correctly", () => {
    expect(getWeekKey(new Date("2026-04-18T12:00:00Z"))).toBe("2026-04-13");
  });
});

describe("calculateStreak", () => {
  const now = new Date("2026-04-18T12:00:00Z"); // Saturday

  it("returns 1 for a single attendance in the current week", () => {
    const dates = [new Date("2026-04-15T10:00:00Z")]; // Wednesday this week
    expect(calculateStreak(dates, now)).toBe(1);
  });

  it("returns 4 for 4 consecutive attended weeks", () => {
    const dates = [
      new Date("2026-04-15T10:00:00Z"), // this week (Apr 13–19)
      new Date("2026-04-08T10:00:00Z"), // -1 week  (Apr 6–12)
      new Date("2026-04-01T10:00:00Z"), // -2 weeks (Mar 30–Apr 5)
      new Date("2026-03-25T10:00:00Z"), // -3 weeks (Mar 23–29)
    ];
    expect(calculateStreak(dates, now)).toBe(4);
  });

  it("stops the streak at a gap week", () => {
    const dates = [
      new Date("2026-04-15T10:00:00Z"), // this week
      new Date("2026-04-08T10:00:00Z"), // -1 week
      // -2 weeks: no attendance (gap)
      new Date("2026-03-25T10:00:00Z"), // -3 weeks
    ];
    expect(calculateStreak(dates, now)).toBe(2);
  });

  it("counts Sunday attendance toward the correct Monday-start week", () => {
    const dates = [new Date("2026-04-19T10:00:00Z")]; // Sunday of same week as Mon Apr 13
    expect(calculateStreak(dates, now)).toBe(1);
  });

  it("returns 0 when there is no attendance at all", () => {
    expect(calculateStreak([], now)).toBe(0);
  });

  it("continues streak through an empty current week (mid-week logic)", () => {
    // current week (w=0) gap does NOT break the streak — you may not have trained yet
    const dates = [
      new Date("2026-04-08T10:00:00Z"), // -1 week
      new Date("2026-04-01T10:00:00Z"), // -2 weeks
      new Date("2026-03-25T10:00:00Z"), // -3 weeks
    ];
    expect(calculateStreak(dates, now)).toBe(3);
  });
});
