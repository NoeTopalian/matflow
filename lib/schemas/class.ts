import { z } from "zod";

/**
 * One recurring slot. Exported so PATCH /api/classes/[id] validates schedule
 * edits against the exact shape POST /api/classes accepts — the two drifting
 * apart is how the PATCH route came to have no `schedules` key at all, silently
 * discarding every timetable change behind a "Class updated" toast.
 */
export const scheduleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime:   z.string().regex(/^\d{2}:\d{2}$/),
  startDate: z.string().optional(),
  endDate:   z.string().optional().nullable(),
});

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
});

export type ClassCreateInput = z.infer<typeof classCreateSchema>;
