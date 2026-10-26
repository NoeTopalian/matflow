// D4 (24 Oct 2026): the overnight and daylight-saving rule.
//
// The defect: lib/checkin.ts read a session's end on the START's day, so a
// 23:00–00:30 class "ended" at 00:30 that morning, 22½ hours before it began,
// and every window-enforcing door (member app, parent, kiosk) refused it all
// evening as "after". The rule now (lib/class-time.ts sessionBounds):
//   - times are the club's wall clock on the session's date;
//   - an end at or before the start is on the next club day;
//   - a time in the repeated DST hour is its later occurrence (after the
//     clocks go back, as every London result already was and the importers
//     pin); a time in the skipped hour moves forward by the gap. The same in
//     every zone (the old two-pass read differed west of UTC).
// lib/schedule-state.ts draws with the same overnight rule (endsNextDay).

import { describe, it, expect } from "vitest";
import { parseTime, sessionBounds, checkinWindowVerdict, classStatus, endsNextDay } from "@/lib/class-time";
import { spanMinutes, sessionState } from "@/lib/schedule-state";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const at = (iso: string) => new Date(iso);
const W = { beforeMin: 30, afterMin: 30 };
const LONDON = "Europe/London";

describe("overnight: 23:00–00:30 on Saturday 13 June 2026 (London, BST)", () => {
  const inst = { date: day("2026-06-13"), startTime: "23:00", endTime: "00:30" };

  it("ends at 00:30 on Sunday, 90 minutes after it starts", () => {
    const { start, end } = sessionBounds(inst, LONDON);
    expect(start.toISOString()).toBe("2026-06-13T22:00:00.000Z"); // 23:00 BST
    expect(end?.toISOString()).toBe("2026-06-13T23:30:00.000Z"); // 00:30 BST on the 14th
    expect((end!.getTime() - start.getTime()) / 60_000).toBe(90);
  });

  it("admits at 23:15 (it was refused as 'after' before the fix)", () => {
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-13T22:15:00.000Z"))).toEqual({ open: true });
  });

  it("admits at 00:20 on Sunday, inside the session", () => {
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-13T23:20:00.000Z"))).toEqual({ open: true });
  });

  it("opens 30 minutes before and closes 30 minutes after the next-day end", () => {
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-13T21:29:00.000Z"))).toEqual({ open: false, when: "before" }); // 22:29
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-13T21:30:00.000Z"))).toEqual({ open: true }); // 22:30
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-14T00:00:00.000Z"))).toEqual({ open: true }); // 01:00
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-06-14T00:01:00.000Z"))).toEqual({ open: false, when: "after" }); // 01:01
  });

  it("reads Ongoing at 23:15 and 00:20 and Ended after 00:30", () => {
    expect(classStatus(inst, LONDON, at("2026-06-13T22:15:00.000Z")).variant).toBe("ongoing");
    expect(classStatus(inst, LONDON, at("2026-06-13T23:20:00.000Z")).variant).toBe("ongoing");
    expect(classStatus(inst, LONDON, at("2026-06-13T23:31:00.000Z")).variant).toBe("ended");
  });

  it("is the rule the timetable geometry draws with", () => {
    expect(endsNextDay("23:00", "00:30")).toBe(true);
    expect(endsNextDay("18:00", "18:00")).toBe(true); // equal = 24 hours, as spanMinutes
    expect(endsNextDay("18:00", "19:00")).toBe(false);
    const span = spanMinutes("23:00", "00:30");
    expect(span).toEqual({ startMin: 23 * 60, endMin: 24 * 60 + 30 });
    expect(sessionState(span, 23 * 60 + 15)).toBe("live");
  });

  it("a same-day class is unchanged: 18:00–19:00 closes at 19:30", () => {
    const sameDay = { date: day("2026-06-13"), startTime: "18:00", endTime: "19:00" };
    expect(sessionBounds(sameDay, LONDON).end?.toISOString()).toBe("2026-06-13T18:00:00.000Z");
    expect(checkinWindowVerdict(sameDay, LONDON, W, at("2026-06-13T18:31:00.000Z"))).toEqual({ open: false, when: "after" });
  });

  it("a session with no recorded end (imported history) still closes from its start", () => {
    const imported = { date: day("2026-06-13"), startTime: "23:00", endTime: null };
    expect(sessionBounds(imported, LONDON).end).toBeNull();
    expect(checkinWindowVerdict(imported, LONDON, W, at("2026-06-13T22:31:00.000Z"))).toEqual({ open: false, when: "after" });
  });
});

