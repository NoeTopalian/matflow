import { describe, it, expect } from "vitest";
import { classStatus } from "@/lib/class-time";

// Helper: build an inst object with today's date and given HH:mm times
function makeInst(startTime: string, endTime: string, dateStr: string) {
  return { startTime, endTime, date: new Date(dateStr) };
}

describe("classStatus", () => {
  const DATE = "2026-04-27";

  it("returns future with 'Starts at HH:mm' label when 90 min before start", () => {
    // class at 14:00–15:00, now = 12:30
    const now = new Date(`${DATE}T12:30:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("future");
    expect(result.label).toMatch(/^Starts at /);
  });

  it("returns soon with 'Starts in 30 min' when 30 min before start", () => {
    // class at 14:00–15:00, now = 13:30
    const now = new Date(`${DATE}T13:30:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("soon");
    expect(result.label).toBe("Starts in 30 min");
  });

  it("returns ongoing when now is during class", () => {
    // class at 14:00–15:00, now = 14:30
    const now = new Date(`${DATE}T14:30:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("ongoing");
    expect(result.label).toBe("Ongoing");
  });

  it("returns ended when now is after class end", () => {
    // class at 14:00–15:00, now = 15:30
    const now = new Date(`${DATE}T15:30:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("ended");
    expect(result.label).toBe("Ended");
  });

  it("edge: exactly at start → ongoing", () => {
    const now = new Date(`${DATE}T14:00:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("ongoing");
  });

  it("edge: exactly at end → ongoing (not yet past)", () => {
    const now = new Date(`${DATE}T15:00:00`);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("ongoing");
  });

  it("edge: 1 second after end → ended", () => {
    // parseTime sets seconds to 0, so end = 15:00:00; now = 15:00:01
    const endDate = new Date(`${DATE}T15:00:00`);
    const now = new Date(endDate.getTime() + 1000);
    const inst = makeInst("14:00", "15:00", DATE);
    const result = classStatus(inst, now);
    expect(result.variant).toBe("ended");
  });
});
