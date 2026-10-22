/**
 * Every total the Members page shows, defined twice on purpose — once as a
 * Prisma where for the SERVER, once as a predicate over loaded rows for the
 * BROWSER — and kept in one file so the two cannot drift (review L5,
 * 23 Oct 2026).
 *
 * Why the server side exists: the page loads at most 1,500 rows
 * (MEMBERS_SSR_TAKE). The headline, the tiles and the chip counts used to be
 * derived from that truncated array, so a club with 1,600 members was told it
 * had fewer active members than Reports said. Now the server counts the FULL
 * population with these wheres (lib/member-list-counts-server.ts) and the page
 * shows those numbers; the truncation notice describes only the table.
 *
 * Every where is built from the shared population fragments
 * (lib/member-population.ts) and the shared money rules (lib/overdue.ts), the
 * same ones Reports uses, so the Members page and Reports count one
 * population one way. Each carries `tenantId` explicitly.
 *
 * Runtime imports are pure (no Prisma client, no tenant context) so the
 * client list can import the predicates and the row counter.
 */
import type { Prisma } from "@prisma/client";
import { notOverdueWhere, overdueClause } from "@/lib/overdue";
import { inMonthWindow, monthRange, type ClubMonthWindow } from "@/lib/club-month";
import {
  ACTIVE_MEMBER,
  CAN_TRAIN_MEMBER,
  CURRENT_MEMBER,
  GUARDIAN_ACCOUNT,
  LEFT_MEMBER,
  ON_HOLD,
  TRAINING_MEMBER,
  isActiveMember,
  isCurrentMember,
  isGuardianAccount,
  isLeftMember,
  isOnHold,
  isTrainingMember,
} from "@/lib/member-population";

export const QUIET_THRESHOLD_DAYS = 14;
const DAY_MS = 86_400_000;

/** The month window as both sides need it. */
type Month = Pick<ClubMonthWindow, "monthStart" | "nextMonthStart">;

export const MEMBER_LIST_COUNT_KEYS = [
  "all",
  "attention",
  "overdue",
  "waiverMissing",
  "missingPhone",
  "quiet",
  "paid",
  "active",
  "inactive",
  "onHold",
  "activeOnHold",
  "cancelled",
  "guardians",
  "taster",
  "kids",
  "newThisMonth",
  "churnedThisMonth",
] as const;

export type MemberListCountKey = (typeof MEMBER_LIST_COUNT_KEYS)[number];
export type MemberListCounts = Record<MemberListCountKey, number>;

// ─── Browser predicates (rows as the Members page holds them) ───────────────

/** The row fields the counts read. `paymentStatus` is the SHOWN status (lib/overdue shownPaymentStatus). */
export type CountRow = {
  status: string;
  accountType?: string | null;
  paymentStatus?: string | null;
  waiverAccepted?: boolean | null;
  phone?: string | null;
  parentMemberId?: string | null;
  joinedAt?: string | null;
  cancelledAt?: string | null;
  lastVisitAt?: string | null;
};

function daysSince(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS));
}

/**
 * "Waiver missing" = someone who can train (active or taster) with no signed
 * waiver. The dashboard's "Missing waivers" count links to this filter and
 * uses the same definition (app/dashboard/page.tsx); they used to disagree
 * (4 vs 5) because this side also counted inactive members.
 */
export function isWaiverMissing(m: { status: string; waiverAccepted?: boolean | null }) {
  return (m.status === "active" || m.status === "taster") && m.waiverAccepted === false;
}

export function isQuiet(
  m: { paymentStatus?: string | null; status: string; lastVisitAt?: string | null; joinedAt?: string | null },
  now: Date = new Date(),
) {
  // "Quiet" = paying active member who hasn't checked in for {QUIET_THRESHOLD_DAYS} days.
  // Tasters and unpaid members are excluded — they belong in the Attention/Overdue bucket.
  if (m.status !== "active") return false;
  if ((m.paymentStatus ?? "paid") !== "paid") return false;
  const days = daysSince(m.lastVisitAt, now);
  if (days !== null) return days >= QUIET_THRESHOLD_DAYS;
  // Never visited. Verifier lane 3 D4: this used to be quiet regardless of
  // joining date, so a member who joined this morning was flagged as lapsed.
  // Someone who has not had 14 days to visit yet is new, not quiet.
  const sinceJoined = daysSince(m.joinedAt, now);
  return sinceJoined === null || sinceJoined >= QUIET_THRESHOLD_DAYS;
}

/** No phone on record. The server twin is `phone IS NULL OR phone = ''` (writes validate E.164, so blank-but-spaces cannot be stored). */
export function isMissingPhone(m: { phone?: string | null }) {
  return !m.phone?.trim();
}

export function isOverdueRow(m: { paymentStatus?: string | null }) {
  return m.paymentStatus === "overdue";
}

