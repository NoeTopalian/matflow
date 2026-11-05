// "Today", "yesterday" and "4 November" on the Activity timeline are CLUB days:
// half-open windows of instants from local midnight to the next local
// midnight in Tenant.timezone. A day is 23 or 25 hours long twice a year, so
// the end is the start of the next calendar date, never start + 24 h.
import { describe, it, expect } from "vitest";
import { clubDayKey, clubDayWindow, parseDayKey, shiftDayKey } from "@/lib/club-month";
import { formatDate, formatDateFull, formatDateTime, formatTime } from "@/lib/date";

const iso = (w: { start: Date; nextStart: Date }) => [w.start.toISOString(), w.nextStart.toISOString()];
const hours = (w: { start: Date; nextStart: Date }) => (w.nextStart.getTime() - w.start.getTime()) / 3_600_000;

describe("clubDayWindow", () => {
  it("is 23 hours long on the day the clocks go forward (Europe/London, 29 Mar 2026)", () => {
    const w = clubDayWindow("2026-03-29", "Europe/London");
    expect(iso(w)).toEqual(["2026-03-29T00:00:00.000Z", "2026-03-29T23:00:00.000Z"]);
    expect(hours(w)).toBe(23);
  });

  it("is 25 hours long on the day the clocks go back (Europe/London, 25 Oct 2026)", () => {
    const w = clubDayWindow("2026-10-25", "Europe/London");
    expect(iso(w)).toEqual(["2026-10-24T23:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
    expect(hours(w)).toBe(25);
  });

  it("starts at the club's midnight east and west of Greenwich", () => {
    expect(iso(clubDayWindow("2026-11-05", "Pacific/Auckland"))).toEqual(["2026-11-04T11:00:00.000Z", "2026-11-05T11:00:00.000Z"]);
    expect(iso(clubDayWindow("2026-11-05", "America/Los_Angeles"))).toEqual(["2026-11-05T08:00:00.000Z", "2026-11-06T08:00:00.000Z"]);
  });

  it("crosses a month and a year end by calendar date", () => {
    expect(iso(clubDayWindow("2026-12-31", "Europe/London"))).toEqual(["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
  });

  it("does not throw where the clocks change at local midnight, and both ends are that day", () => {
    // Cairo's clocks go forward at 00:00 on the last Friday of April: local
    // midnight does not exist that day.
    const w = clubDayWindow("2026-04-24", "Africa/Cairo");
    expect(hours(w)).toBe(23);
    expect(clubDayKey(w.start, "Africa/Cairo")).toBe("2026-04-24");
    expect(clubDayKey(new Date(w.nextStart.getTime() - 1), "Africa/Cairo")).toBe("2026-04-24");
    expect(clubDayKey(w.nextStart, "Africa/Cairo")).toBe("2026-04-25");
  });
});

describe("clubDayKey", () => {
  it("names the club's date, not UTC's", () => {
    // 23:30Z on 24 Oct is 00:30 BST on 25 Oct.
    expect(clubDayKey(new Date("2026-10-24T23:30:00.000Z"), "Europe/London")).toBe("2026-10-25");
    expect(clubDayKey(new Date("2026-11-04T12:00:00.000Z"), "Pacific/Auckland")).toBe("2026-11-05");
    expect(clubDayKey(new Date("2026-11-05T03:00:00.000Z"), "America/Los_Angeles")).toBe("2026-11-04");
  });

  it("agrees with the window it falls in", () => {
    const instant = new Date("2026-03-29T22:59:59.999Z");
    const key = clubDayKey(instant, "Europe/London");
    const w = clubDayWindow(key, "Europe/London");
    expect(instant.getTime()).toBeGreaterThanOrEqual(w.start.getTime());
    expect(instant.getTime()).toBeLessThan(w.nextStart.getTime());
  });
});

describe("day keys", () => {
  it("shifts by calendar days", () => {
    expect(shiftDayKey("2026-11-05", -1)).toBe("2026-11-04");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDayKey("2026-11-05", -365)).toBe("2025-11-05");
  });

  it("accepts a real date and nothing else", () => {
    expect(parseDayKey("2026-11-04")).toBe("2026-11-04");
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("04/11/2026")).toBeNull();
    expect(parseDayKey("2026-11-4")).toBeNull();
    expect(parseDayKey("")).toBeNull();
    expect(parseDayKey(null)).toBeNull();
    expect(parseDayKey(["2026-11-04"])).toBeNull();
  });
});

describe("lib/date in a named zone", () => {
  const instant = new Date("2026-11-04T19:45:00.000Z");

  it("formats the time and date on the club's clock", () => {
    expect(formatTime(instant, "Europe/London")).toBe("19:45");
    expect(formatTime(instant, "Asia/Makassar")).toBe("03:45");
    expect(formatDate(instant, "Asia/Makassar")).toBe("5 Nov 2026");
    expect(formatDateTime(instant, "Europe/London")).toBe("4 Nov 2026, 19:45");
  });

  it("names a whole date", () => {
    expect(formatDateFull(instant, "Europe/London")).toBe("Wednesday 4 November 2026");
    expect(formatDateFull(instant, "Pacific/Auckland")).toBe("Thursday 5 November 2026");
  });

  it("reads midnight as 00:00, not 24:00", () => {
    expect(formatTime(new Date("2026-11-04T00:00:00.000Z"), "UTC")).toBe("00:00");
  });
});
