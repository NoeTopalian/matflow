/**
 * Dashboard "Today" action items — turns raw per-member signals into a
 * prioritised list of SPECIFIC, NAMED, actionable rows (e.g. "Jane Smith —
 * £40 payment failed 3 days ago"), instead of the bare counts the dashboard
 * showed before. Pure + deterministic so it can be unit-tested; the Prisma
 * queries live in app/dashboard/page.tsx and feed this builder.
 */

import { TRAINING_MEMBER } from "@/lib/member-population";

export type ActionItemKind = "money" | "retention" | "admin" | "moment";

export type ActionItem = {
  id: string;
  kind: ActionItemKind;
  memberId: string;
  memberName: string;
  detail: string;
  href: string;
  emoji?: string;
};

export type ActionItemsInput = {
  now: Date;
  /**
   * Active/taster members who owe: overdue, or "No payment yet" on a plan
   * (lib/overdue owesMoneyClause — the Outstanding list's definition).
   */
  overdue: { id: string; name: string; noPaymentYet?: boolean }[];
  /** Failed Payment rows in the recent window (most-recent first), with the member. */
  recentFailed: { memberId: string | null; memberName: string | null; amountPence: number; createdAt: Date }[];
  /** Active/taster members with no signed waiver. */
  missingWaiver: { id: string; name: string }[];
  /** Active members not seen in 14+ days — never someone who joined inside the window and has not trained yet (see atRiskMemberWhere). */
  atRisk: { id: string; name: string }[];
  /**
   * True while the club has no MatFlow check-in (see atRiskSuppressed). The
   * at-risk rows are then dropped, whatever `atRisk` holds, so the named list
   * and the headline tile are switched off by the same signal.
   */
  atRiskSuppressed?: boolean;
  /** Active/taster members with a dateOfBirth (filtered to the next 7 days here). */
  birthdayCandidates: { id: string; name: string; dateOfBirth: Date }[];
};

/** Days without a check-in before an active member counts as "not seen". */
export const AT_RISK_DAYS = 14;

/**
 * The Prisma `where` for "active member not seen in {AT_RISK_DAYS}+ days" —
 * shared by the dashboard's headline count and its named action list so the
 * two cannot disagree. A member who has never attended and joined inside the
 * window is NEW, not lapsed: the end-user simulation (30 Sep 2026) saw eight
 * members who joined that morning listed as "Not seen in 14+ days".
 *
 * NOT yet the same rule as the Members "Quiet" chip (`isQuiet` in
 * components/dashboard/MembersList.tsx), which also requires `paid` and is
 * never suppressed; aligning the two is T2a Part F. Until then the chip shows
 * its own count.
 */
export function atRiskMemberWhere(tenantId: string, now: Date) {
  const since = new Date(now);
  since.setDate(now.getDate() - AT_RISK_DAYS);
  return {
    tenantId,
    status: "active",
    // Training members only: the TeamUp import made 219 no-login guardian
    // drafts (active, never attend), and every one of them would otherwise be
    // "not seen in 14 days" (T2a Part U, 17 Oct 2026; lib/member-population.ts).
    ...TRAINING_MEMBER,
    attendances: { none: { checkInTime: { gte: since } } },
    OR: [{ joinedAt: { lt: since } }, { attendances: { some: {} } }],
  };
}

/**
 * An attendance row made IN MatFlow — a register tick, kiosk, QR or self
 * check-in — as opposed to history brought in by an import. The same marker
 * the undo path uses to refuse removing imported rows (lib/undo-registry.ts,
 * attendance undo): `checkInMethod <> 'import' AND importJobId IS NULL`.
 */
export const MATFLOW_CHECKIN_WHERE = {
  checkInMethod: { not: "import" },
  importJobId: null,
} as const;

/** What the At-Risk tile says in place of a number while it is suppressed. */
export const AT_RISK_SUPPRESSED_NOTE = "Starts once you take your first register in MatFlow";
export const AT_RISK_SUPPRESSED_DETAIL = "Imported visits are not counted";

