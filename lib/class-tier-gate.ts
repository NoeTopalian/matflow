/**
 * T6a (Sean note 1): which memberships include a class.
 *
 * Owner decisions, 17 Oct 2026 (Q1 / Q3):
 *  - A class with NO tiers selected is open to everyone, exactly as before the
 *    ClassMembershipTier table existed. Nothing changes until a club
 *    configures a class.
 *  - A class with tiers selected admits members whose `membershipTierId` is in
 *    the list. A member with no tier is treated as not covered.
 *  - A class that has a roster (a comp / squad class) is governed by its
 *    roster: a rostered member is admitted regardless of tier, and a member
 *    who is not on it is refused by the roster gate as today. The tier list is
 *    not consulted for such a class.
 *  - The member app, booking and the kiosk refuse; the desk register and the
 *    card scanner ask, and an admission is recorded as an override.
 *
 * Pure: no I/O, safe in client components. The engine (lib/checkin.ts), the
 * booking routes, the member schedule and the staff register all decide
 * through `classTierCovers`, so no surface can disagree with another.
 */

export type ClassTierGateInput = {
  /** Tier ids attached to the class (ClassMembershipTier). Empty = open. */
  allowedTierIds: readonly string[];
  /** The member's own Member.membershipTierId. */
  memberTierId: string | null | undefined;
  /** The class has at least one ClassRoster row. */
  hasRoster: boolean;
};

/** True when the class's membership list lets this member in. */
export function classTierCovers(input: ClassTierGateInput): boolean {
  if (input.allowedTierIds.length === 0) return true;
  if (input.hasRoster) return true;
  if (!input.memberTierId) return false;
  return input.allowedTierIds.includes(input.memberTierId);
}

/**
 * How a door treats a class the member's plan does not include:
 *  - "refuse": member-decided doors (member app, parent, kiosk, booking).
 *  - "ask": staff doors (register, card scanner). Refused with an askable
 *    answer unless the caller says staff confirmed, in which case admitted and
 *    the override is reported back so the route can record it.
 *  - "off": not checked (system / cron, tests).
 */
export type TierGateMode = "refuse" | "ask" | "off";

/** The override reason recorded when staff admit someone anyway. */
export const TIER_OVERRIDE_REASON = "tier_not_included" as const;

/**
 * The sentence a member reads when their plan does not include a class. It
 * names the class and the plan, so the member knows what to ask about.
 */
export function tierRefusalSentence(className: string, tierName: string | null | undefined): string {
  return tierName
    ? `${className} isn't included in your ${tierName} membership. Ask staff about a membership that includes it.`
    : `${className} is only open to certain memberships, and you don't have a membership plan set yet. Ask staff.`;
}

/** The question the desk register and the card scanner put to staff. */
export function tierAskSentence(memberName: string, className: string, tierName: string | null | undefined): string {
  return tierName
    ? `${className} isn't included in ${memberName}'s ${tierName} membership. Admit anyway?`
    : `${className} is only open to certain memberships, and ${memberName} has no membership plan set. Admit anyway?`;
}

/** The short label the member schedule shows on a class their plan does not include. */
export const TIER_LOCKED_LABEL = "Not included in your membership";

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
  "No one on the squad list matches that name. Only members on the squad list can check in to this class — ask staff.";
