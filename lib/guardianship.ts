/**
 * Guardianship (2 Oct 2026): a parent link on a Member is either CONFIRMED
 * (made by staff or by the member themselves, or confirmed by the owner) or
 * merely SUGGESTED (made by an import from a shared email or an emergency
 * contact). Only a confirmed link lets the parent portal act for — or even
 * see — the child. Every parent-acts-for-child query spreads
 * `CONFIRMED_GUARDIAN` into its `where`; every link staff or the member
 * create spreads `CONFIRMED_BY(...)` into its `data`.
 */
export const CONFIRMED_GUARDIAN = { guardianConfirmedAt: { not: null } } as const;

export type GuardianSource = "staff" | "member" | "shared_email" | "emergency_contact";

/** Link columns for a link made by a person who may make it. */
export function CONFIRMED_BY(source: "staff" | "member", at: Date = new Date()) {
  return { guardianConfirmedAt: at, guardianSuggestedBy: source } as const;
}

/** True when a link is confirmed (null = suggested only). */
export function isConfirmedGuardian(m: { parentMemberId: string | null; guardianConfirmedAt: Date | null }): boolean {
  return m.parentMemberId !== null && m.guardianConfirmedAt !== null;
}

/**
 * Where a SUGGESTED link came from, in a few words, for the review queue.
 * The import is the only writer of an unconfirmed link and always records
 * shared_email or emergency_contact. Any other value means the link was put
 * back unconfirmed by an Activity-log undo (lib/undo-registry.ts), which can
 * carry "staff" or nothing — so that case says the source is not recorded
 * rather than guessing.
 */
export function guardianSuggestionSource(suggestedBy: string | null | undefined): string {
  if (suggestedBy === "shared_email") return "Shared email address";
  if (suggestedBy === "emergency_contact") return "Emergency contact";
  return "Source not recorded";
}

/** One sentence for staff screens. */
export function guardianStatusLabel(m: { parentMemberId: string | null; guardianConfirmedAt: Date | null; guardianSuggestedBy: string | null }): string | null {
  if (!m.parentMemberId) return null;
  if (m.guardianConfirmedAt) return null;
  return m.guardianSuggestedBy === "emergency_contact"
    ? "Suggested guardian — from the emergency contact in the import. Not confirmed: no parent access until you confirm."
    : "Suggested guardian — from a shared email address in the import. Not confirmed: no parent access until you confirm.";
}
