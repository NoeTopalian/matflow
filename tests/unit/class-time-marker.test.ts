// ClassInstance.date is a calendar-day MARKER with several spellings — the
// cron writes the process's midnight (00:00Z on Vercel), a BST laptop writes
// 23:00Z the day before, a Bali laptop 16:00Z the day before. todayWindow
// already admits all of them; parseTime read the calendar day from the UTC
// components and so filed every off-midnight spelling a day early, which put
// a class's check-in window and its "on now" status a day out on any process
// not running in UTC. X-7 Task 5 M2, pulled forward 18 Sep 2026 when the
// attendance hub's "Now" badge read "Ended" on the laptop.
import { describe, it, expect } from "vitest";
import { parseTime, classStatus } from "@/lib/class-time";

describe("parseTime reads the calendar day from the UTC midnight nearest the marker", () => {
  it("both spellings of Friday 18 Sep resolve 18:00 London to the same instant", () => {
    const seedSpelling = new Date("2026-09-17T23:00:00Z"); // BST laptop midnight
    const cronSpelling = new Date("2026-09-18T00:00:00Z"); // Vercel midnight
    expect(parseTime("18:00", seedSpelling, "Europe/London").toISOString()).toBe("2026-09-18T17:00:00.000Z");
    expect(parseTime("18:00", cronSpelling, "Europe/London").toISOString()).toBe("2026-09-18T17:00:00.000Z");
  });

  it("a Bali laptop's spelling (17 Sep 16:00Z = 18 Sep 00:00 WITA) is Friday too", () => {
    expect(parseTime("18:00", new Date("2026-09-17T16:00:00Z"), "Europe/London").toISOString()).toBe("2026-09-18T17:00:00.000Z");
  });

  it("a New York cron marker resolves in New York time", () => {
    expect(parseTime("18:00", new Date("2026-06-14T00:00:00Z"), "America/New_York").toISOString()).toBe("2026-06-14T22:00:00.000Z");
  });

  it("classStatus is ongoing at 12:30 London for a slot 12:15–13:15 stored under the laptop spelling", () => {
    const status = classStatus(
      { date: new Date("2026-09-17T23:00:00Z"), startTime: "12:15", endTime: "13:15" },
      "Europe/London",
      new Date("2026-09-18T11:30:00Z"),
    );
    expect(status.variant).toBe("ongoing");
  });
});
