/**
 * Booking preservation (D2, approved by Noe on 21 Oct 2026: "Preserve
 * bookings pending an approved migration policy, enforce current eligibility
 * at attendance, and explain affected bookings visibly. Do not silently
 * delete them.").
 *
 * A booking (ClassSubscription) is no longer deleted when a member loses
 * access to a class — not by a squad-list rewrite, a raised rank gate, a
 * narrowed membership list, a single squad removal or a demotion. The doors
 * already refuse at attendance (lib/checkin.ts); this module says, in the
 * doors' own terms, who a class's rules turn away, so that
 *  - the owner sees it before saving (the class form's preview),
 *  - the member sees it on the booked class ("Not eligible: <sentence>"),
 *  - the coach register flags booked-but-ineligible members,
 *  - the change is recorded durably, per trigger, in the same transaction.
 *
 * What a suspension or a released place means is NOT decided here (that is
 * the booking suspension policy, awaiting approval): capacity counting is
 * unchanged, so a kept booking still holds its place.
 *
 * Pure: no I/O. The rules are the DOOR's rules, exactly:
 *  - rank: the member's highest rank order of any discipline against the
 *    class's required / maximum rank order (lib/checkin.ts "Rank gate");
 *    unranked fails a required rank and passes a maximum. Enforced at the
 *    member-decided doors (member app, parent, kiosk) only; staff doors
 *    (register, card scanner, coach tick) admit past it.
 *  - squad list (ClassRoster): a class with a roster admits only members on
 *    it; an empty roster is no roster. Every door.
 *  - membership list (ClassMembershipTier): lib/class-tier-gate.ts
 *    classTierCovers. Every door.
 */
import { classTierCovers } from "@/lib/class-tier-gate";
import { checkinRefusal } from "@/lib/checkin-refusal";

export type ClassAccessRules = {
  /** Members on the squad list. Empty = the class has no squad list. */
  rosterMemberIds: readonly string[];
  /** Memberships that include the class. Empty = every membership. */
  allowedTierIds: readonly string[];
  /** The required rank's order, or null for none (Class.requiredRankId). */
  requiredRankOrder: number | null;
  /** The maximum rank's order, or null for none (Class.maxRankId). */
  maxRankOrder: number | null;
};

export const OPEN_RULES: ClassAccessRules = { rosterMemberIds: [], allowedTierIds: [], requiredRankOrder: null, maxRankOrder: null };

export type AccessFacts = {
  memberId: string;
  membershipTierId: string | null;
  /** The plan's name, for the membership sentence. */
  tierName: string | null;
  /** The highest rank order the member holds in any discipline, null when unranked (the door's read). */
  rankOrder: number | null;
};

export type AccessRefusal = "rank_below" | "rank_above" | "roster_not_listed" | "tier_not_included";

/** The three things a rule change can trigger, as recorded on the audit row. */
export type AccessTrigger = "rank" | "squad" | "membership";

export const TRIGGER_OF: Record<AccessRefusal, AccessTrigger> = {
  rank_below: "rank",
  rank_above: "rank",
  roster_not_listed: "squad",
  tier_not_included: "membership",
};

/** True when the refusal holds only at the member-decided doors; staff doors admit past it. */
export const MEMBER_DOORS_ONLY: Record<AccessRefusal, boolean> = {
  rank_below: true,
  rank_above: true,
  roster_not_listed: false,
  tier_not_included: false,
};

/** The highest rank order among the member's ranks (any discipline), or null — the door's read. */
export function highestRankOrder(ranks: ReadonlyArray<{ order: number }>): number | null {
  if (ranks.length === 0) return null;
  return ranks.reduce((max, r) => (r.order > max ? r.order : max), ranks[0].order);
}

/**
 * Every refusal the rules give this member, in the order the member's own
 * door meets them: rank first (judged before the write transaction), then
 * the squad list, then the membership list (both under the Class lock).
 */
export function accessRefusals(rules: ClassAccessRules, m: AccessFacts): AccessRefusal[] {
  const out: AccessRefusal[] = [];
  if (rules.requiredRankOrder !== null && (m.rankOrder === null || m.rankOrder < rules.requiredRankOrder)) {
    out.push("rank_below");
  }
  if (rules.maxRankOrder !== null && m.rankOrder !== null && m.rankOrder > rules.maxRankOrder) {
    out.push("rank_above");
  }
  if (rules.rosterMemberIds.length > 0 && !rules.rosterMemberIds.includes(m.memberId)) {
    out.push("roster_not_listed");
  }
  if (!classTierCovers({ allowedTierIds: rules.allowedTierIds, memberTierId: m.membershipTierId })) {
    out.push("tier_not_included");
  }
  return out;
}

