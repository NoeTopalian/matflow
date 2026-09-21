import { z } from "zod";
import { emailField } from "@/lib/email-normalise";
import { notesField } from "@/lib/schemas/notes-sanitiser";

// Attribution (M1). The polymorphic sign-up credit is DB-enforced XOR: EXACTLY
// ONE of creditedToUserId (a staff member) or creditedToMemberId (another
// member — "brought a friend") may be set. Mirroring the CHECK here means the
// API 400s before the DB constraint fires, with a field-level message the form
// can show, instead of a raw 500 from Postgres.
const rejectBothCreditTargets = (data: {
  creditedToUserId?: string | null;
  creditedToMemberId?: string | null;
}) => !(data.creditedToUserId && data.creditedToMemberId);
const bothCreditTargetsIssue = {
  message: "Credit a sign-up to a staff member OR another member, not both.",
  path: ["creditedToUserId"],
};

// Shared between server (api/members) and client (admin member forms).
// Keep in sync with prisma/schema.prisma model Member.

function normalizePhone(input: string): string {
  const stripped = input.replace(/[\s\-().]/g, "");
  if (stripped.startsWith("07")) return "+447" + stripped.slice(2);
  if (stripped.startsWith("01")) return "+441" + stripped.slice(2);
  if (stripped.startsWith("02")) return "+442" + stripped.slice(2);
  if (stripped.startsWith("+44")) return stripped;
  if (stripped.startsWith("044")) return "+44" + stripped.slice(3);
  return stripped;
}

const phoneField = z.preprocess(
  (val) => {
    if (val === null || val === undefined || val === "") return val;
    if (typeof val !== "string") return val;
    return normalizePhone(val);
  },
  z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, {
      message: "Must be a valid phone number (E.164 or UK format like 07700 900123)",
    })
    .optional()
    .nullable(),
);

export const memberCreateSchema = z.object({
  name: z.string().min(1).max(100),
  // Stored lowercase. Recovery — magic link, forgot password, reset — already
  // looks the address up lowercased, so a member created as "Noe@example.com"
  // could log in and then never recover the account, in silence, because both
  // recovery routes answer a deliberate 200 to avoid enumerating addresses.
  email: emailField().optional(),
  phone: phoneField,
  membershipType: z.string().max(60).optional(),
  // C1: the tenant's own MembershipTier. Additive — `membershipType` above is
  // the legacy free-text label revenue reporting still string-matches on, and
  // the server writes it FROM the resolved tier so the two cannot drift. The
  // id is never trusted on its own: the route resolves it inside the tenant
  // before either column is written.
  membershipTierId: z.string().min(1).max(50).optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  accountType: z.enum(["adult", "junior", "kids", "parent"]).optional(),
  parentMemberId: z.string().min(1).max(50).optional(),
  // Attribution (M1). All additive + nullable. `status` lets staff create a
  // member straight into "taster" — the funnel's start event — instead of the
  // schema always defaulting adults to active.
  status: z.enum(["active", "inactive", "cancelled", "taster"]).optional(),
  trialRunById: z.string().min(1).max(50).optional().nullable(),
  creditedToUserId: z.string().min(1).max(50).optional().nullable(),
  creditedToMemberId: z.string().min(1).max(50).optional().nullable(),
  creditedToLabel: z.string().max(120).optional().nullable(),
}).refine(rejectBothCreditTargets, bothCreditTargetsIssue);

export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

export const memberUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: emailField().optional(),
  phone: phoneField,
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(30).optional().nullable(),
  emergencyContactRelation: z.string().max(60).optional().nullable(),
  membershipType: z.string().max(60).optional().nullable(),
  // C1: see memberCreateSchema. Sending `null` detaches the member from the
  // tier without touching the legacy label; sending an id re-derives the
  // label from the tier row server-side.
  membershipTierId: z.string().min(1).max(50).optional().nullable(),
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
  // Attribution (M1). Editable by staff; the XOR refine below rejects setting
  // both credit targets, mirroring the DB CHECK.
  trialRunById: z.string().min(1).max(50).optional().nullable(),
  creditedToUserId: z.string().min(1).max(50).optional().nullable(),
  creditedToMemberId: z.string().min(1).max(50).optional().nullable(),
  creditedToLabel: z.string().max(120).optional().nullable(),
}).refine(rejectBothCreditTargets, bothCreditTargetsIssue);

export type MemberUpdateInput = z.infer<typeof memberUpdateSchema>;

// Member SELF-SERVICE profile edit (PATCH /api/member/me) — the identity
// fields the member may change about themselves from the profile card's edit
// mode. Deliberately narrower than the staff schema: no status/payment/notes.
// Email is normalised lowercase; phone reuses the shared UK/E.164 field.
export const memberSelfUpdateSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(120).optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address")
    .max(254)
    .optional(),
  phone: phoneField,
});

export type MemberSelfUpdateInput = z.infer<typeof memberSelfUpdateSchema>;