export function needsAttention(m: CountRow, now: Date = new Date()) {
  return isOverdueRow(m) || isWaiverMissing(m) || m.status === "taster" || isQuiet(m, now);
}

/** Every Members-page total over loaded rows. The page uses it only for rows the server has not counted (a member added since load). */
export function countMemberRows(rows: CountRow[], now: Date, month: Month): MemberListCounts {
  const current = rows.filter(isCurrentMember);
  return {
    all: current.length,
    attention: current.filter((m) => needsAttention(m, now)).length,
    overdue: current.filter(isOverdueRow).length,
    waiverMissing: current.filter(isWaiverMissing).length,
    missingPhone: current.filter(isMissingPhone).length,
    quiet: current.filter((m) => isQuiet(m, now)).length,
    paid: current.filter((m) => (m.paymentStatus ?? "paid") === "paid").length,
    active: rows.filter(isActiveMember).length,
    inactive: current.filter((m) => m.status === "inactive").length,
    onHold: current.filter(isOnHold).length,
    activeOnHold: rows.filter((m) => isActiveMember(m) && isOnHold(m)).length,
    cancelled: rows.filter(isLeftMember).length,
    guardians: rows.filter((m) => m.status !== "cancelled" && isGuardianAccount(m)).length,
    taster: current.filter((m) => m.status === "taster").length,
    kids: current.filter((m) => !!m.parentMemberId).length,
    newThisMonth: rows.filter((m) => isTrainingMember(m) && inMonthWindow(m.joinedAt, month)).length,
    churnedThisMonth: rows.filter((m) => isLeftMember(m) && inMonthWindow(m.cancelledAt, month)).length,
  };
}

export function addCounts(a: MemberListCounts, b: MemberListCounts): MemberListCounts {
  return Object.fromEntries(MEMBER_LIST_COUNT_KEYS.map((k) => [k, a[k] + b[k]])) as MemberListCounts;
}

// ─── Server wheres (the full population) ─────────────────────────────────────

/** Shown status "paid": stored paid AND not derived overdue (null-safe; see notOverdueWhere). */
function shownPaidWhere(now: Date): Prisma.MemberWhereInput {
  return { AND: [{ paymentStatus: "paid" }, notOverdueWhere(now)] };
}

/** isQuiet as a where: active, shown paid, no visit in 14 days — and, if never visited, joined 14+ days ago. */
function quietWhere(now: Date): Prisma.MemberWhereInput {
  const cutoff = new Date(now.getTime() - QUIET_THRESHOLD_DAYS * DAY_MS);
  return {
    status: "active",
    AND: [
      shownPaidWhere(now),
      { attendances: { none: { checkInTime: { gt: cutoff } } } },
      { OR: [{ attendances: { some: {} } }, { joinedAt: { lte: cutoff } }] },
    ],
  };
}

/**
 * One where per total, each with `tenantId`. `now` is the instant the shown
 * payment status was derived at; `month` is the club-zone window
 * (lib/club-month.ts) — the same one Reports counts "this month" by.
 */
export function memberListCountWheres(tenantId: string, now: Date, month: Month): Record<MemberListCountKey, Prisma.MemberWhereInput> {
  const waiverMissingCore = { status: { in: ["active", "taster"] }, waiverAccepted: false };
  return {
    all: { tenantId, ...CURRENT_MEMBER },
    attention: {
      tenantId,
      ...CURRENT_MEMBER,
      OR: [{ OR: overdueClause(now) }, waiverMissingCore, { status: "taster" }, quietWhere(now)],
    },
    overdue: { tenantId, ...CURRENT_MEMBER, OR: overdueClause(now) },
    waiverMissing: { tenantId, ...CAN_TRAIN_MEMBER, waiverAccepted: false },
    missingPhone: { tenantId, ...CURRENT_MEMBER, OR: [{ phone: null }, { phone: "" }] },
    quiet: { tenantId, ...CURRENT_MEMBER, AND: [quietWhere(now)] },
    paid: { tenantId, ...CURRENT_MEMBER, AND: [shownPaidWhere(now)] },
    active: { tenantId, ...ACTIVE_MEMBER },
    inactive: { tenantId, ...TRAINING_MEMBER, status: "inactive" },
    onHold: { tenantId, ...CURRENT_MEMBER, ...ON_HOLD },
    activeOnHold: { tenantId, ...ACTIVE_MEMBER, ...ON_HOLD },
    cancelled: { tenantId, ...LEFT_MEMBER },
    guardians: { tenantId, ...GUARDIAN_ACCOUNT, status: { not: "cancelled" } },
    taster: { tenantId, ...TRAINING_MEMBER, status: "taster" },
    kids: { tenantId, ...CURRENT_MEMBER, parentMemberId: { not: null } },
    newThisMonth: { tenantId, ...TRAINING_MEMBER, joinedAt: monthRange(month) },
    churnedThisMonth: { tenantId, ...LEFT_MEMBER, cancelledAt: monthRange(month) },
  };
}

