// Shared check-in business rules — single source of truth for both the staff
// route (`POST /api/checkin`) and the public kiosk route
// (`POST /api/kiosk/[token]/checkin`).
//
// Behaviour matrix (set by the caller):
//
//   method   enforceRankGate  enforceTimeWindow  requireCoverage  enforceCapacity  enforceWaiverGate
//   ------   ---------------  -----------------  ---------------  ---------------  -----------------
//   admin    false            false              false            false            false  (staff mark — bypasses these gates)
//   self     true             true               true             true             true   (member self-serve)
//   auto     false            false              false            false            false  (cron / system)
//   kiosk    true             true               false            true             true   (iPad at the door — respects window, forgiving on subs)
//   qr       false            false              false            false            false  (a coach scanning a card)
//
//   enforceHoldGate (a membership on hold, lib/member-hold.ts) follows the
//   waiver column: self and kiosk refuse, staff paths admit. enforceKidsGate
//   (an adult into a `Class.isKids` class) follows the same line.
//
// CLASS ELIGIBILITY — the squad list (ClassRoster) and the membership list
// (ClassMembershipTier) — is NOT in the matrix: it has no flag and no
// override (owner decision, 20 Oct 2026). For EVERY method, inside the write
// transaction and after the Class row lock, a class with a roster refuses a
// member who is not on it ("roster_not_listed"), and a class with
// memberships ticked refuses a member whose plan is not one of them
// ("tier_not_included"). A class with both requires both; a class with
// neither is open to everyone. Staff who want someone in change the
// membership or the squad list through the audited routes instead.
//
// ALLOWANCE (T7, Sean note 5; owner decisions 17 Oct 2026): a plan with
// "N classes every M weeks" (lib/class-allowance.ts) is enforced as soon as
// the owner sets it. `allowanceGate` follows the tier gate's door profile:
// self and kiosk "refuse" with the count and the date the next class frees
// up; the register (admin), the card scanner (qr) and the coach tick "ask",
// and an admission past the allowance is reported in `overrides` as
// "allowance_reached" with `overAllowance` for the route's audit row. A
// check-in paid by a class pack is not counted and not gated.
//
// Lock order on EVERY check-in write transaction: Class FOR UPDATE
// (capacityState / classEligibility), then the Member row (memberLock: FOR NO KEY
// UPDATE, see there for why not FOR UPDATE), then
// statement C (lib/class-allowance-count.ts, a plain read), then the pack
// decrement and the AttendanceRecord insert. The Member lock is taken
// unconditionally, whatever the plan and the door, because whether a plan is
// limited is itself configuration that can change mid-check-in: a lock taken
// only when an earlier read said "limited" would not serialise against a
// check-in that read "Unlimited" a moment before (planning evidence §8b.3
// C10 and §8c rule 4). Two check-ins for the same member therefore queue on
// the Member row, and the second one's count starts after the first commits.
// Lock-order audit (17 Oct 2026, revised after review): every check-in path
// is Class, then Member, then a pack. The writers that touch the same rows in
// another order were aligned rather than documented:
//  - an owner's undo-to batch (lib/undo-batch.ts) locks every Class it will
//    touch, then every Member, before running any handler, so a member edit
//    followed by a class edit, a roster restore (KEY SHARE on Class), or a
//    pack credit restored before a member edit can no longer form a cycle;
//  - the Stripe dispute webhook (app/api/stripe/webhook/route.ts) writes the
//    Member row before it voids the disputed pack (Member, then pack);
//  - member deletion locks the Member row before touching its packs
//    (lib/member-delete.ts), so a pack check-in holding the Member lock cannot
//    deadlock with a cascade (§8b.3 C1).
// The refund route and the charge.refunded / invoice.voided webhook legs
// touch a pack and no Member row, so they wait at most; they cannot cycle.
//
// Coverage is re-checked under the Member lock (R-ALLOW rule 2, §8c): the
// coverage, venue, hold and tier decisions are made from a read taken before
// the write transaction, so the lock re-reads the columns they depend on and
// a plan, payment or hold change committed in between restarts the check-in
// from the top (memberChangedSince / MemberChangedMidCheckin).
//
// Class packs and the allowance (owner decision: a pack redemption does not
// count against the plan). Which pays is decided in ONE write transaction:
//  - a member the plan does not cover pays with a pack where they have one,
//    at the member app and the kiosk alike: not counted, not gated;
//  - a covered member is counted against the allowance; once it is used up
//    on a refusing door (member app, parent, kiosk), a usable pack pays for
//    the class instead of a refusal (and that visit is not counted);
//  - staff doors never spend a pack: they ask, as before.
//
// CAPACITY, added round 3. `Class.maxCapacity` was enforced at BOOKING only
// (`/api/member/class-subscriptions/[classId]`, round 1 defect L-F 1) and
// nowhere at check-in, so a class that seats twelve took a fourteenth person
// through the kiosk or the member app and the coach found out on the mat.
//
// It is enforced for `self` and `kiosk` — the paths where the MEMBER decides —
// and deliberately NOT for `admin`, `qr` or `auto`. A coach who has looked at
// the room and waved someone in is making a judgement the software should not
// overrule. But that override is not silent: the result carries
// `overCapacity`, so the route can say "Checked in — this class is now 13 of
// 12" and the audit row records it, rather than the number quietly drifting.
//
// WAIVER, added round 4. `docs/spec.md` F4 specifies a "hard block — cannot
// check in at all" when `Member.waiverAccepted` is false, and the product had
// exactly one enforcement of it: `components/kiosk/KioskPage.tsx` routing the
// tapped match to the waiver screen. The API behind that screen ran rank,
// roster, window and capacity and no waiver check, so a two-call sequence
// against the kiosk URL — GET /members for a `kioskMemberToken`, POST
// /checkin with it — wrote an AttendanceRecord for an unsigned member and got
// a 201 back. The kiosk URL is the only credential on that surface and it is
// printed on a tablet in a public lobby, so "the client will not ask" was the
// whole of the gate. For a gym that is an insurance position, not a UI bug.
//
// Scoped exactly like capacity: enforced for `self` and `kiosk` — the paths
// where the MEMBER decides, unsupervised — and NOT for `admin`, `qr` or
// `auto`, so front-desk judgement can still admit someone who has just signed
// on paper and a coach scanning cards is not stopped mid-register. Unlike
// capacity there is no "did it anyway" result: a staff method simply never
// asks the question, because a waiver is the club's evidence rather than a
// number that can drift.
//
// Kids: the flag lives on the KID's own Member row and is flipped by the
// parent-signed flow (`app/api/waiver/sign-for-child/route.ts:136`), so
// reading `waiverAccepted` for the member being checked in is already the
// parent-signed kids waiver. No special case, and the multi-kid kiosk picker
// keeps working — it disables an unsigned child at the client and the API now
// refuses that child on its own row if the picker is bypassed.

