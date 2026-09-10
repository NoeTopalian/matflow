import { z } from "zod";

export const announcementCreateSchema = z.object({
  title:    z.string().min(1).max(120),
  body:     z.string().min(1).max(2000),
  imageUrl: z.string().url().optional().nullable(),
  pinned:   z.boolean().optional(),
  // Temporary announcements (Noe, 2026-08-21): how many days the notice stays
  // visible to members. null/absent = permanent. The server computes the
  // actual expiresAt — the client never sends a timestamp, so clock skew on a
  // phone can't produce an already-expired notice. 1..365: a year is the
  // longest "temporary" that still means anything.
  durationDays: z.number().int().min(1).max(365).optional().nullable(),
});

export type AnnouncementCreateInput = z.infer<typeof announcementCreateSchema>;
