/**
 * "The same individual" (Noe, 6 Nov 2026, PR 3): when staff add a member whose
 * address and full name match an ARCHIVED member of the same club, MatFlow
 * restores that record (with all its history) instead of creating a second
 * one. Families share addresses, so the address alone is never enough.
 *
 * Same individual means ALL of:
 *   - the same email, case-insensitive and trimmed;
 *   - the same full name, case-insensitive, trimmed, inner whitespace
 *     collapsed (the `norm` rule the TeamUp attendance import binds by,
 *     lib/importers/attendance.ts);
 *   - when BOTH records carry a date of birth, the same calendar date (UTC
 *     day). One missing date of birth is not a conflict.
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

export function isSameIndividual(a: IdentityFacts, b: IdentityFacts): boolean {
  if (!a.email.trim() || !b.email.trim()) return false;
  if (a.email.trim().toLowerCase() !== b.email.trim().toLowerCase()) return false;
  if (norm(a.name) !== norm(b.name) || !norm(a.name)) return false;
  const da = dayOf(a.dateOfBirth);
  const db = dayOf(b.dateOfBirth);
  return !(da && db && da !== db);
}