import * as Sentry from "@sentry/nextjs";
import type { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parseTime, DEFAULT_TIMEZONE } from "@/lib/class-time";
import { isOnHold } from "@/lib/member-hold";
import { isOverdue } from "@/lib/overdue";
import { isAdultAccount } from "@/lib/account-type";
import { classTierCovers } from "@/lib/class-tier-gate";
import { doorLifecycle } from "@/lib/class-lifecycle";
import {
  ALLOWANCE_OVERRIDE_REASON,
  allowanceVerdict,
  slotMinute,
  type AllowanceGateMode,
  type LocalSlot,
} from "@/lib/class-allowance";
import { readAllowanceSnapshot } from "@/lib/class-allowance-count";


/**
 * How an attendance row came to exist.
 *
 * "qr" is a coach scanning a printed member ID card (app/api/checkin/card).
 * It was documented in the schema, labelled in lib/reports.ts and given a
 * filter chip in AttendanceView long before anything could write it, so the
 * reporting surfaces for it existed and were permanently empty. The scanner
 * is what makes the value real; the union had simply never been widened to
 * admit it, so writing "qr" would not have typechecked.
 */
export type CheckinMethod = "admin" | "self" | "auto" | "kiosk" | "qr";

export type PerformCheckinArgs = {
  tenantId: string;
  memberId: string;
  classInstanceId: string;
  method: CheckinMethod;
  enforceRankGate: boolean;
  enforceTimeWindow: boolean;
  requireCoverage: boolean;
  /**
   * Refuse when the class is already at `Class.maxCapacity`. Required, not
   * defaulted, for the same reason `timeZone` is in lib/class-time.ts: a
   * default lets the next caller keep the old behaviour silently, whereas a
   * missing argument is a compile error.
   */
  enforceCapacity: boolean;
  /**
   * Refuse when `Member.waiverAccepted` is false. Required, not defaulted, for
   * the same reason `enforceCapacity` is: a default lets the next caller keep
   * the unguarded behaviour silently, and this is the gate whose absence let
   * an unsigned member onto the mat.
   */
  enforceWaiverGate: boolean;
  /**
   * Refuse a member whose membership is on hold (paymentStatus "paused" with
   * no passed end date — lib/member-hold.ts). Same enforcement profile as the
   * waiver gate: the member-decided paths (self, kiosk) refuse; a staff
   * override admits, because the desk can see the person. Optional so the
   * callers that never gate (card scan, tests) keep their shape; the two
   * member-decided routes pass it explicitly.
   */
  enforceHoldGate?: boolean;
  /**
   * Refuse a member whose tier is bound to a venue other than the class's
   * (ADR-001 D2 slice 2). A class with no venue, or a tier with no venue, is
   * open. Same profile as the waiver gate: member-decided paths refuse, a
   * staff mark admits. Optional for the same reason as enforceHoldGate.
   */
  enforceVenueGate?: boolean;
  /**
   * Refuse an adult (accountType adult or parent) into a kids class
   * (`Class.isKids`). A child's and a junior's own check-in is allowed, and a
   * parent checking in THEIR CHILD is the child's check-in, so it passes. Same
   * profile as the hold gate: self and kiosk refuse; the register asks the desk
   * instead (components/dashboard/RegisterPanel.tsx) and a staff mark admits.
   */
  enforceKidsGate?: boolean;
  /**
   * T6b: refuse a session of a PAUSED or ARCHIVED class (Class.isActive false
   * or deletedAt set). The member-decided doors (self, parent, kiosk) pass
   * true: the class is hidden from them, and a session minted before the
   * pause must not admit by instance id either. Staff doors leave it off and
   * admit as before (the desk can see the room); the full per-door modes and
   * the write-phase re-check are T4c's.
   */
  enforceClassStateGate?: boolean;
  /**
   * T7: the member's plan allowance ("N classes every M weeks"). "refuse" for
   * the member-decided doors (self, parent, kiosk); "ask" for the staff doors
   * (register, card scanner), refused with an askable answer unless
   * `allowanceOverrideConfirmed`, then admitted and reported in `overrides`.
   * Omitted = "off" (system paths, tests). Judged inside the write
   * transaction after the Class lock, under the Member lock.
   */
  allowanceGate?: AllowanceGateMode;
  /** Staff saw the "allowance used" question and admitted anyway. */
  allowanceOverrideConfirmed?: boolean;
  // Staff user id when method=admin (the person clicking "check in" in the
  // dashboard). Null/undefined for self / kiosk / auto / system.
  checkedInByUserId?: string | null;
};

/**
 * A gate a staff door admitted past on confirmation. Only the allowance: the
 * squad list and the membership list refuse at every door (owner decision,
 * 20 Oct 2026) and have no override.
 */
