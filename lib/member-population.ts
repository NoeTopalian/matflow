/**
 * Who counts as a MEMBER in headline numbers (2 Oct 2026, independent
 * acceptance of the TeamUp import, finding P1): a parent/guardian account —
 * including the no-login guardian drafts an import makes from emergency
 * contacts — is an account holder, not a training member. Counting them made
 * Reports say "531 active members" and "226 new this month" for a club whose
 * import created 219 guardian records. Every population count (active, new,
 * retention, net-new, status breakdown) spreads this into its `where`.
 *
 * Children are members (they train); parents are not unless they also hold a
 * membership of their own, in which case their row is typed `adult`.
 *
 * T1 (17 Oct 2026): every named member population lives here, once, as a
 * Prisma `where` fragment for the server AND a plain predicate for the
 * browser, so the Members page, Reports, Settings, Analysis and Revenue can no
 * longer count different things under one word. Owner decision Q4 A-1 (Noe,
 * 17 Oct 2026): the headline "Active members" is ACTIVE_MEMBER — status
 * active, not a guardian account — and members on hold stay inside it, marked
 * as such. A hold is the billing axis (`paymentStatus` "paused") and is never
 * a status row (docs/readiness/MATFLOW-SPECIFICATION-2026-10.md:102-103).
 *
 * Rules for callers:
 * - None of these fragments carries `tenantId`. Spread them BESIDE an
 *   explicit `tenantId` inside withTenantContext; RLS is the backstop only.
 * - This file must stay free of runtime imports (`import type` only) so
 *   client components can import the predicates and the copy table.
 */
import type { Prisma } from "@prisma/client";

export const TRAINING_MEMBER = { accountType: { not: "parent" } } as const;

/** The headline population: active training members, holds included. */
export const ACTIVE_MEMBER = { ...TRAINING_MEMBER, status: "active" } as const satisfies Prisma.MemberWhereInput;

/** Everyone still on the books: active, inactive and tasters. Not cancelled, not guardians. */
export const CURRENT_MEMBER = { ...TRAINING_MEMBER, status: { not: "cancelled" } } as const satisfies Prisma.MemberWhereInput;

/** Members who may train today: active and tasters. */
export const CAN_TRAIN_MEMBER = {
  ...TRAINING_MEMBER,
  status: { in: ["active", "taster"] },
} satisfies Prisma.MemberWhereInput;

/** Training members who have left the club. */
export const LEFT_MEMBER = { ...TRAINING_MEMBER, status: "cancelled" } as const satisfies Prisma.MemberWhereInput;

/** Parent/guardian accounts — held for a child, never a people count. */
export const GUARDIAN_ACCOUNT = { accountType: "parent" } as const satisfies Prisma.MemberWhereInput;

/**
 * On hold: the billing axis only. Combine it with a status population
 * (e.g. `{ ...ACTIVE_MEMBER, ...ON_HOLD }`); never show it as a status row.
 */
export const ON_HOLD = { paymentStatus: "paused" } as const satisfies Prisma.MemberWhereInput;

/**
 * PAYERS (review L2, 23 Oct 2026): who the club chases for money. A different
 * axis from the member populations above, on purpose.
 *
 * Member totals count people who TRAIN, so guardians are out. Money totals
 * count ROWS THAT OWE, and a guardian row can owe: a member who switches
 * themselves to a parent account keeps their plan, due date and subscription
 * (app/api/member/me/route.ts), staff can put a parent account on a plan
 * (app/api/members/[id]/route.ts), and nothing in the billing paths refuses
 * one. Dropping guardians from "overdue" would hide a real debt. So a payer is
 * any row, guardian or not, whose membership is active or a taster — the
 * statuses Payments → Outstanding has always chased — and every money total
 * says "payers" and that guardians who pay are included.
 *
 * Kids' own plans are billed on the kid's row (start-for-kid creates the
 * kid's Stripe customer), so a family is never counted twice.
 */
export const CHASEABLE_PAYER = { status: { in: ["active", "taster"] } } satisfies Prisma.MemberWhereInput;

