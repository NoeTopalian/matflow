/**
 * Who may attend a class: its membership list (T6a, Sean note 1) and its
 * squad list / roster (T6d).
 *
 * Owner decisions, 20 Oct 2026 (supersede "roster decides" and the staff ask
 * of 17 Oct):
 *  - A class with NO tiers selected and NO roster is open to everyone, exactly
 *    as before either table existed.
 *  - A class with tiers selected admits only members whose `membershipTierId`
 *    is in the list. A member with no tier is not covered.
 *  - A class with a roster admits only members on it.
 *  - A class with both admits only a member who satisfies BOTH: on the roster
 *    AND on one of the ticked memberships.
 *  - No door overrides either gate: the member app, a parent for a child, the
 *    kiosk, booking, the desk register, the card scanner and the coach tick
 *    all refuse, with the sentence the member reads. Staff who want someone
 *    in change the membership (PATCH /api/members/[id]) or the squad list
 *    (/api/classes/[id]/roster), both audited.
 *
 * Pure: no I/O, safe in client components. The engine (lib/checkin.ts), the
 * booking routes, the member schedule and the staff register all decide
 * through `classTierCovers`, so no surface can disagree with another. The
 * roster half is a membership test on ClassRoster, run beside it.
 */

export type ClassTierGateInput = {
  /** Tier ids attached to the class (ClassMembershipTier). Empty = open. */
  allowedTierIds: readonly string[];
  /** The member's own Member.membershipTierId. */
  memberTierId: string | null | undefined;
};

/**
 * True when the class's membership list lets this member in. Says nothing
 * about the roster: a rostered class with a list is judged on both.
 */
export function classTierCovers(input: ClassTierGateInput): boolean {
  if (input.allowedTierIds.length === 0) return true;
  if (!input.memberTierId) return false;
  return input.allowedTierIds.includes(input.memberTierId);
}

/**
 * The sentence a member reads when their plan does not include a class. It
 * names the class and the plan, so the member knows what to ask about. The
 * desk register and the card scanner show the same sentence.
 */
export function tierRefusalSentence(className: string, tierName: string | null | undefined): string {
  return tierName
    ? `${className} isn't included in your ${tierName} membership. For further information, please speak to a coach.`
    : `${className} is only open to certain memberships, and you don't have a membership plan set yet. For further information, please speak to a coach.`;
}

/**
 * The sentence every door gives a member who is not on a squad class's
 * roster (check-in, kiosk, booking, and the staff doors, which refuse too).
 */
export const ROSTER_REFUSAL_SENTENCE = "You're not on the roster for this class. For further information, please speak to a coach.";

/** The short label the member schedule shows on a class their plan does not include. */
export const TIER_LOCKED_LABEL = "Not included in your membership";

/**
 * T6a: whether Home's sign-in sheet treats a class as locked. `eligibility`
 * is the member's own (buildMemberSchedule). A parent signing a child in is
 * judged on the child's plan at the door, so the parent's own lock does not
 * apply to that sign-in.
 */
export function isTierLockedForSelf(
  cls: { eligibility?: string | null },
  signingInAs: string | null,
): boolean {
  return signingInAs === null && cls.eligibility === "tier_not_included";
}

/**
 * T6d: the badge a squad / comp class (one with a roster) carries on the
 * kiosk class list, the staff session picker and the register.
 */
export const SQUAD_ONLY_LABEL = "Squad only";

/** T6d: the register chip on a member who is not on a squad class's roster. */
export const NOT_ON_SQUAD_LABEL = "Not on the squad list";

/**
 * T6d: what the kiosk says when a name search at a squad class finds no one
 * on the roster. The search lists only rostered members, so a member who is
 * not on it reads this rather than seeing their name and being refused.
 */
export const SQUAD_NO_MATCH_SENTENCE =
  "No one on the squad list matches that name. Only members on the squad list can check in to this class. For further information, please speak to a coach.";