export type CheckinOverride = typeof ALLOWANCE_OVERRIDE_REASON;

/** The allowance count a refusal, a question or an override carries. */
export type AllowanceFacts = {
  /** Counted classes in the busiest window containing this session (excluding it). */
  used: number;
  limit: number;
  weeks: number;
  /** When the next class frees up, in the club's clock; null if it cannot be stated. */
  nextFree: LocalSlot | null;
  /** The busiest window ends after this session (a later visit was recorded first); the copy says "within W weeks of this class". */
  around?: true;
};

export type PerformCheckinResult =
  | {
      kind: "success";
      record: { id: string; tenantId: string; memberId: string; classInstanceId: string; checkInMethod: string };
      coverage: { kind: "subscription" | "manual" | "pack" | "uncovered_kiosk"; creditsRemaining?: number };
      /**
       * Set when a staff override put the session PAST `Class.maxCapacity`.
       * The check-in succeeded; the caller is expected to say so rather than
       * let the room quietly fill past what the coach planned for.
       */
      overCapacity?: { taken: number; maxCapacity: number };
      /** Gates staff admitted past (T7 "allowance_reached"). Recorded by the route. */
      overrides?: Array<CheckinOverride>;
      /** T7: set when staff admitted past the allowance; the facts the audit row records. */
      overAllowance?: AllowanceFacts;
    }
  | { kind: "class_not_found" }
  | { kind: "class_full"; taken: number; maxCapacity: number }
  | { kind: "class_cancelled" }
  | {
      /** T6b: the class is paused or archived; the member-decided doors refuse. */
      kind: "class_paused";
      className: string;
      state: "paused" | "archived";
    }
  | { kind: "member_not_found" }
  | { kind: "rank_below" }
  | { kind: "rank_above" }
  | { kind: "roster_not_listed" }
  | { kind: "waiver_unsigned" }
  | { kind: "on_hold"; holdUntil: Date | null }
  | { kind: "kids_class" }
  | { kind: "venue_not_covered"; classVenue: string; tierVenue: string }
  | {
      /** T6a: the member's plan is not among the class's memberships. */
      kind: "tier_not_included";
      className: string;
      tierName: string | null;
    }
  | ({
      /** T7: the member's plan allowance is used up for this session's window. */
      kind: "allowance_reached";
      /** True on a staff door: staff may admit after confirming. */
      askable: boolean;
    } & AllowanceFacts)
  | {
      kind: "outside_window";
      when: "before" | "after";
      /** The club's window, so the refusal quotes the setting rather than a hardcoded 30. */
      beforeMin?: number;
      afterMin?: number;
    }
  | { kind: "no_coverage"; billedBy?: string | null }
  | { kind: "duplicate" }
  | { kind: "error"; error: unknown };

/**
 * Exact inverse of the pack redemption written above (lines ~186 / ~247):
 * when an attendance record is deleted, the credit it consumed must go back.
 *
 * ClassPackRedemption.attendanceRecordId is a bare String with no FK, so
 * deleting the AttendanceRecord leaves the redemption row orphaned and the
 * member permanently down one paid credit (audit finding P2-1).
 *
 * MUST be called with the same `tx` as the attendance delete, BEFORE the rows
 * disappear, so restore and delete commit together.
 *
 * Returns the number of credits restored (0 for non-pack check-ins).
 */
export async function restorePackCreditsForAttendance(
  tx: Prisma.TransactionClient,
  attendanceRecordIds: string[],
): Promise<number> {
  if (attendanceRecordIds.length === 0) return 0;

  const redemptions = await tx.classPackRedemption.findMany({
    where: { attendanceRecordId: { in: attendanceRecordIds } },
    select: { id: true, memberPackId: true, memberPack: { select: { status: true } } },
  });
  if (redemptions.length === 0) return 0;

  // The orphaned redemption row always goes, refunded pack or not — the
  // attendance it points at is being deleted, so leaving it behind would
  // corrupt the pack's usage history either way.
  await tx.classPackRedemption.deleteMany({
    where: { id: { in: redemptions.map((r) => r.id) } },
  });

  // One credit back per redemption row (a pack can back more than one of the
  // deleted records, hence the per-row increment rather than a single update).
  //
  // Audit MINOR-3: EXCEPT on a refunded pack. The refund paths
  // (app/api/payments/[id]/refund and the Stripe webhook) set
  // { status: "refunded", creditsRemaining: 0 } — the member already has their
  // money back, so handing them a usable credit as well would be paying them
  // twice for the same class. An EXPIRED pack still gets its credit back: the
  // member paid for it and was not compensated, and expiry is enforced at
  // redemption time anyway, so the restored credit is inert rather than free.
  //
  // The pack's `status` itself is deliberately left untouched in both cases:
  // resurrecting it to "active" would be a billing decision, not an undo.
  let restored = 0;
  for (const r of redemptions) {
    if (r.memberPack?.status === "refunded") continue;
    await tx.memberClassPack.update({
      where: { id: r.memberPackId },
      data: { creditsRemaining: { increment: 1 } },
    });
    restored += 1;
  }

  return restored;
}

/**
 * Seats already taken on this session, and the ceiling, read under a row lock
 * on the Class — `null` when the class has no ceiling.
 *
 * The lock is not decoration. A count followed by an insert is not enough on
 * its own: under READ COMMITTED two members taking the last place both read
 * the same count and both insert. Locking the Class row makes the second wait
 * for the first to commit, then re-count and see the place gone. This is the
 * same mechanism `/api/member/class-subscriptions/[classId]` uses for booking,
 * and it only works because it runs inside the SAME transaction as the
 * AttendanceRecord insert it guards — which is why this is called from inside
 * each creating block rather than once at the top of the handler.
 *
 * The caller is excluded from the count, so a member already on the register
 * is never told their own class is full; that request falls to the P2002
 * duplicate path instead.
 */
