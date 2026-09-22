// Attribution (M1) — capture-side helper for the polymorphic sign-up credit.
//
// The member forms let staff credit a sign-up to ONE of three mutually
// exclusive targets: a staff member (creditedToUserId), another member who
// "brought a friend" (creditedToMemberId), or a free-text source such as
// "Instagram ad" (creditedToLabel). The DB enforces the XOR with a CHECK and
// lib/schemas/member.ts mirrors it with a `.refine`; this resolver is what the
// form uses so the body it POSTs can only ever carry one of the three.
//
// Keeping the "pick exactly one, null the rest" rule in a pure function — not
// spread across the form's onChange handlers — is what makes the mutual
// exclusion testable and impossible to half-revert: a naive
// `{ ...state }` payload that leaks a stale id past a type switch fails the
// unit test rather than reaching Postgres and 500-ing on the CHECK.

export type SignupCreditType = "none" | "staff" | "member" | "other";

export interface SignupCreditInput {
  creditType: SignupCreditType;
  creditedToUserId?: string | null;
  creditedToMemberId?: string | null;
  creditedToLabel?: string | null;
}

export interface SignupCreditResult {
  creditedToUserId: string | null;
  creditedToMemberId: string | null;
  creditedToLabel: string | null;
}

function emptyToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Collapse the form's credit state to the exactly-one-or-none shape the API
 * accepts. The active `creditType` is the ONLY source of truth: values for the
 * inactive types are discarded, so switching Staff → Other can never smuggle a
 * stale `creditedToUserId` alongside the new label.
 */
export function resolveSignupCredit(input: SignupCreditInput): SignupCreditResult {
  switch (input.creditType) {
    case "staff":
      return {
        creditedToUserId: emptyToNull(input.creditedToUserId),
        creditedToMemberId: null,
        creditedToLabel: null,
      };
    case "member":
      return {
        creditedToUserId: null,
        creditedToMemberId: emptyToNull(input.creditedToMemberId),
        creditedToLabel: null,
      };
    case "other":
      return {
        creditedToUserId: null,
        creditedToMemberId: null,
        creditedToLabel: emptyToNull(input.creditedToLabel),
      };
    case "none":
    default:
      return { creditedToUserId: null, creditedToMemberId: null, creditedToLabel: null };
  }
}

/**
 * Derive which credit type an existing member's stored values represent, so the
 * edit form opens on the right control. The DB guarantees at most one is set;
 * the priority order here only matters for a corrupt row and picks the staff
 * target first, matching the CHECK's own precedence.
 */
export function initialCreditType(v: {
  creditedToUserId?: string | null;
  creditedToMemberId?: string | null;
  creditedToLabel?: string | null;
}): SignupCreditType {
  if (v.creditedToUserId) return "staff";
  if (v.creditedToMemberId) return "member";
  if (v.creditedToLabel) return "other";
  return "none";
}
