import { z } from "zod";
import { notesField } from "@/lib/schemas/notes-sanitiser";

// Shared between server (api/members) and client (admin member forms).
// Keep in sync with prisma/schema.prisma model Member.

export const memberCreateSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  membershipType: z.string().max(60).optional(),
  dateOfBirth: z.string().optional().nullable(),
  accountType: z.enum(["adult", "junior", "kids", "parent"]).optional(),
  parentMemberId: z.string().min(1).max(50).optional(),
});

export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

export const memberUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional().nullable(),
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(30).optional().nullable(),
  emergencyContactRelation: z.string().max(60).optional().nullable(),
  membershipType: z.string().max(60).optional().nullable(),
  status: z.enum(["active", "inactive", "cancelled", "taster"]).optional(),
  // Audit iter-1-member-lifecycle A3H-3: staff need a way to override the
  // billing state when the Stripe webhook can't. Common case: cash payment
  // accepted at the front desk after the subscription was cancelled — the
  // owner sets paymentStatus = "paid" to re-enable check-in. CHECK
  // constraint at the DB level enforces the same values (migration
  // 20260430000001_schema_check_constraints).
  paymentStatus: z.enum(["paid", "overdue", "paused", "free", "pending", "cancelled"]).optional(),
  // feat/member-tickable-notes Phase 1b: shared sanitiser strips control +
  // zero-width + bidi-override characters BEFORE the max() check so a hostile
  // string can't smuggle past the 2000-char limit by padding with controls.
  // Whitespace-only or empty-after-strip → null.
  notes: notesField(2000),
  dateOfBirth: z.string().optional().nullable(),
  // Optimistic-concurrency precondition (US-508): client sends the updatedAt
  // it last saw; server returns 409 if the row has changed since.
  updatedAt: z.string().optional(),
});

export type MemberUpdateInput = z.infer<typeof memberUpdateSchema>;
