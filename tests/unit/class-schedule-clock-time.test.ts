/**
 * The schedule's times are clock times, not shapes.
 *
 * Round 4, lane A0: POST /api/classes answered 201 to `startTime: "25:00"` —
 * `/^\d{2}:\d{2}$/` is a shape check doing duty as a range check, and PATCH
 * shares the schema. These cases pin the range. The ordering of startTime and
 * endTime is deliberately unasserted (see the comment on `clockTime` in
 * lib/schemas/class.ts).
 */
import { describe, it, expect } from "vitest";
import { classCreateSchema } from "@/lib/schemas/class";

function bodyWith(startTime: string, endTime = "19:00") {
  return {
    name: "Fundamentals",
    duration: 60,
    schedules: [{ dayOfWeek: 1, startTime, endTime }],
  };
}

describe("schedule times are 24-hour clock values", () => {
  for (const bad of ["25:00", "47:99", "99:99", "24:00", "12:60", "7:30"]) {
    it(`refuses startTime "${bad}"`, () => {
      expect(classCreateSchema.safeParse(bodyWith(bad)).success).toBe(false);
    });
  }

  it('refuses endTime "26:15"', () => {
    expect(classCreateSchema.safeParse(bodyWith("18:00", "26:15")).success).toBe(false);
  });

  for (const good of ["00:00", "09:05", "18:00", "23:59"]) {
    it(`accepts startTime "${good}"`, () => {
      expect(classCreateSchema.safeParse(bodyWith(good)).success).toBe(true);
    });
  }

  it("accepts a slot that runs past midnight (ordering deliberately unasserted)", () => {
    expect(classCreateSchema.safeParse(bodyWith("23:00", "00:30")).success).toBe(true);
  });
});
