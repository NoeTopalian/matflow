// Mark Attendance used to open on instances[0] — the earliest class of the
// day — so at 12:30 it offered the 10:00 class. Noe, 18 Sep 2026: the class
// happening at this moment comes first and is already selected.
import { describe, it, expect } from "vitest";
import { pickDefault, type TodaySession } from "@/components/dashboard/SessionPicker";

const s = (
  id: string,
  startTime: string,
  status: TodaySession["status"],
  classId = id,
  isCancelled = false,
): TodaySession => ({
  id,
  classId,
  name: id,
  startTime,
  endTime: "23:59",
  location: null,
  color: null,
  coachName: null,
  attendedCount: 0,
  waitlistCount: 0,
  maxCapacity: null,
  status,
  isCancelled,
  cancellationReason: null,
  isMine: false,
});

describe("pickDefault", () => {
  it("prefers the session that is on now, then the next one, never one that has ended", () => {
    expect(pickDefault([s("a", "10:00", "ended"), s("b", "12:15", "ongoing"), s("c", "18:00", "future")], null)).toBe("b");
    expect(pickDefault([s("a", "10:00", "ended"), s("c", "18:00", "future")], null)).toBe("c");
    expect(pickDefault([s("a", "10:00", "ended"), s("d", "12:40", "soon")], null)).toBe("d");
    expect(pickDefault([s("a", "10:00", "ended")], null)).toBeNull();
    expect(pickDefault([], null)).toBeNull();
  });

  it("honours ?class= when that class has a session today, and ignores it otherwise", () => {
    expect(pickDefault([s("a", "10:00", "ended", "classA"), s("b", "12:15", "ongoing", "classB")], "classA")).toBe("a");
    expect(pickDefault([s("b", "12:15", "ongoing", "classB")], "nope")).toBe("b");
  });
});

describe("pickDefault and a cancelled session", () => {
  // /api/coach/today now RETURNS cancelled sessions (it used to filter them
  // out, so calling one off made it vanish from the staff's own day). They are
  // shown, struck through — and never opened on, because every check-in into
  // one is refused at lib/checkin.ts:148 and the screen could do nothing.
  it("never opens on a cancelled session, even when it is the one on now", () => {
    expect(
      pickDefault([s("a", "12:15", "ongoing", "a", true), s("b", "18:00", "future")], null),
    ).toBe("b");
  });

  it("ignores ?class= when that class's session today is cancelled", () => {
    expect(
      pickDefault([s("a", "12:15", "ongoing", "cls-1", true), s("b", "18:00", "future")], "cls-1"),
    ).toBe("b");
  });

  it("returns null when every session today is cancelled", () => {
    expect(pickDefault([s("a", "12:15", "ongoing", "a", true)], null)).toBe(null);
  });
});
