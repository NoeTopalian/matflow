/**
 * Dashboard "Today" action items — turns raw per-member signals into a
 * prioritised list of SPECIFIC, NAMED, actionable rows (e.g. "Jane Smith —
 * £40 payment failed 3 days ago"), instead of the bare counts the dashboard
 * showed before. Pure + deterministic so it can be unit-tested; the Prisma
 * queries live in app/dashboard/page.tsx and feed this builder.
 */

import { TRAINING_MEMBER } from "@/lib/member-population";
import { DEFAULT_TIMEZONE, usableTimezone } from "@/lib/class-time";

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
   * True while the At-Risk gate is closed (see readAtRiskGate). The at-risk
   * rows are then dropped, whatever `atRisk` holds, so the named list and the
   * headline tile are switched off by the same signal.
   */
  atRiskSuppressed?: boolean;
  /** Active/taster members with a dateOfBirth (filtered to the next 7 days here). */
  birthdayCandidates: { id: string; name: string; dateOfBirth: Date }[];
};

/** Days without a check-in before an active member counts as "not seen". */
export const AT_RISK_DAYS = 14;

/** The start of the At-Risk window: AT_RISK_DAYS calendar days before `now`. */
export function atRiskWindowStart(now: Date): Date {
  const since = new Date(now);
  since.setDate(now.getDate() - AT_RISK_DAYS);
  return since;
}

/**
 * The Prisma `where` for "active member not seen in {AT_RISK_DAYS}+ days" —
 * shared by the dashboard's headline count and its named action list so the
 * two cannot disagree. A member who has never attended and joined inside the
 * window is NEW, not lapsed: the end-user simulation (30 Sep 2026) saw eight
 * members who joined that morning listed as "Not seen in 14+ days".
 *
 * A visit is ANY attendance row, imported or recorded in MatFlow: imported
 * history is real attendance, and it is what shows a member who had already
 * stopped coming before the club moved to MatFlow. Whether the window can be
 * judged at all is the gate's question (readAtRiskGate), not this predicate's.
 *
 * NOT yet the same rule as the Members "Quiet" chip (`isQuiet` in
 * components/dashboard/MembersList.tsx), which also requires `paid` and is
 * never suppressed; aligning the two is T2a Part F. Until then the chip shows
 * its own count.
 */