/** The slice of a Prisma (transaction) client the at-risk gate reads. */
export type AtRiskGateClient = {
  attendanceRecord: {
    findFirst(args: {
      where: { tenantId: string; checkInMethod: { not: "import" }; importJobId: null };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

/**
 * THE one rule for whether the dashboard shows At-Risk at all (T2a Part U,
 * owner decision Q4 A-3 option (c), 17 Oct 2026): suppressed while the club
 * has no MatFlow check-in. Every visit on record for a club fresh off TeamUp
 * is imported and dated before the switch, so from 14 days after the import
 * the unsuppressed tile flags the whole club (312, then 531 on 17 Oct).
 * Imported attendance does not count. The headline tile, the to-do row and
 * the named action list all read this one answer.
 */
export async function atRiskSuppressed(tx: AtRiskGateClient, tenantId: string): Promise<boolean> {
  const first = await tx.attendanceRecord.findFirst({
    where: { tenantId, ...MATFLOW_CHECKIN_WHERE },
    select: { id: true },
  });
  return first === null;
}

const SEVERITY: Record<ActionItemKind, number> = { money: 0, retention: 1, admin: 2, moment: 3 };
const MAX_ITEMS = 15;

function poundsFromPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

function daysBetween(now: Date, then: Date): number {
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

function agoLabel(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Days until a member's next birthday (month/day), 0 = today. Year-agnostic.
 */
export function daysUntilBirthday(now: Date, dob: Date): number {
  const m = dob.getMonth();
  const d = dob.getDate();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), m, d);
  if (next < todayMidnight) next = new Date(now.getFullYear() + 1, m, d);
  return Math.round((next.getTime() - todayMidnight.getTime()) / 86_400_000);
}

function turningAge(now: Date, dob: Date, daysUntil: number): number {
  const birthdayYear = daysUntil >= 0 && new Date(now.getFullYear(), dob.getMonth(), dob.getDate()) >= new Date(now.getFullYear(), now.getMonth(), now.getDate())
    ? now.getFullYear()
    : now.getFullYear() + 1;
  return birthdayYear - dob.getFullYear();
}

export function buildActionItems(input: ActionItemsInput): ActionItem[] {
  const { now } = input;
  const items: ActionItem[] = [];
  const moneyMemberIds = new Set<string>();

  // ── Money: failed payments (with amount + when) take priority over a bare
  //    "overdue" flag. Dedup so a member appears once.
  for (const f of input.recentFailed) {
    if (!f.memberId || !f.memberName) continue;
    if (moneyMemberIds.has(f.memberId)) continue;
    moneyMemberIds.add(f.memberId);
    items.push({
      id: `money-failed-${f.memberId}`,
      kind: "money",
      memberId: f.memberId,
      memberName: f.memberName,
      detail: `${poundsFromPence(f.amountPence)} payment failed ${agoLabel(daysBetween(now, f.createdAt))}`,
      href: `/dashboard/members/${f.memberId}?tab=payments`,
      emoji: "💳",
    });
  }
  for (const m of input.overdue) {
    if (moneyMemberIds.has(m.id)) continue;
    moneyMemberIds.add(m.id);
    items.push({
      id: `money-overdue-${m.id}`,
      kind: "money",
      memberId: m.id,
      memberName: m.name,
      detail: m.noPaymentYet ? "No payment yet" : "Payment overdue",
      href: `/dashboard/members/${m.id}?tab=payments`,
      emoji: "💳",
    });
  }

  // ── Retention (switched off with the tile: see atRiskSuppressed)
  for (const m of input.atRiskSuppressed ? [] : input.atRisk) {
    items.push({
      id: `retention-${m.id}`,
      kind: "retention",
      memberId: m.id,
      memberName: m.name,
      detail: "Not seen in 14+ days",
      href: `/dashboard/members/${m.id}`,
      emoji: "👋",
    });
  }

  // ── Admin / compliance
  for (const m of input.missingWaiver) {
    items.push({
      id: `admin-waiver-${m.id}`,
      kind: "admin",
      memberId: m.id,
      memberName: m.name,
      detail: "Waiver not signed",
      href: `/dashboard/members/${m.id}`,
      emoji: "📋",
    });
  }

  // ── Member moments: birthdays in the next 7 days.
  for (const m of input.birthdayCandidates) {
    const until = daysUntilBirthday(now, m.dateOfBirth);
    if (until > 7) continue;
    const age = turningAge(now, m.dateOfBirth, until);
    const when = until === 0 ? "Birthday today" : until === 1 ? "Birthday tomorrow" : `Birthday in ${until} days`;
    items.push({
      id: `moment-bday-${m.id}`,
      kind: "moment",
      memberId: m.id,
      memberName: m.name,
      detail: `${when} — turning ${age}`,
      href: `/dashboard/members/${m.id}`,
      emoji: "🎂",
    });
  }

  // Money first, then retention, admin, moments; stable within a kind.
  items.sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind]);
  return items.slice(0, MAX_ITEMS);
}
