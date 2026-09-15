// A class at "18:00" means 18:00 AT THE GYM. Resolving it needs the club's
// timezone, and until now nothing supplied one.
//
// `lib/class-time.ts` used `setHours`, which resolves in the zone of the
// process — UTC on Vercel. So for a London club through British Summer Time an
// 18:00 class was treated as 18:00 UTC, i.e. 19:00 local, and the check-in
// window opened and closed AN HOUR LATE from late March to late October. A
// member arriving at 17:45 for a 18:00 class was told they were outside the
// window. `Tenant.timezone` had existed the whole time and was read by nothing.
//
// **Both a BST and a GMT date are asserted, deliberately.** The obvious way to
// "fix" this is to add a constant hour somewhere, which is right for seven
// months and wrong for five. Only testing summer would bless exactly that, and
// the winter regression would surface in late October with nobody looking.

import { describe, it, expect } from "vitest";
import { parseTime, classStatus, DEFAULT_TIMEZONE } from "@/lib/class-time";

/** A `ClassInstance.date` as Prisma round-trips it: a UTC wall clock. */
function instanceDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

describe("parseTime resolves the wall clock in the club's zone", () => {
  it("BST: 18:00 in London on 15 June is 17:00 UTC", () => {
    const d = parseTime("18:00", instanceDate("2026-06-15"), "Europe/London");
    expect(d.toISOString()).toBe("2026-06-15T17:00:00.000Z");
  });

  it("GMT: 18:00 in London on 15 January is 18:00 UTC", () => {
    // The control. If someone "fixes" BST by adding an hour unconditionally,
    // this is what catches it.
    const d = parseTime("18:00", instanceDate("2026-01-15"), "Europe/London");
    expect(d.toISOString()).toBe("2026-01-15T18:00:00.000Z");
  });

  it("is NOT the naive UTC reading during BST — the bug, stated directly", () => {
    const fixed = parseTime("18:00", instanceDate("2026-06-15"), "Europe/London");
    const naive = new Date("2026-06-15T18:00:00.000Z");
    expect(
      fixed.getTime(),
      "an 18:00 BST class resolved as 18:00 UTC is the hour that shut members out",
    ).not.toBe(naive.getTime());
    expect(naive.getTime() - fixed.getTime()).toBe(60 * 60 * 1000);
  });

  it("handles a club that is not in the UK at all", () => {
    // A EUR/other-country club is a supported case: Tenant.country and
    // Tenant.currency both exist.
    expect(parseTime("18:00", instanceDate("2026-06-15"), "Europe/Madrid").toISOString()).toBe(
      "2026-06-15T16:00:00.000Z",
    );
    expect(parseTime("18:00", instanceDate("2026-06-15"), "America/New_York").toISOString()).toBe(
      "2026-06-15T22:00:00.000Z",
    );
    // A zone with a half-hour offset, because whole-hour maths is a tempting
    // shortcut that passes every test above.
    expect(parseTime("18:00", instanceDate("2026-06-15"), "Asia/Kolkata").toISOString()).toBe(
      "2026-06-15T12:30:00.000Z",
    );
  });

  it("stays correct on the DST changeover days themselves", () => {
    // 29 Mar 2026 London springs forward at 01:00; 25 Oct falls back at 02:00.
    // An evening class on either day sits on the far side of the transition
    // from the naive guess, which is why the offset is re-read and re-applied.
    expect(parseTime("18:00", instanceDate("2026-03-29"), "Europe/London").toISOString()).toBe(
      "2026-03-29T17:00:00.000Z",
    );
    expect(parseTime("18:00", instanceDate("2026-10-25"), "Europe/London").toISOString()).toBe(
      "2026-10-25T18:00:00.000Z",
    );
  });

  it("takes the calendar day from the UTC components, as Prisma stores them", () => {
    // `ClassInstance.date` is `timestamp` without time zone. Reading its LOCAL
    // components would shift the day on any machine that is not UTC — the
    // failure the campaign fixtures already had to work around.
    const stored = new Date("2026-06-15T00:00:00.000Z");
    expect(parseTime("09:30", stored, "Europe/London").toISOString()).toBe(
      "2026-06-15T08:30:00.000Z",
    );
  });

  it("defaults to the same zone the schema does", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/London");
  });
});

describe("the check-in window this feeds", () => {
  // The consequence, expressed the way a gym would: a member turning up 15
  // minutes early for a summer class must be inside a 30-minute window.
  const WINDOW_BEFORE_MIN = 30;

  function windowOpensAt(dateIso: string, startTime: string, zone: string): Date {
    const startsAt = parseTime(startTime, instanceDate(dateIso), zone);
    return new Date(startsAt.getTime() - WINDOW_BEFORE_MIN * 60_000);
  }

  it("admits a member arriving 15 minutes early to a BST class", () => {
    const opens = windowOpensAt("2026-06-15", "18:00", "Europe/London");
    const arrives = new Date("2026-06-15T16:45:00.000Z"); // 17:45 London
    expect(
      arrives >= opens,
      "17:45 for a 18:00 BST class must be inside the window — this is the member turned away at the door",
    ).toBe(true);
  });

  it("and the same in winter, when nothing should have changed", () => {
    const opens = windowOpensAt("2026-01-15", "18:00", "Europe/London");
    const arrives = new Date("2026-01-15T17:45:00.000Z"); // 17:45 London
    expect(arrives >= opens).toBe(true);
  });
});

describe("classStatus renders in the club's zone", () => {
  it("labels a future class with the club's local start time", () => {
    const status = classStatus(
      { date: instanceDate("2026-06-15"), startTime: "18:00", endTime: "19:00" },
      "Europe/London",
      new Date("2026-06-15T09:00:00.000Z"),
    );
    expect(status.variant).toBe("future");
    // 17:00 UTC is 18:00 in London — the time printed on the timetable.
    expect(status.label).toMatch(/6:00\s?PM/);
  });

  it("knows a BST class is ongoing at the right hour", () => {
    const status = classStatus(
      { date: instanceDate("2026-06-15"), startTime: "18:00", endTime: "19:00" },
      "Europe/London",
      new Date("2026-06-15T17:30:00.000Z"), // 18:30 London — mid-class
    );
    expect(status.variant).toBe("ongoing");
  });
});