export function atRiskMemberWhere(tenantId: string, now: Date) {
  const since = atRiskWindowStart(now);
  return {
    tenantId,
    status: "active",
    // Training members only: an import creates no-login guardian drafts
    // (active, never attend), and every one of them would otherwise be "not
    // seen in 14 days" (T2a Part U; lib/member-population.ts).
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

/**
 * THE RULE for whether the dashboard can show At-Risk (T2a Part U: the
 * suppression is an agent default adopted 17 Oct 2026; not an owner decision.
 * Extended 24 Oct 2026 for sparse check-ins after an import).
 *
 * At-Risk says "not seen in 14 days". That is only true if MatFlow would have
 * seen them: every day of the 14-day window must fall in time MatFlow was the
 * club's register. A club fresh off TeamUp has years of imported visits that
 * stop at the export, then a gap MatFlow knows nothing about (classes still
 * registered in TeamUp), then its first MatFlow check-ins. Counting absence
 * across that gap flags members who were training all along — the whole club,
 * the moment one check-in lifts a "has any check-in" gate.
 *
 * So the window is judged only when ALL of these hold:
 *   1. the club has a check-in recorded in MatFlow BEFORE the window starts
 *      (MatFlow has been the register for the whole window); and
 *   2. MatFlow recorded check-ins in EACH 7-day half of the window (the
 *      register was in use throughout — a week with none, such as a closure
 *      or registers taken elsewhere again, cannot show who stayed away).
 * Otherwise the tile shows why it has no number:
 *   - "none": no MatFlow check-in at all yet;
 *   - "warming_up": the first MatFlow check-in is under 14 days old; At-Risk
 *     starts 14 days after it (`startsAt`);
 *   - "paused": a 7-day half of the window has no MatFlow check-in.
 * When the gate is open, imported visits still count as visits in
 * atRiskMemberWhere, so a member whose last visit was imported long before
 * the switch is flagged, and a member seen at a MatFlow register is not.
 *
 * What the rule cannot know: a club that registers SOME classes in MatFlow
 * every week and the rest elsewhere will see members of the unregistered
 * classes flagged. Nothing in the data tells those apart from real absences;
 * the tile's detail line says the count rests on check-ins recorded in MatFlow.
 *
 * Cost: three indexed probes on AttendanceRecord(tenantId, checkInTime).
 * Probe 1 walks back from the window start and stops at the first MatFlow
 * row, which is immediate for a club on MatFlow; for a club with none it
 * walks the tenant's imported history, as the earlier gate did. A partial
 * index on AttendanceRecord(tenantId, checkInTime) WHERE checkInMethod <>
 * 'import' AND importJobId IS NULL belongs in a later schema batch if it shows
 * in latency.
 */
export type AtRiskGate =
  | { open: true }
  | { open: false; reason: "none" }
  | { open: false; reason: "warming_up"; startsAt: Date }
  | { open: false; reason: "paused" };

type CheckInTimeFilter = { lt?: Date; gte?: Date };

/** The slice of a Prisma (transaction) client the at-risk gate reads. */
export type AtRiskGateClient = {
  attendanceRecord: {
    findFirst(args: {
      where: { tenantId: string; checkInMethod: { not: "import" }; importJobId: null; checkInTime: CheckInTimeFilter };
      orderBy?: { checkInTime: "asc" | "desc" };
      select: { checkInTime: true };
    }): PromiseLike<{ checkInTime: Date } | null>;
  };
};

export async function readAtRiskGate(tx: AtRiskGateClient, tenantId: string, now: Date): Promise<AtRiskGate> {
  const since = atRiskWindowStart(now);
  const probe = (checkInTime: CheckInTimeFilter, order: "asc" | "desc") =>
    tx.attendanceRecord.findFirst({
      where: { tenantId, ...MATFLOW_CHECKIN_WHERE, checkInTime },
      orderBy: { checkInTime: order },
      select: { checkInTime: true },
    });

  const before = await probe({ lt: since }, "desc");
  if (!before) {
    const first = await probe({ gte: since }, "asc");
    if (!first) return { open: false, reason: "none" };
    const startsAt = new Date(first.checkInTime);
    startsAt.setDate(startsAt.getDate() + AT_RISK_DAYS);
    return { open: false, reason: "warming_up", startsAt };
  }
  const mid = new Date(since);
  mid.setDate(since.getDate() + Math.floor(AT_RISK_DAYS / 2));
  const [firstHalf, secondHalf] = await Promise.all([
    probe({ gte: since, lt: mid }, "asc"),
    probe({ gte: mid }, "asc"),
  ]);
  if (!firstHalf || !secondHalf) return { open: false, reason: "paused" };
  return { open: true };
}

/** Back-compatible boolean: true whenever the gate is closed, for any reason. */
export async function atRiskSuppressed(tx: AtRiskGateClient, tenantId: string, now: Date = new Date()): Promise<boolean> {
  return !(await readAtRiskGate(tx, tenantId, now)).open;
}

/** What the tile, its detail line and the to-do panel say while the gate is closed. */
export type AtRiskCopy = { note: string; detail: string; todoNote: string };

/** The tile's detail line while At-Risk is shown: what the count rests on. */
export const AT_RISK_OPEN_DETAIL = "Not seen in 14 days";

/** Day and month in British English in the club's zone, for "Starts 7 Nov". */
function shortDate(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: usableTimezone(timeZone) });
}

