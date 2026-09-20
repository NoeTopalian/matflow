import { z } from "zod";

/**
 * One recurring slot. Exported so PATCH /api/classes/[id] validates schedule
 * edits against the exact shape POST /api/classes accepts — the two drifting
 * apart is how the PATCH route came to have no `schedules` key at all, silently
 * discarding every timetable change behind a "Class updated" toast.
 */
// A clock time, not merely two-digits-colon-two-digits: the old shape regex
// admitted "25:00", "47:99" and "99:99" with a 201, and PATCH shares this
// schema (round 4, lane A0). Hour 00–23, minute 00–59. Whether endTime must
// follow startTime is deliberately NOT asserted here: an ordering rule would
// refuse a slot that runs past midnight, and no evidence yet says such slots
// are invalid — the class's own `duration` column is the canonical length.
const clockTime = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(clockTime, "Time must be HH:MM on a 24-hour clock"),
  endTime:   z.string().regex(clockTime, "Time must be HH:MM on a 24-hour clock"),
  startDate: z.string().optional(),
  endDate:   z.string().optional().nullable(),
});

/** One ticked member on a comp-class allow-list. Mirrors the PATCH route's shape. */
export const rosterEntrySchema = z.object({ memberId: z.string().min(1) });

export const classCreateSchema = z.object({
  name: z.string().min(1).max(100),
  // `.nullable()` on every column the form can leave blank. ClassForm sends
  // `null` for a blank text field (`coachName.trim() || null`), the PATCH
  // schema in app/api/classes/[id]/route.ts already accepts null, and each
  // of these columns is `String?`. Without it, creating a class from the
  // timetable with Coach name, Location or Description blank was a 400
  // "Invalid data" from the first commit — only the onboarding wizard, which
  // sends `undefined`, ever created a class here. Noe, 18 Sep 2026.
  description: z.string().max(500).optional().nullable(),
  coachName: z.string().max(100).optional().nullable(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  duration: z.number().int().min(1).max(480),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  // Required, and at least one: a class with no day never appears on the
  // weekly timetable, and Noe's ruling (18 Sep) is that the minimum — name,
  // duration, one day — is enforced, not hinted. The PATCH schema keeps
  // schedules optional: omitted means unchanged, [] is remove-all.
  schedules: z.array(scheduleSchema).min(1).max(50),
  // The comp-class allow-list, ticked on the create form. It had no key here,
  // so Zod stripped it and the create answered 201 having stored nobody —
  // while PATCH has accepted the same array since Task 5. Optional: omitted
  // means "no allow-list", `[]` means the same.
  roster: z.array(rosterEntrySchema).max(500).optional(),
});

export type ClassCreateInput = z.infer<typeof classCreateSchema>;
