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

  it("refuses a class with no day — Noe, 18 Sep 10:06: all minimum criteria must be filled", () => {
    const { schedules: _omit, ...noSchedules } = blankOptionalsPayload;
    expect(classCreateSchema.safeParse(noSchedules).success).toBe(false);
    expect(classCreateSchema.safeParse({ ...blankOptionalsPayload, schedules: [] }).success).toBe(false);
  });

  // Was: "strips the roster key rather than rejecting it". Stripping is what
  // made a ticked comp squad vanish behind a 201 — the form sends the array in
  // comp-class mode and nothing stored it. The schema now KEEPS it and
  // POST /api/classes writes the ClassRoster rows in the create transaction
  // (see class-create-roster.test.ts).
  it("keeps the roster key the form sends in comp-class mode", () => {
    const r = classCreateSchema.safeParse({ ...blankOptionalsPayload, roster: [{ memberId: "m1" }] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.roster).toEqual([{ memberId: "m1" }]);
  });

  // Mats (5 Nov 2026): in a club with mats the form sends `matId` (the chosen
  // mat, or null for "No mat") and, on a mat, no `location` at all — the
  // server writes the mat's name.
  it("accepts what the form sends for a club with mats: a mat with no place, or no mat with a typed place", () => {
    const { location: _omit, ...noPlace } = blankOptionalsPayload;
    const onMat = classCreateSchema.safeParse({ ...noPlace, matId: "cmh2m4t0000001" });
    expect(onMat.success && onMat.data.matId).toBe("cmh2m4t0000001");
    const offMat = classCreateSchema.safeParse({ ...blankOptionalsPayload, matId: null, location: "Sports hall" });
    expect(offMat.success && offMat.data).toMatchObject({ matId: null, location: "Sports hall" });
    // A club with no mats sends no matId at all, as before.
    expect(classCreateSchema.safeParse(blankOptionalsPayload).success).toBe(true);
  });

  it("refuses a matId that is empty, not a string, or longer than an id can be", () => {
    for (const matId of ["", 7, "x".repeat(65)]) {
      expect(classCreateSchema.safeParse({ ...blankOptionalsPayload, matId }).success).toBe(false);
    }
  });
});
