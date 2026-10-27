/**
 * G4 (owner, 27 Oct 2026): a coach's one-off. "If they want to do another
 * class, they'd have to discuss with a coach, for example, and maybe that
 * coach will include them on a one-off session."
 *
 * A staff user admits a named member to ONE session from its register, with a
 * reason. It admits them past the squad list, the plan restriction and the
 * class allowance for that session only, is not counted against the
 * allowance and spends no class-pack credit. The hold, waiver and kids-class
 * questions still apply. Recorded in ClassOneOff (who, why, when), the audit
 * log (`attendance.one_off`) and the member's history.
 *
 * Pure, no imports: the register (a client component), the route and the
 * engine share these.
 */

/** The reason, trimmed: 3 to 200 characters (database CHECK ClassOneOff_reason_length). */
export const ONE_OFF_REASON_MIN = 3;
export const ONE_OFF_REASON_MAX = 200;

/** The trimmed reason when it is a valid one-off reason, else null. */
export function oneOffReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= ONE_OFF_REASON_MIN && t.length <= ONE_OFF_REASON_MAX ? t : null;
}

/** The 400 a one-off with a missing, short or long reason answers. */
export const ONE_OFF_REASON_ERROR = `Give a reason for the one-off (${ONE_OFF_REASON_MIN} to ${ONE_OFF_REASON_MAX} characters).`;

/** The 400 a one-off on anything but a staff register mark answers. */
export const ONE_OFF_METHOD_ERROR = "A one-off is added by staff from a session's register.";

/** The refusals a one-off can admit past: the squad list, the plan restriction, the class allowance. */
export const ONE_OFF_REASONS = ["allowance_reached", "tier_not_included", "roster_not_listed"] as const;

export function oneOffCanAdmit(reason: string | null | undefined): boolean {
  return !!reason && (ONE_OFF_REASONS as readonly string[]).includes(reason);
}

/** The register row: "One-off · <reason>". */
export function oneOffRowLabel(reason: string): string {
  return `One-off · ${reason}`;
}

/** The member's history: "One-off — added by <staff name>: <reason>". */
export function oneOffHistoryLine(grantedByName: string | null, reason: string): string {
  return `One-off — added by ${grantedByName?.trim() || "a staff member"}: ${reason}`;
}