/** Refusals `after` gives that `before` did not (compared by trigger, so below→above is not "new"). */
export function newRefusals(before: ClassAccessRules, after: ClassAccessRules, m: AccessFacts): AccessRefusal[] {
  const was = new Set(accessRefusals(before, m).map((r) => TRIGGER_OF[r]));
  return accessRefusals(after, m).filter((r) => !was.has(TRIGGER_OF[r]));
}

/** The sentence the member reads at their own door for this refusal (lib/checkin-refusal.ts). */
export function accessRefusalSentence(reason: AccessRefusal, className: string, tierName: string | null): string {
  const result =
    reason === "tier_not_included"
      ? ({ kind: reason, className, tierName } as const)
      : ({ kind: reason } as const);
  return checkinRefusal(result)!.body.error;
}

/** Short labels for the owner's preview and the register. */
export const ACCESS_REFUSAL_LABEL: Record<AccessRefusal, string> = {
  rank_below: "Rank below the class's required rank",
  rank_above: "Rank above the class's maximum rank",
  roster_not_listed: "Not on the squad list",
  tier_not_included: "Membership not included",
};

/** The booked member the owner is told about, and why. */
export type BookedRefusal = {
  memberId: string;
  name: string;
  reasons: AccessRefusal[];
  /** True when this edit is what turns them away (they are admitted under the current rules). */
  newlyRefused: boolean;
  /** True when every reason holds only at the member's own doors (staff can still mark them). */
  staffDoorsAdmit: boolean;
};

export type NotBookedGroupKey = "rank_below" | "rank_above" | "roster_not_listed" | "no_plan" | "plan_not_included";

export const NOT_BOOKED_GROUP_LABEL: Record<NotBookedGroupKey, string> = {
  rank_below: "Rank below the required rank",
  rank_above: "Rank above the maximum rank",
  roster_not_listed: "Not on the squad list",
  no_plan: "No membership plan",
  plan_not_included: "Membership not included",
};

/** A member who is not booked but would be refused, as the preview lists them. */
export type NotBookedMember = {
  memberId: string;
  name: string;
  /** Checked in to this class in the last RECENT_DAYS days (edit only). */
  attendedThisClass: boolean;
  /** Checked in to any class at the club in the last RECENT_DAYS days. */
  recentlyActive: boolean;
};

export type NotBookedGroup = {
  key: NotBookedGroupKey;
  label: string;
  count: number;
  attendedThisClassCount: number;
  recentlyActiveCount: number;
  /** At most NAMES_PER_GROUP, recent attenders of this class first, then recently active, then by name. */
  members: NotBookedMember[];
};

/** The class form's restriction preview: booked members turned away, and everyone else who would be. */
export type RestrictionPreview = {
  /** Always true: no booking is deleted by an access change (D2). */
  bookingsKept: true;
  booked: BookedRefusal[];
  notBooked: NotBookedGroup[];
  /** Members counted in `notBooked` (each once, under the first reason their own door meets). */
  notBookedTotal: number;
};

export const RECENT_DAYS = 56;
export const NAMES_PER_GROUP = 50;

/** Which preview group a not-booked member goes in: the first reason their own door meets. */
export function notBookedGroupOf(reasons: readonly AccessRefusal[], m: AccessFacts): NotBookedGroupKey | null {
  const first = reasons[0];
  if (!first) return null;
  if (first === "tier_not_included") return m.membershipTierId ? "plan_not_included" : "no_plan";
  return first;
}

/**
 * Group the not-booked members a preview lists. Only members the edit NEWLY
 * refuses are passed in (a member already refused by the current rules is not
 * news), each under one group.
 */
