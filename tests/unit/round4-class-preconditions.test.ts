// Round 4 (10 Nov 2026): the class editor sends only changed fields, each
// with the value it loaded, so a save from an older tab cannot put back a
// capacity or coach (the server refuses it as `stale_class`).
import { describe, it, expect } from "vitest";
import { withClassPreconditions } from "@/components/dashboard/TimetableManager";

const loaded = { name: "Fundamentals", coachName: "Sam", coachUserId: null, duration: 60, maxCapacity: 20, isKids: false, description: null, requiredRankId: null, maxRankId: null, locationId: null };

describe("withClassPreconditions", () => {
  it("drops unchanged fields and expects the loaded value of each changed one", () => {
    const payload = { ...loaded, maxCapacity: 30, schedules: [], baseScheduleIds: ["s1"], color: "#fff" };
    expect(withClassPreconditions(payload, loaded)).toEqual({ maxCapacity: 30, schedules: [], baseScheduleIds: ["s1"], color: "#fff", expected: { maxCapacity: 20 } });
  });

  it("with nothing changed there is no expected block", () => {
    expect(withClassPreconditions({ ...loaded, schedules: [] }, loaded)).toEqual({ schedules: [] });
  });

  it("a field the loaded class lacks is sent, expecting null (the server accepts it when the stored value already matches)", () => {
    expect(withClassPreconditions({ coachUserId: "u1" }, {})).toEqual({ coachUserId: "u1", expected: { coachUserId: null } });
  });
});
