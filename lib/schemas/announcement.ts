import { z } from "zod";

export const announcementCreateSchema = z.object({
  title:    z.string().min(1).max(120),
  body:     z.string().min(1).max(2000),
  imageUrl: z.string().url().optional().nullable(),
  pinned:   z.boolean().optional(),
});

export type AnnouncementCreateInput = z.infer<typeof announcementCreateSchema>;
