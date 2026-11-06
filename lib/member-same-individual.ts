/**
 * "The same individual" (Noe, 6 Nov 2026, PR 3): when staff add a member whose
 * address and full name match an ARCHIVED member of the same club, MatFlow
 * restores that record (with all its history) instead of creating a second
 * one. Families share addresses, so the address alone is never enough.
 *
 * CERTAIN ("same"): ALL of
 *   - the same email, case-insensitive and trimmed;
 *   - the same full name, case-insensitive, trimmed, inner whitespace
 *     collapsed (the `norm` rule the TeamUp attendance import binds by,
 *     lib/importers/attendance.ts);
 *   - BOTH records carry a date of birth, and it is the same calendar date
 *     (UTC day).
 * Only then is the record restored without asking (security review L1: a
 * father and son "John Smith" on one family address must never merge).
 *
 * POSSIBLE ("possible"): email and name match but either date of birth is
 * missing. Staff are asked whether it is the same person.
 *
 * Anything else ("different"): another person, including a date-of-birth
 * conflict.
 *
 * Pure: no database, so the rule is unit-tested on its own.
 */
export type IdentityFacts = { email: string; name: string; dateOfBirth?: Date | string | null };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function dayOf(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

export type IdentityMatch = "same" | "possible" | "different";

export function classifyIdentity(a: IdentityFacts, b: IdentityFacts): IdentityMatch {
  if (!a.email.trim() || !b.email.trim()) return "different";
  if (a.email.trim().toLowerCase() !== b.email.trim().toLowerCase()) return "different";
  if (norm(a.name) !== norm(b.name) || !norm(a.name)) return "different";
  const da = dayOf(a.dateOfBirth);
  const db = dayOf(b.dateOfBirth);
  if (da && db) return da === db ? "same" : "different";
  return "possible";
}

/** Certain: restore without asking. */
export function isSameIndividual(a: IdentityFacts, b: IdentityFacts): boolean {
  return classifyIdentity(a, b) === "same";
}
