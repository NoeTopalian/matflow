/**
 * Dashboard "Today" action items — turns raw per-member signals into a
 * prioritised list of SPECIFIC, NAMED, actionable rows (e.g. "Jane Smith —
 * £40 payment failed 3 days ago"), instead of the bare counts the dashboard
 * showed before. Pure + deterministic so it can be unit-tested; the Prisma
 * queries live in app/dashboard/page.tsx and feed this builder.
 */

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
  /** Active/taster members with paymentStatus = "overdue". */
  overdue: { id: string; name: string }[];
  /** Failed Payment rows in the recent window (most-recent first), with the member. */
  recentFailed: { memberId: string | null; memberName: string | null; amountPence: number; createdAt: Date }[];
  /** Active/taster members with no signed waiver. */
  missingWaiver: { id: string; name: string }[];
  /** Active members not seen in 14+ days. */
  atRisk: { id: string; name: string }[];
  /** Active/taster members with a dateOfBirth (filtered to the next 7 days here). */
  birthdayCandidates: { id: string; name: string; dateOfBirth: Date }[];
};

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
      detail: "Payment overdue",
      href: `/dashboard/members/${m.id}?tab=payments`,
      emoji: "💳",
    });
  }

  // ── Retention
  for (const m of input.atRisk) {
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