async function capacityState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  classId: string,
  classInstanceId: string,
  memberId: string,
): Promise<{ taken: number; maxCapacity: number } | null> {
  const locked = await tx.$queryRaw<{ maxCapacity: number | null }[]>`
    SELECT "maxCapacity"
      FROM "Class"
     WHERE "id" = ${classId} AND "tenantId" = ${tenantId}
     FOR UPDATE
  `;
  const maxCapacity = locked[0]?.maxCapacity ?? null;
  if (maxCapacity === null) return null;
  const taken = await tx.attendanceRecord.count({
    where: { classInstanceId, memberId: { not: memberId } },
  });
  return { taken, maxCapacity };
}

/** Why a class turned a member away on eligibility grounds; null = admitted. */
export type ClassEligibilityRefusal =
  | { kind: "roster_not_listed" }
  | { kind: "tier_not_included"; className: string; tierName: string | null };

/**
 * Class eligibility (owner decision, 20 Oct 2026): the squad list AND the
 * membership list, both enforced, no override. Run INSIDE the write
 * transaction and AFTER the caller has taken the Class row lock. The class
 * PATCH rewrites both lists under the same lock, so a check-in waiting on it
 * is judged against whichever version committed first (the single-member
 * roster routes do not take that lock; a check-in reads their last commit).
 * The member's tier is re-read here too, so the answer honours it at write
 * time.
 *
 * The roster is judged first, so a member failing both reads the roster
 * sentence; then the tier list, which a roster does NOT short-circuit.
 */
async function classEligibility(
  tx: Prisma.TransactionClient,
  tenantId: string,
  memberId: string,
  classId: string,
  className: string,
): Promise<ClassEligibilityRefusal | null> {
  const rosterCount = await tx.classRoster.count({ where: { tenantId, classId } });
  if (rosterCount > 0) {
    const onRoster = await tx.classRoster.findUnique({
      where: { classId_memberId: { classId, memberId }, tenantId },
      select: { id: true },
    });
    if (!onRoster) return { kind: "roster_not_listed" };
  }
  const rows = await tx.classMembershipTier.findMany({
    where: { tenantId, classId },
    select: { tierId: true },
  });
  if (rows.length === 0) return null;
  const member = await tx.member.findFirst({
    where: { id: memberId, tenantId },
    select: { membershipTierId: true, membershipTier: { select: { name: true } } },
  });
  const covered = classTierCovers({
    allowedTierIds: rows.map((r) => r.tierId),
    memberTierId: member?.membershipTierId ?? null,
  });
  if (covered) return null;
  return { kind: "tier_not_included", className, tierName: member?.membershipTier?.name ?? null };
}

/**
 * Class eligibility for a staff door that marks without performCheckin (the
 * coach tick route): takes the Class row lock itself, then runs the same
 * roster + tier check as every other door. Refuse-only — there is no
 * confirmation that admits past it.
 */
export async function lockedClassEligibility(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; memberId: string },
  classId: string,
  className: string,
): Promise<ClassEligibilityRefusal | null> {
  await tx.$queryRaw`
    SELECT "id" FROM "Class" WHERE "id" = ${classId} AND "tenantId" = ${args.tenantId} FOR UPDATE
  `;
  return classEligibility(tx, args.tenantId, args.memberId, classId, className);
}

export type AllowanceGateState =
  | { kind: "open"; overridden: false }
  | ({ kind: "open"; overridden: true } & { facts: AllowanceFacts })
  | { kind: "duplicate" }
  | { kind: "member_not_found" }
  | ({ kind: "allowance_reached"; askable: boolean } & AllowanceFacts);

/**
 * The columns of the Member row the gates and the coverage decision read
 * before the write transaction. The Member lock re-reads them (dates as epoch
 * milliseconds, the same convention statement C uses), so a change committed
 * between that read and the lock is seen and the check-in restarts.
 */
export type GateMemberView = {
  membershipTierId: string | null;
  paymentStatus: string | null;
  stripeSubscriptionId: string | null;
  nextDueAt: Date | null;
  holdUntil: Date | null;
  waiverAccepted: boolean | null;
  accountType: string | null;
};

type MemberLockRow = {
  id: string;
  membershipTierId?: string | null;
  paymentStatus?: string | null;
  stripeSubscriptionId?: string | null;
  nextDueAtMs?: number | null;
  holdUntilMs?: number | null;
  waiverAccepted?: boolean | null;
  accountType?: string | null;
};

/**
 * Thrown inside a write transaction when the Member row changed between the
 * pre-transaction read and the Member lock. performCheckin rolls the attempt
 * back (nothing was written yet) and runs the whole check-in again, so every
 * gate is judged on the row as it stands under the lock.
 */
export class MemberChangedMidCheckin extends Error {
  constructor() {
    super("The member's plan, payment or hold changed during the check-in");
    this.name = "MemberChangedMidCheckin";
  }
}

/** How many times a check-in restarts on MemberChangedMidCheckin before it answers "error". */
const MEMBER_CHANGED_RESTARTS = 2;

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/**
 * True when the locked row differs from the pre-transaction read on any
 * column a gate or the coverage decision used. A column the lock row does not
 * carry is not compared (the SELECT below always carries all of them).
 */
export function memberChangedSince(pre: GateMemberView, locked: MemberLockRow): boolean {
  const pairs: Array<[keyof MemberLockRow, unknown]> = [
    ["membershipTierId", pre.membershipTierId ?? null],
    ["paymentStatus", pre.paymentStatus ?? null],
    ["stripeSubscriptionId", pre.stripeSubscriptionId ?? null],
    ["nextDueAtMs", ms(pre.nextDueAt)],
    ["holdUntilMs", ms(pre.holdUntil)],
    ["waiverAccepted", pre.waiverAccepted ?? null],
    ["accountType", pre.accountType ?? null],
  ];
  for (const [key, before] of pairs) {
    if (!(key in locked)) continue;
    const raw = locked[key];
    const now = raw === undefined || raw === null ? null : typeof raw === "string" && key.endsWith("Ms") ? Number(raw) : raw;
    if (now !== before) return true;
  }
  return false;
}