describe("the repeated hour: Sunday 25 October 2026, London (01:00–01:59 happens twice)", () => {
  it("a wall time in the repeated hour is its LATER occurrence (GMT)", () => {
    expect(parseTime("01:30", day("2026-10-25"), LONDON).toISOString()).toBe("2026-10-25T01:30:00.000Z");
    expect(parseTime("01:00", day("2026-10-25"), LONDON).toISOString()).toBe("2026-10-25T01:00:00.000Z");
    // Either side of the hour has one instant each.
    expect(parseTime("00:59", day("2026-10-25"), LONDON).toISOString()).toBe("2026-10-24T23:59:00.000Z");
    expect(parseTime("02:00", day("2026-10-25"), LONDON).toISOString()).toBe("2026-10-25T02:00:00.000Z");
  });

  it("an overnight 23:30–01:30 session ends at the later 01:30 (GMT), three hours after it starts", () => {
    const inst = { date: day("2026-10-24"), startTime: "23:30", endTime: "01:30" };
    const { start, end } = sessionBounds(inst, LONDON);
    expect(start.toISOString()).toBe("2026-10-24T22:30:00.000Z");
    expect(end?.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    // Open through BOTH 01:30s; closes 30 minutes after the second, at 02:00 GMT.
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-10-25T00:30:00.000Z"))).toEqual({ open: true }); // first 01:30 (BST)
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-10-25T02:00:00.000Z"))).toEqual({ open: true });
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-10-25T02:01:00.000Z"))).toEqual({ open: false, when: "after" });
  });

  it("a class inside the repeated hour opens before the later occurrence: 01:15–01:45 is 01:15–01:45 GMT", () => {
    const inst = { date: day("2026-10-25"), startTime: "01:15", endTime: "01:45" };
    const { start, end } = sessionBounds(inst, LONDON);
    expect(start.toISOString()).toBe("2026-10-25T01:15:00.000Z");
    expect(end?.toISOString()).toBe("2026-10-25T01:45:00.000Z");
    // 00:20Z is 01:20 BST, the first time the clocks show 01:20: before the window (opens 00:45Z).
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-10-25T00:20:00.000Z"))).toEqual({ open: false, when: "before" });
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-10-25T01:20:00.000Z"))).toEqual({ open: true });
  });

  it("00:30–02:30 on the changeover night runs three hours of elapsed time", () => {
    const { start, end } = sessionBounds({ date: day("2026-10-25"), startTime: "00:30", endTime: "02:30" }, LONDON);
    expect((end!.getTime() - start.getTime()) / 3_600_000).toBe(3);
  });

  it("an evening class that day is unaffected (18:00 GMT)", () => {
    expect(parseTime("18:00", day("2026-10-25"), LONDON).toISOString()).toBe("2026-10-25T18:00:00.000Z");
  });
});

describe("the skipped hour: Sunday 29 March 2026, London (01:00–01:59 never happens)", () => {
  it("a wall time in the gap moves forward by the gap: 01:30 is 02:30 BST", () => {
    expect(parseTime("01:30", day("2026-03-29"), LONDON).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(parseTime("00:30", day("2026-03-29"), LONDON).toISOString()).toBe("2026-03-29T00:30:00.000Z"); // still GMT
    expect(parseTime("02:30", day("2026-03-29"), LONDON).toISOString()).toBe("2026-03-29T01:30:00.000Z"); // BST
  });

  it("00:30–02:30 that night runs one hour of elapsed time", () => {
    const { start, end } = sessionBounds({ date: day("2026-03-29"), startTime: "00:30", endTime: "02:30" }, LONDON);
    expect((end!.getTime() - start.getTime()) / 3_600_000).toBe(1);
  });

  it("an overnight 23:00–01:30 session from Saturday ends at 02:30 BST", () => {
    const inst = { date: day("2026-03-28"), startTime: "23:00", endTime: "01:30" };
    const { start, end } = sessionBounds(inst, LONDON);
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(end?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(checkinWindowVerdict(inst, LONDON, W, at("2026-03-29T00:45:00.000Z"))).toEqual({ open: true }); // 00:45 GMT
  });

  it("an evening class that day is unaffected (18:00 BST)", () => {
    expect(parseTime("18:00", day("2026-03-29"), LONDON).toISOString()).toBe("2026-03-29T17:00:00.000Z");
  });
});

describe("a club that is not in London", () => {
  it("Bali (Asia/Makassar, UTC+8, no DST): 23:00–00:30 admits at 23:15 and 00:20 local", () => {
    const inst = { date: day("2026-06-13"), startTime: "23:00", endTime: "00:30" };
    const { start, end } = sessionBounds(inst, "Asia/Makassar");
    expect(start.toISOString()).toBe("2026-06-13T15:00:00.000Z");
    expect(end?.toISOString()).toBe("2026-06-13T16:30:00.000Z");
    expect(checkinWindowVerdict(inst, "Asia/Makassar", W, at("2026-06-13T15:15:00.000Z"))).toEqual({ open: true });
    expect(checkinWindowVerdict(inst, "Asia/Makassar", W, at("2026-06-13T16:20:00.000Z"))).toEqual({ open: true });
  });

  it("New York: overnight across midnight, and both DST rules on its own changeover days", () => {
    const inst = { date: day("2026-06-13"), startTime: "23:00", endTime: "00:30" };
    expect(sessionBounds(inst, "America/New_York").end?.toISOString()).toBe("2026-06-14T04:30:00.000Z");
    expect(checkinWindowVerdict(inst, "America/New_York", W, at("2026-06-14T04:20:00.000Z"))).toEqual({ open: true }); // 00:20 EDT
    // 1 Nov 2026: 01:00–01:59 repeats; 01:30 is the later (EST, UTC-5) — the same rule as London.
    // (The old two-pass read gave the first, 05:30Z, west of UTC.)
    expect(parseTime("01:30", day("2026-11-01"), "America/New_York").toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // 8 Mar 2026: 02:00–02:59 is skipped; 02:30 moves forward to 03:30 EDT.
    // (The old two-pass read moved it BACK to 01:30 EST, 06:30Z.)
    expect(parseTime("02:30", day("2026-03-08"), "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});