/**
 * Copy for a closed gate. The trigger is ANY check-in recorded in MatFlow
 * (register, kiosk, QR, member self check-in or auto check-in:
 * MATFLOW_CHECKIN_WHERE), so the copy names a check-in, not a register. The
 * detail line describes the wait only: once open, imported visits still count
 * as visits in atRiskMemberWhere (T2a Part U residual U2).
 */
export function atRiskClosedCopy(gate: Exclude<AtRiskGate, { open: true }>, timeZone: string = DEFAULT_TIMEZONE): AtRiskCopy {
  switch (gate.reason) {
    case "none":
      return {
        note: AT_RISK_SUPPRESSED_NOTE,
        detail: AT_RISK_SUPPRESSED_DETAIL,
        todoNote: AT_RISK_SUPPRESSED_TODO_NOTE,
      };
    case "warming_up":
      return {
        note: `Starts ${shortDate(gate.startsAt, timeZone)}`,
        detail: "Needs 14 days of check-ins recorded in MatFlow",
        todoNote: `At-Risk members start on ${shortDate(gate.startsAt, timeZone)}, after 14 days of check-ins recorded in MatFlow.`,
      };
    case "paused":
      return {
        note: "Paused",
        detail: "No check-ins recorded in MatFlow for a week of the last 14 days",
        todoNote: "At-Risk members are paused: a week of the last 14 days has no check-ins recorded in MatFlow.",
      };
  }
}

/** The copy for a club with no MatFlow check-in yet ("none"). */
export const AT_RISK_SUPPRESSED_NOTE = "Starts 14 days after the first check-in recorded in MatFlow";
export const AT_RISK_SUPPRESSED_DETAIL = "Hidden until then: imported history alone can't show who has stopped coming";
/** Muted line under "All caught up" while At-Risk is unknown rather than zero (UI-RULES §7). */
export const AT_RISK_SUPPRESSED_TODO_NOTE = "At-Risk members start 14 days after the first check-in recorded in MatFlow.";

export type AtRiskWhere = ReturnType<typeof atRiskMemberWhere>;

/** The slice of a Prisma (transaction) client readAtRisk reads. */
export type AtRiskReadClient = AtRiskGateClient & {
  member: {
    count(args: { where: AtRiskWhere }): PromiseLike<number>;
    findMany(args: {
      where: AtRiskWhere;
      select: { id: true; name: true };
      take: number;
    }): PromiseLike<{ id: string; name: string }[]>;
  };
};

/** One club-wide At-Risk answer: the tile count, the named rows and the gate. */
export type AtRiskRead = {
  suppressed: boolean;
  count: number;
  members: { id: string; name: string }[];
  /** Present while suppressed: what the tile and the to-do panel say instead of a number. */
  copy?: AtRiskCopy;
};

/** How many at-risk names the dashboard action list is fed. */
export const AT_RISK_LIST_TAKE = 25;

/**
 * Reads At-Risk ONCE for the dashboard: the gate, then (only when the gate is
 * open) the headline count and the named rows from the same predicate. The
 * page hands this one value to the stats tile and to the action-item builder,
 * so the tile, the to-do row and the named list cannot disagree. While
 * suppressed, no member query runs at all.
 */
export async function readAtRisk(
  tx: AtRiskReadClient,
  tenantId: string,
  now: Date,
  timeZone: string | null | undefined = DEFAULT_TIMEZONE,
): Promise<AtRiskRead> {
  const gate = await readAtRiskGate(tx, tenantId, now);
  if (!gate.open) {
    return { suppressed: true, count: 0, members: [], copy: atRiskClosedCopy(gate, usableTimezone(timeZone)) };
  }
  const where = atRiskMemberWhere(tenantId, now);
  const [count, members] = await Promise.all([
    tx.member.count({ where }),
    tx.member.findMany({ where, select: { id: true, name: true }, take: AT_RISK_LIST_TAKE }),
  ]);
  return { suppressed: false, count, members };
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