/**
 * The Member row lock: the second lock of every check-in write transaction,
 * always after the Class lock. Taken whatever the plan and the door (see the
 * header: a conditional lock cannot serialise against a check-in that read
 * "Unlimited" a moment before). Null = the member is not in this club (or was
 * deleted first), and nothing is written. The row comes back with the columns
 * the gates read, for memberChangedSince.
 *
 * Strength: FOR NO KEY UPDATE, the row-write lock an ordinary UPDATE takes.
 * The owner decision (17 Oct 2026) said "FOR UPDATE"; NO KEY UPDATE gives the
 * same serialisation between check-ins (it conflicts with itself, with every
 * UPDATE and with DELETE), and differs in one way only: it does NOT conflict
 * with the FOR KEY SHARE that every foreign-key insert referencing this member
 * takes (an imported attendance row, a roster row, a booking, an undo). With
 * FOR UPDATE such an insert would wait on a check-in, and a transaction that
 * inserted for this member and then touched the class's row (an attendance
 * import creating a session, an undo batch) would deadlock with a check-in
 * holding the Class row. The member-deletion cascade still waits (its lock
 * and its DELETE are FOR UPDATE).
 */
async function memberLock(tx: Prisma.TransactionClient, tenantId: string, memberId: string): Promise<MemberLockRow | null> {
  const rows = await tx.$queryRaw<MemberLockRow[]>`
    SELECT "id", "membershipTierId", "paymentStatus", "stripeSubscriptionId",
           (EXTRACT(EPOCH FROM "nextDueAt") * 1000)::float8 AS "nextDueAtMs",
           (EXTRACT(EPOCH FROM "holdUntil") * 1000)::float8 AS "holdUntilMs",
           "waiverAccepted", "accountType"
      FROM "Member" WHERE "id" = ${memberId} AND "tenantId" = ${tenantId} FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * T7 allowance judgement, run INSIDE the write transaction, AFTER the Class
 * lock, the tier gate and the Member lock, BEFORE any pack decrement or
 * insert: statement C (readAllowanceSnapshot) gives the plan's allowance,
 * whether the member is already in this session, and their counted visits,
 * from one snapshot taken after the lock; the verdict is decided in
 * TypeScript. A member already in this session answers "duplicate" before the
 * allowance, so a double tap says "already checked in", never "allowance used".
 */
async function judgeAllowance(
  tx: Prisma.TransactionClient,
  args: Pick<PerformCheckinArgs, "tenantId" | "memberId" | "allowanceGate" | "allowanceOverrideConfirmed">,
  session: { id: string; date: Date; startTime: string },
): Promise<AllowanceGateState> {
  const mode = args.allowanceGate ?? "off";
  if (mode === "off") return { kind: "open", overridden: false };
  const snap = await readAllowanceSnapshot(tx, {
    tenantId: args.tenantId,
    memberId: args.memberId,
    centre: session.date,
    currentInstanceId: session.id,
  });
  if (!snap) return { kind: "member_not_found" };
  if (snap.alreadyIn) return { kind: "duplicate" };
  if (!snap.allowance) return { kind: "open", overridden: false };
  const v = allowanceVerdict(snap.allowance, slotMinute(session), snap.visits);
  if (!v.exhausted) return { kind: "open", overridden: false };
  const facts: AllowanceFacts = {
    used: v.used, limit: v.limit, weeks: v.weeks, nextFree: v.nextFree,
    ...(v.around ? { around: true as const } : {}),
  };
  if (mode === "ask" && args.allowanceOverrideConfirmed === true) return { kind: "open", overridden: true, facts };
  return { kind: "allowance_reached", askable: mode === "ask", ...facts };
}

/**
 * T7 for a staff door that marks without performCheckin (the coach tick
 * route): the Member lock, then the allowance in "ask" mode. MUST be called
 * after lockedClassEligibility in the same transaction, so the Class lock is
 * already held and the order stays Class, then Member.
 */
export async function staffAllowanceAsk(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; memberId: string; confirmed: boolean },
  session: { id: string; date: Date; startTime: string },
): Promise<AllowanceGateState> {
  if (!(await memberLock(tx, args.tenantId, args.memberId))) return { kind: "member_not_found" };
  return judgeAllowance(
    tx,
    { tenantId: args.tenantId, memberId: args.memberId, allowanceGate: "ask", allowanceOverrideConfirmed: args.confirmed },
    session,
  );
}

/**
 * Spend one credit of the member's usable pack (earliest expiry first), or
 * null when there is none. The decrement is a single guarded UPDATE, so two
 * concurrent check-ins can never both take the last credit (security audit
 * iteration 2 / M10). Called after the Member lock: Class, Member, pack.
 */
async function claimPack(
  tx: Prisma.TransactionClient,
  tenantId: string,
  memberId: string,
): Promise<{ id: string; creditsRemaining: number } | null> {
  const pack = await tx.memberClassPack.findFirst({
    where: {
      memberId,
      tenantId,
      status: "active",
      creditsRemaining: { gt: 0 },
      expiresAt: { gt: new Date() },
    },
    orderBy: { expiresAt: "asc" },
    select: { id: true },
  });
  if (!pack) return null;
  // updateMany returns count=0 if a concurrent request beat us to it.
  const claimed = await tx.memberClassPack.updateMany({
    where: { id: pack.id, creditsRemaining: { gt: 0 } },
    data: { creditsRemaining: { decrement: 1 } },
  });
  if (claimed.count === 0) return null;
  const refreshed = await tx.memberClassPack.findUnique({
    where: { id: pack.id },
    select: { creditsRemaining: true },
  });
  return { id: pack.id, creditsRemaining: refreshed?.creditsRemaining ?? 0 };
}

/** The overrides and facts a success carries for the route to record. */
function overrideFields(allowance: AllowanceGateState): {
  overrides?: CheckinOverride[];
  overAllowance?: AllowanceFacts;
} {
  const overrides: CheckinOverride[] = [];
  const allowanceOverridden = allowance.kind === "open" && allowance.overridden;
  if (allowanceOverridden) overrides.push(ALLOWANCE_OVERRIDE_REASON);
  return {
    ...(overrides.length > 0 ? { overrides } : {}),
    ...(allowanceOverridden ? { overAllowance: allowance.facts } : {}),
  };
}

/**
 * Never throws: a failure on any read or write becomes { kind: "error" },
 * logged once, so every door (desk, kiosk, card, register) answers with its own
 * sentence instead of a bare 500 (connection register gap 2, 30 Sep 2026).
 */
export async function performCheckin(args: PerformCheckinArgs): Promise<PerformCheckinResult> {
  try {
    // R-ALLOW rule 2: a plan, payment or hold change that committed between
    // the pre-transaction read and the Member lock restarts the check-in, so
    // every gate is judged on the row as it stands under the lock.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await performCheckinUnguarded(args);
      } catch (e: unknown) {
        if (e instanceof MemberChangedMidCheckin && attempt < MEMBER_CHANGED_RESTARTS) continue;
        throw e;
      }
    }
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") return { kind: "duplicate" };
    console.error("[checkin] unexpected failure", e);
    Sentry.captureException(e, { tags: { area: "checkin" } });
    return { kind: "error", error: e };
  }
}

async function performCheckinUnguarded(args: PerformCheckinArgs): Promise<PerformCheckinResult> {
  const { tenantId, memberId, classInstanceId, method } = args;

  // Validate the class instance belongs to this tenant + load rank requirements + tenant config.
  const { instance, tenant } = await withTenantContext(tenantId, async (tx) => {
    const i = await tx.classInstance.findFirst({
      where: { id: classInstanceId, class: { tenantId } },
      include: {
        class: {
          include: {
            // `timezone` is what turns "18:00" into an instant. Without it the
            // window below resolved in the SERVER's zone — UTC on Vercel — so a
            // London club's check-in opened an hour late for the seven months of
            // British Summer Time. The column has always existed and was read by
            // nothing.
            tenant: { select: { checkinWindowBeforeMin: true, checkinWindowAfterMin: true, timezone: true } },
            requiredRank: { select: { order: true } },
            maxRank: { select: { order: true } },
            // Venue gate (ADR-001 D2 slice 2): the class's venue name for the refusal copy.
            locationRef: { select: { name: true } },
          },
        },
      },
    });
    return { instance: i, tenant: i?.class.tenant ?? null };
  });
  // A session an attendance-history import created is a record of the past,
  // not a class anyone can be checked into (3 Oct 2026): not found, whatever
  // the method — the desk and card paths do not enforce the time window.
  if (!instance || instance.sourceImportJobId || instance.class.sourceImportJobId) return { kind: "class_not_found" };
  if (instance.isCancelled) return { kind: "class_cancelled" };
  // T6b: a paused or archived class's sessions are kept (history, bookings)
  // but are not a class a member can walk into on their own say-so.
  if (args.enforceClassStateGate && (!instance.class.isActive || instance.class.deletedAt)) {
    // A class archived before T6b carries no deletedAt; doorLifecycle reads
    // it as archived (as the timetable does) so the sentence stays true.
    const cls = instance.class;
    const state = cls.deletedAt
      ? "archived"
      : await withTenantContext(tenantId, (tx) => doorLifecycle(tx, tenantId, cls));
    return {
      kind: "class_paused",
      className: cls.name,
      state: state === "archived" ? "archived" : "paused",
    };
  }

  // Rank gate.
  if (args.enforceRankGate && (instance.class.requiredRankId || instance.class.maxRankId)) {
    const memberRank = await withTenantContext(tenantId, (tx) =>
      tx.memberRank.findFirst({
        where: { memberId },
        orderBy: { rankSystem: { order: "desc" } },
        select: { rankSystem: { select: { order: true } } },
      }),
    );
    const memberOrder = memberRank?.rankSystem.order ?? null;
    if (instance.class.requiredRankId && instance.class.requiredRank) {
      // Unranked members fail-closed against requiredRank.
      if (memberOrder === null || memberOrder < instance.class.requiredRank.order) {
        return { kind: "rank_below" };
      }
    }
    if (instance.class.maxRankId && instance.class.maxRank && memberOrder !== null) {
      if (memberOrder > instance.class.maxRank.order) {
        return { kind: "rank_above" };
      }
    }
  }

  // The roster (squad list) gate is not here: it runs for every method under
  // the Class row lock, beside the tier gate (classEligibility).

  // Time window gate.
  if (args.enforceTimeWindow) {
    const now = new Date();
    // The club's zone, not the server's. Falls back to the same value
    // `Tenant.timezone` defaults to in the schema, so a tenant row that somehow
    // carries no zone behaves as a UK club rather than as UTC.
    const zone = tenant?.timezone || DEFAULT_TIMEZONE;
    const startsAt = parseTime(instance.startTime, instance.date, zone);
    // A session with no recorded end (imported history) closes its window
    // from the start: nothing is checked into it after the fact.
    const endsAt = instance.endTime === null ? startsAt : parseTime(instance.endTime, instance.date, zone);
    const beforeMin = tenant?.checkinWindowBeforeMin ?? 30;
    const afterMin = tenant?.checkinWindowAfterMin ?? 30;
    const windowOpen = new Date(startsAt.getTime() - beforeMin * 60_000);
    const windowClose = new Date(endsAt.getTime() + afterMin * 60_000);
    if (now < windowOpen || now > windowClose) {
      // Distinguish "too early" from "already finished" so the door tablet can
      // say the true thing — the same message for both used to tell a member
      // whose class had ENDED to "check back closer to class time".
      return { kind: "outside_window", when: now < windowOpen ? "before" : "after", beforeMin, afterMin };
    }
  }

  // Coverage decision. The member row is read once and the waiver gate rides
  // on the same read, so the hard block costs no extra query.
  const memberRecord = await withTenantContext(tenantId, (tx) =>
    tx.member.findUnique({
      where: { id: memberId },
      select: {
        paymentStatus: true, stripeSubscriptionId: true, waiverAccepted: true, holdUntil: true, membershipTierId: true, nextDueAt: true,
        accountType: true, billedBy: true,
        membershipTier: { select: { locationId: true, locationRef: { select: { name: true } } } },
      },
    }),
  );
  if (!memberRecord) return { kind: "member_not_found" };

  // Venue gate. A tier bound to one venue does not cover a class held at
  // another; both names travel with the refusal so the tablet can say so.
  if (args.enforceVenueGate) {
    const classVenueId = instance.class.locationId ?? null;
    const tierVenueId = memberRecord.membershipTier?.locationId ?? null;
    if (classVenueId && tierVenueId && classVenueId !== tierVenueId) {
      return {
        kind: "venue_not_covered",
        classVenue: instance.class.locationRef?.name ?? "another venue",
        tierVenue: memberRecord.membershipTier?.locationRef?.name ?? "your venue",
      };
    }
  }

  // Kids gate. An adult may not put themselves into a kids class; juniors
  // (13–17) and children may. The member here is whoever is being checked in,
  // so a parent checking in their child is judged as the child.
  if (args.enforceKidsGate && instance.class.isKids && isAdultAccount(memberRecord.accountType)) {
    return { kind: "kids_class" };
  }

  // Hold gate. A membership on hold is not training; the refusal names the
  // date so the tablet can say when they are back.
  if (args.enforceHoldGate && isOnHold(memberRecord, new Date())) {
    return { kind: "on_hold", holdUntil: memberRecord.holdUntil ?? null };
  }

  // Waiver gate. Before every write path below — the pack-redeeming branch
  // included, so a refusal can never cost the member a paid credit — and
  // fail-closed: the flag is a non-null boolean in the schema, and anything
  // that is not exactly `true` is treated as unsigned.
  if (args.enforceWaiverGate && memberRecord.waiverAccepted !== true) {
    return { kind: "waiver_unsigned" };
  }

  const hasActiveSubscription =
    !!memberRecord.stripeSubscriptionId && memberRecord.paymentStatus === "paid";
  // Club-life finding F-L5-1 (CLUBLIFE-CATALOGUE C5.03): coverage used to mean
  // "a Stripe subscription or a pack", so a member paying at the desk was
  // told to buy a pack on the portal while the kiosk admitted them. A desk
  // membership counts too — a tier assigned (the schema default "paid" on
  // its own is not enough), paid or comped, and not overdue by the derived
  // rule in lib/overdue.ts, which is the same rule the members list uses.
  const hasDeskMembership =
    !hasActiveSubscription &&
    !!memberRecord.membershipTierId &&
    // "pending" (No payment yet) is a member the desk has just added: their
  // first class is normal, so the door treats them as it did when every new
  // member was stamped "paid" (brief, 30 Sep 2026 — do not refuse at the door).
  (memberRecord.paymentStatus === "paid" || memberRecord.paymentStatus === "free" || memberRecord.paymentStatus === "pending") &&
    !isOverdue(memberRecord, new Date());
  const covered = hasActiveSubscription || hasDeskMembership;

  // The columns the gates above were judged on, re-checked under the Member
  // lock inside each write transaction (R-ALLOW rule 2).
  const gateView: GateMemberView = {
    membershipTierId: memberRecord.membershipTierId ?? null,
    paymentStatus: memberRecord.paymentStatus ?? null,
    stripeSubscriptionId: memberRecord.stripeSubscriptionId ?? null,
    nextDueAt: memberRecord.nextDueAt ?? null,
    holdUntil: memberRecord.holdUntil ?? null,
    waiverAccepted: memberRecord.waiverAccepted ?? null,
    accountType: memberRecord.accountType ?? null,
  };
  /** The Member lock, second in the order; restarts the check-in if the row moved. */
  const lockMember = async (tx: Prisma.TransactionClient): Promise<boolean> => {
    const locked = await memberLock(tx, tenantId, memberId);
    if (!locked) return false;
    if (memberChangedSince(gateView, locked)) throw new MemberChangedMidCheckin();
    return true;
  };

  try {
    if (args.requireCoverage && !covered) {
      // Not covered by the plan (member app, parent): a class pack pays, or
      // nothing does. A check-in a pack pays for is not counted against the
      // plan allowance (owner decision), so it is not gated.
      const result = await withTenantContext(tenantId, async (tx) => {
        // Capacity first — inside this transaction, before a credit is spent.
        // Refusing after the decrement would cost the member a class they
        // never attended.
        const cap = await capacityState(tx, tenantId, instance.classId, classInstanceId, memberId);
        // Roster + tier after the lock and before a credit is spent.
        const refused = await classEligibility(tx, tenantId, memberId, instance.classId, instance.class.name);
        if (refused) return refused;
        if (cap && args.enforceCapacity && cap.taken >= cap.maxCapacity) {
          return { kind: "class_full" as const, ...cap };
        }
        // T7: the Member lock, second in the order, then the pack.
        if (!(await lockMember(tx))) return { kind: "member_not_found" as const };
        const pack = await claimPack(tx, tenantId, memberId);
        if (!pack) return { kind: "no_coverage" as const };
        const record = await tx.attendanceRecord.create({
          data: {
            tenantId,
            memberId,
            classInstanceId,
            checkInMethod: method,
            checkedInById: args.checkedInByUserId ?? null,
          },
        });
        await tx.classPackRedemption.create({
          data: { memberPackId: pack.id, attendanceRecordId: record.id },
        });
        return {
          kind: "pack_redeemed" as const,
          record,
          creditsRemaining: pack.creditsRemaining,
          overCapacity: cap && cap.taken >= cap.maxCapacity ? cap : undefined,
        };
      });

      if (result.kind === "tier_not_included" || result.kind === "roster_not_listed") return result;
      if (result.kind === "member_not_found") return { kind: "member_not_found" };
      if (result.kind === "class_full") {
        return { kind: "class_full", taken: result.taken, maxCapacity: result.maxCapacity };
      }
      // TeamUp bridge: a member TeamUp bills who has no plan set here (two
      // plans at TeamUp, a plan label with no tier, a scheduled start) must
      // not be told to buy a pack — the desk decides (teamup-2, 2 Oct 2026).
      if (result.kind === "no_coverage") return { kind: "no_coverage", billedBy: memberRecord.billedBy ?? null };
      return {
        kind: "success",
        record: result.record,
        coverage: { kind: "pack", creditsRemaining: result.creditsRemaining },
        ...(result.overCapacity ? { overCapacity: result.overCapacity } : {}),
      };
    }

    // Coverage not required (admin / kiosk / auto) OR the plan covers the
    // member. One transaction decides who pays and records it:
    //  - the kiosk, for a member the plan does not cover, spends a usable pack
    //    first (as it always has, so credits do not pile up): not counted, not
    //    gated - the same answer the member app gives that member;
    //  - otherwise the visit is counted against the allowance; on a refusing
    //    door (member app, kiosk) a used-up allowance falls through to a
    //    usable pack, which pays instead and is not counted;
    //  - staff doors (register, card scanner) never spend a pack: they ask.
    const kioskPackFirst = method === "kiosk" && !covered;
    const straight = await withTenantContext(tenantId, async (tx) => {
      const cap = await capacityState(tx, tenantId, instance.classId, classInstanceId, memberId);
      const refused = await classEligibility(tx, tenantId, memberId, instance.classId, instance.class.name);
      if (refused) return refused;
      if (cap && args.enforceCapacity && cap.taken >= cap.maxCapacity) {
        return { kind: "class_full" as const, ...cap };
      }
      // T7: Member lock, then the pack or the allowance, then the insert.
      if (!(await lockMember(tx))) return { kind: "member_not_found" as const };
      let pack = kioskPackFirst ? await claimPack(tx, tenantId, memberId) : null;
      let allowance: AllowanceGateState = { kind: "open", overridden: false };
      if (!pack) {
        allowance = await judgeAllowance(tx, args, instance);
        if (allowance.kind === "member_not_found" || allowance.kind === "duplicate") return allowance;
        if (allowance.kind === "allowance_reached") {
          if (!allowance.askable) pack = await claimPack(tx, tenantId, memberId);
          if (!pack) return allowance;
          allowance = { kind: "open", overridden: false };
        }
      }
      const created = await tx.attendanceRecord.create({
        data: {
          tenantId,
          memberId,
          classInstanceId,
          checkInMethod: method,
          checkedInById: args.checkedInByUserId ?? null,
        },
      });
      if (pack) {
        await tx.classPackRedemption.create({
          data: { memberPackId: pack.id, attendanceRecordId: created.id },
        });
      }
      return {
        kind: "created" as const,
        record: created,
        // A staff override that took the room past its ceiling. The check-in
        // stands; the caller says so.
        overCapacity: cap && cap.taken >= cap.maxCapacity ? cap : undefined,
        allowance,
        pack,
      };
    });
    if (straight.kind === "tier_not_included" || straight.kind === "roster_not_listed") return straight;
    if (straight.kind === "member_not_found") return { kind: "member_not_found" };
    if (straight.kind === "duplicate") return { kind: "duplicate" };
    if (straight.kind === "allowance_reached") {
      const { kind, askable, used, limit, weeks, nextFree, around } = straight;
      return { kind, askable, used, limit, weeks, nextFree, ...(around ? { around } : {}) };
    }
    if (straight.kind === "class_full") {
      return { kind: "class_full", taken: straight.taken, maxCapacity: straight.maxCapacity };
    }
    const record = straight.record;
    const overCapacity = straight.overCapacity;
    const overrides = overrideFields(straight.allowance);

    if (straight.pack) {
      return {
        kind: "success",
        record,
        coverage: { kind: "pack", creditsRemaining: straight.pack.creditsRemaining },
        ...(overCapacity ? { overCapacity } : {}),
        ...overrides,
      };
    }
    if (method === "kiosk" && !hasActiveSubscription) {
      return {
        kind: "success",
        record,
        coverage: { kind: "uncovered_kiosk" },
        ...(overCapacity ? { overCapacity } : {}),
        ...overrides,
      };
    }

    return {
      kind: "success",
      record,
      coverage: { kind: hasActiveSubscription ? "subscription" : "manual" },
      ...(overCapacity ? { overCapacity } : {}),
      ...overrides,
    };
  } catch (e: unknown) {
    // Not a failure: performCheckin restarts the whole check-in.
    if (e instanceof MemberChangedMidCheckin) throw e;
    if ((e as { code?: string }).code === "P2002") return { kind: "duplicate" };
    // Connection register gap 2 (30 Sep 2026): every door answered a 500 and
    // nothing was logged, so a check-in outage was invisible. Logged once
    // here, for the staff, kiosk, card and register doors alike.
    console.error("[checkin] unexpected failure", e);
    Sentry.captureException(e, { tags: { area: "checkin" } });
    return { kind: "error", error: e };
  }
}