export function isChaseablePayer(m: Pick<PopulationRow, "status">): boolean {
  return m.status === "active" || m.status === "taster";
}

export const PAYER_COPY = {
  label: "Payers overdue",
  includes: "Active members and tasters who owe the club, including parents and guardians who pay",
  excludes: "Excludes inactive and cancelled members",
} as const;

/** "1 payer" / "3 payers". */
export function payersLabel(n: number): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? "payer" : "payers"}`;
}

/** "3 payers overdue". */
export function payersOverdueLabel(n: number): string {
  return `${payersLabel(n)} overdue`;
}

/**
 * The detail every payer total carries: guardians who pay are counted, and
 * how many of them there are when any are.
 */
export function payerGuardianNote(guardians: number): string {
  if (guardians <= 0) return "Includes parents and guardians who pay";
  return guardians === 1
    ? "Includes 1 parent or guardian who pays"
    : `Includes ${guardians.toLocaleString("en-GB")} parents or guardians who pay`;
}

/** The fields every client twin reads. Matches the `getMembers` row shape. */
export type PopulationRow = {
  status: string;
  accountType?: string | null;
  paymentStatus?: string | null;
};

// A missing accountType reads as the column default ("adult"), as the
// database would store it, so a row without the field is a training member.
export function isTrainingMember(m: Pick<PopulationRow, "accountType">): boolean {
  return m.accountType !== "parent";
}
export function isActiveMember(m: PopulationRow): boolean {
  return isTrainingMember(m) && m.status === "active";
}
export function isCurrentMember(m: PopulationRow): boolean {
  return isTrainingMember(m) && m.status !== "cancelled";
}
export function isCanTrainMember(m: PopulationRow): boolean {
  return isTrainingMember(m) && (m.status === "active" || m.status === "taster");
}
export function isLeftMember(m: PopulationRow): boolean {
  return isTrainingMember(m) && m.status === "cancelled";
}
export function isGuardianAccount(m: Pick<PopulationRow, "accountType">): boolean {
  return m.accountType === "parent";
}
export function isOnHold(m: Pick<PopulationRow, "paymentStatus">): boolean {
  return m.paymentStatus === "paused";
}

export type PopulationKey =
  | "training"
  | "active"
  | "current"
  | "canTrain"
  | "left"
  | "guardian"
  | "onHold"
  | "inactive"
  | "taster";

/**
 * One label and one "what this counts" pair per population, British English,
 * sentence case. Every count on screen takes its words from here so a number
 * always says what it includes and what it leaves out.
 */
export const POPULATION_COPY: Record<PopulationKey, { label: string; includes: string; excludes: string }> = {
  training: {
    label: "Training members",
    includes: "Everyone who trains, in any status",
    excludes: "Excludes parent and guardian accounts",
  },
  active: {
    label: "Active members",
    includes: "Active training members, including any on hold",
    excludes: "Excludes inactive members, tasters, cancelled members and guardians",
  },
  current: {
    label: "Current members",
    includes: "Active and inactive members and tasters",
    excludes: "Excludes cancelled members and guardians",
  },
  canTrain: {
    label: "Active members and tasters",
    includes: "Everyone who can train today",
    excludes: "Excludes inactive members, cancelled members and guardians",
  },
  left: {
    label: "Cancelled members",
    includes: "Training members who have left",
    excludes: "Excludes guardians",
  },
  guardian: {
    label: "Parents and guardians",
    includes: "Accounts held for a child",
    excludes: "Not counted in any member total",
  },
  onHold: {
    label: "On hold",
    includes: "Memberships paused on the billing side",
    excludes: "Counted inside their status, never as a status of their own",
  },
  inactive: {
    label: "Inactive members",
    includes: "Training members marked inactive",
    excludes: "Excludes active members, tasters, cancelled members and guardians",
  },
  taster: {
    label: "Tasters",
    includes: "People on a taster",
    excludes: "Excludes guardians",
  },
};