export function groupNotBooked(
  rows: ReadonlyArray<{ facts: AccessFacts; name: string; reasons: AccessRefusal[]; attendedThisClass: boolean; recentlyActive: boolean }>,
): { groups: NotBookedGroup[]; total: number } {
  const order: NotBookedGroupKey[] = ["roster_not_listed", "plan_not_included", "no_plan", "rank_below", "rank_above"];
  const byKey = new Map<NotBookedGroupKey, typeof rows[number][]>();
  for (const r of rows) {
    const key = notBookedGroupOf(r.reasons, r.facts);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const groups: NotBookedGroup[] = [];
  let total = 0;
  for (const key of order) {
    const list = byKey.get(key);
    if (!list || list.length === 0) continue;
    total += list.length;
    const sorted = [...list].sort(
      (a, b) =>
        Number(b.attendedThisClass) - Number(a.attendedThisClass) ||
        Number(b.recentlyActive) - Number(a.recentlyActive) ||
        a.name.localeCompare(b.name),
    );
    groups.push({
      key,
      label: NOT_BOOKED_GROUP_LABEL[key],
      count: list.length,
      attendedThisClassCount: list.filter((r) => r.attendedThisClass).length,
      recentlyActiveCount: list.filter((r) => r.recentlyActive).length,
      members: sorted.slice(0, NAMES_PER_GROUP).map((r) => ({
        memberId: r.facts.memberId,
        name: r.name,
        attendedThisClass: r.attendedThisClass,
        recentlyActive: r.recentlyActive,
      })),
    });
  }
  return { groups, total };
}

/** The booked members the rules turn away after the edit, newly or already. */
export function bookedRefusals(
  before: ClassAccessRules,
  after: ClassAccessRules,
  booked: ReadonlyArray<{ facts: AccessFacts; name: string }>,
): BookedRefusal[] {
  const out: BookedRefusal[] = [];
  for (const b of booked) {
    const reasons = accessRefusals(after, b.facts);
    if (reasons.length === 0) continue;
    out.push({
      memberId: b.facts.memberId,
      name: b.name,
      reasons,
      newlyRefused: newRefusals(before, after, b.facts).length > 0,
      staffDoorsAdmit: reasons.every((r) => MEMBER_DOORS_ONLY[r]),
    });
  }
  return out.sort((a, b) => Number(b.newlyRefused) - Number(a.newlyRefused) || a.name.localeCompare(b.name));
}

/** Member ids NEWLY refused, per trigger — what the durable audit rows record. */
export function newlyRefusedByTrigger(
  before: ClassAccessRules,
  after: ClassAccessRules,
  booked: ReadonlyArray<{ facts: AccessFacts }>,
): Record<AccessTrigger, string[]> {
  const out: Record<AccessTrigger, string[]> = { rank: [], squad: [], membership: [] };
  for (const b of booked) {
    const fresh = new Set(newRefusals(before, after, b.facts).map((r) => TRIGGER_OF[r]));
    for (const t of fresh) out[t].push(b.facts.memberId);
  }
  for (const t of Object.keys(out) as AccessTrigger[]) out[t].sort();
  return out;
}

/**
 * The rules a class PATCH leaves, from the rules before it and the edit, with
 * the route's own precedence (app/api/classes/[id]/route.ts):
 *  - a roster in the body replaces the squad list and clears both rank gates;
 *  - otherwise naming a rank (a truthy id) clears the squad list;
 *  - a rank field that is undefined is unchanged, null clears it;
 *  - a membership list in the body replaces the list.
 * Rank fields arrive as ORDERS here: the caller resolved the ids.
 */
export function rulesAfterEdit(
  before: ClassAccessRules,
  edit: {
    roster?: readonly string[];
    /** True when the body names a required or maximum rank (wantsRankGate). */
    namesRank: boolean;
    requiredRankOrder?: number | null;
    maxRankOrder?: number | null;
    allowedTierIds?: readonly string[];
  },
): ClassAccessRules {
  const allowedTierIds = edit.allowedTierIds ? [...edit.allowedTierIds].sort() : before.allowedTierIds;
  if (edit.roster) {
    return { rosterMemberIds: [...edit.roster].sort(), allowedTierIds, requiredRankOrder: null, maxRankOrder: null };
  }
  return {
    rosterMemberIds: edit.namesRank ? [] : before.rosterMemberIds,
    allowedTierIds,
    requiredRankOrder: edit.requiredRankOrder === undefined ? before.requiredRankOrder : edit.requiredRankOrder,
    maxRankOrder: edit.maxRankOrder === undefined ? before.maxRankOrder : edit.maxRankOrder,
  };
}

/**
 * Whether a member is excluded from the "would be refused" population: a
 * guardian / payer account (accountType "parent", or a TeamUp payer record),
 * or a member who is not training (inactive, cancelled).
 */
export function outsidePreviewPopulation(m: { accountType: string | null; status: string | null; externalRef?: string | null }): boolean {
  if (m.accountType === "parent") return true;
  if (m.externalRef?.startsWith("teamup-payer:")) return true;
  return m.status === "inactive" || m.status === "cancelled";
}
