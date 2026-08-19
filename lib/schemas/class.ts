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
  description: z.string().max(500).optional(),
  coachName: z.string().max(100).optional(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional(),
  duration: z.number().int().min(1).max(480),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional(),
  schedules: z.array(scheduleSchema).optional(),
});

export type ClassCreateInput = z.infer<typeof classCreateSchema>;
