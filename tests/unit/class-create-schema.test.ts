// Creating a class from the timetable drawer with Coach name, Location or
// Description left blank answered 400 "Invalid data" — since the first
// commit. ClassForm.submit() (components/dashboard/TimetableManager.tsx)
// sends `null` for a blank text field; classCreateSchema accepted
// `undefined` only, while the PATCH schema next door accepted null. Only the
// onboarding wizard (which sends `undefined`) ever created a class through
// this route, which is why no environment noticed. Noe, 18 Sep 2026 09:19.
import { describe, it, expect } from "vitest";
import { classCreateSchema } from "@/lib/schemas/class";

// Exactly what ClassForm.submit() builds when only a name and one day are
// filled in — copy of the object literal at TimetableManager.tsx:522-539.
const blankOptionalsPayload = {
  name: "Beginner BJJ",
  coachName: null,
  coachUserId: null,
  location: null,
  duration: 60,
  maxCapacity: null,
  description: null,
  requiredRankId: null,
  maxRankId: null,
  roster: undefined,
  color: "#3b82f6",
  schedules: [{ dayOfWeek: 4, startTime: "12:30", endTime: "13:30" }],
};

describe("classCreateSchema accepts what the timetable form sends", () => {
  it("accepts null for the three optional text fields (the blank-field case)", () => {
    const r = classCreateSchema.safeParse(blankOptionalsPayload);
    expect(r.success, r.success ? "" : JSON.stringify(r.error.flatten())).toBe(true);
  });

  it("still refuses a missing name and an out-of-range duration", () => {
    expect(classCreateSchema.safeParse({ ...blankOptionalsPayload, name: "" }).success).toBe(false);
    expect(classCreateSchema.safeParse({ ...blankOptionalsPayload, duration: 481 }).success).toBe(false);
  });

  it("strips the roster key rather than rejecting it (the form sends it in comp-class mode)", () => {
    const r = classCreateSchema.safeParse({ ...blankOptionalsPayload, roster: [{ memberId: "m1" }] });
    expect(r.success).toBe(true);
    expect(r.success && "roster" in r.data).toBe(false);
  });
});
