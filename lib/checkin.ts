// Shared check-in business rules — single source of truth for both the staff
// route (`POST /api/checkin`) and the public kiosk route
// (`POST /api/kiosk/[token]/checkin`).
//
// Behaviour matrix (set by the caller):
//
//   method   enforceRankGate  enforceRosterGate  enforceTimeWindow  requireCoverage  enforceCapacity  enforceWaiverGate
//   ------   ---------------  -----------------  -----------------  ---------------  ---------------  -----------------
//   admin    false            false              false              false            false            false  (staff override — bypass all gates)
//   self     true             true               true               true             true             true   (member self-serve)
//   auto     false            false              false              false            false            false  (cron / system)
//   kiosk    true             true               true               false            true             true   (iPad at the door — respects window, forgiving on subs)
//
//   enforceHoldGate (a membership on hold, lib/member-hold.ts) follows the
//   waiver column: self and kiosk refuse, staff paths admit. enforceKidsGate
//   (an adult into a `Class.isKids` class) follows the same line.
//   qr       false            false              false              false            false            false  (a coach scanning a card IS the staff override)
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
  // Task 10: enforce per-class allow-list (ClassRoster). When the class has any
  // roster rows, the member must be on the roster. Same enforcement profile as
  // rank gate (admin bypasses; self+kiosk enforce).
  enforceRosterGate: boolean;
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
  // Staff user id when method=admin (the person clicking "check in" in the
  // dashboard). Null/undefined for self / kiosk / auto / system.
  checkedInByUserId?: string | null;
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
    }
  | { kind: "class_not_found" }
  | { kind: "class_full"; taken: number; maxCapacity: number }
  | { kind: "class_cancelled" }
  | { kind: "member_not_found" }
  | { kind: "rank_below" }
  | { kind: "rank_above" }
  | { kind: "roster_not_listed" }
  | { kind: "waiver_unsigned" }
  | { kind: "on_hold"; holdUntil: Date | null }
  | { kind: "kids_class" }
  | { kind: "venue_not_covered"; classVenue: string; tierVenue: string }
  | {
      kind: "outside_window";
      when: "before" | "after";
      /** The club's window, so the refusal quotes the setting rather than a hardcoded 30. */
      beforeMin?: number;
      afterMin?: number;
    }
  | { kind: "no_coverage" }
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

/**
 * Never throws: a failure on any read or write becomes { kind: "error" },
 * logged once, so every door (desk, kiosk, card, register) answers with its own
 * sentence instead of a bare 500 (connection register gap 2, 30 Sep 2026).
 */
export async function performCheckin(args: PerformCheckinArgs): Promise<PerformCheckinResult> {
  try {
    return await performCheckinUnguarded(args);
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
  if (!instance) return { kind: "class_not_found" };
  if (instance.isCancelled) return { kind: "class_cancelled" };

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

  // Task 10: roster gate. If the class has any ClassRoster rows AND the caller
  // requested enforcement, the member must be on the roster.
  if (args.enforceRosterGate) {
    const rosterCount = await withTenantContext(tenantId, (tx) =>
      tx.classRoster.count({ where: { classId: instance.classId } }),
    );
    if (rosterCount > 0) {
      const onRoster = await withTenantContext(tenantId, (tx) =>
        tx.classRoster.findUnique({
          where: { classId_memberId: { classId: instance.classId, memberId } },
          select: { id: true },
        }),
      );
      if (!onRoster) return { kind: "roster_not_listed" };
    }
  }

  // Time window gate.
  if (args.enforceTimeWindow) {
    const now = new Date();
    // The club's zone, not the server's. Falls back to the same value
    // `Tenant.timezone` defaults to in the schema, so a tenant row that somehow
    // carries no zone behaves as a UK club rather than as UTC.
    const zone = tenant?.timezone || DEFAULT_TIMEZONE;
    const startsAt = parseTime(instance.startTime, instance.date, zone);
    const endsAt = parseTime(instance.endTime, instance.date, zone);
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
        accountType: true,
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

  try {
    if (args.requireCoverage && !covered) {
      // Try to redeem a class pack atomically. The decrement must be a single
      // guarded UPDATE so two concurrent check-ins for the same member can't
      // both see `creditsRemaining: 1`, both pass the gt:0 check, and both
      // decrement → -1. (Security audit iteration 2 / M10, 2026-05-07.)
      const result = await withTenantContext(tenantId, async (tx) => {
        // Capacity first — inside this transaction, before a credit is spent.
        // Refusing after the decrement would cost the member a class they
        // never attended.
        const cap = await capacityState(tx, tenantId, instance.classId, classInstanceId, memberId);
        if (cap && args.enforceCapacity && cap.taken >= cap.maxCapacity) {
          return { kind: "class_full" as const, ...cap };
        }

        // Find a candidate (which pack to attempt) — earliest expiry first.
        const activePack = await tx.memberClassPack.findFirst({
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
        if (!activePack) return { kind: "no_coverage" as const };

        // Atomic guard: only decrement if creditsRemaining is still > 0.
        // updateMany returns count=0 if a concurrent request beat us to it.
        const claimed = await tx.memberClassPack.updateMany({
          where: { id: activePack.id, creditsRemaining: { gt: 0 } },
          data: { creditsRemaining: { decrement: 1 } },
        });
        if (claimed.count === 0) {
          // Race lost — someone else exhausted the credits between findFirst
          // and updateMany. Member has no other usable pack at this moment.
          return { kind: "no_coverage" as const };
        }

        // Read back the new value for the caller's response.
        const refreshed = await tx.memberClassPack.findUnique({
          where: { id: activePack.id },
          select: { creditsRemaining: true },
        });
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
          data: { memberPackId: activePack.id, attendanceRecordId: record.id },
        });
        return {
          kind: "pack_redeemed" as const,
          record,
          creditsRemaining: refreshed?.creditsRemaining ?? 0,
          overCapacity: cap && cap.taken >= cap.maxCapacity ? cap : undefined,
        };
      });

      if (result.kind === "class_full") {
        return { kind: "class_full", taken: result.taken, maxCapacity: result.maxCapacity };
      }
      if (result.kind === "no_coverage") return { kind: "no_coverage" };
      return {
        kind: "success",
        record: result.record,
        coverage: { kind: "pack", creditsRemaining: result.creditsRemaining },
        ...(result.overCapacity ? { overCapacity: result.overCapacity } : {}),
      };
    }

    // Coverage not required (admin / kiosk / auto) OR an active subscription
    // is on file — record straight.
    const straight = await withTenantContext(tenantId, async (tx) => {
      const cap = await capacityState(tx, tenantId, instance.classId, classInstanceId, memberId);
      if (cap && args.enforceCapacity && cap.taken >= cap.maxCapacity) {
        return { kind: "class_full" as const, ...cap };
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
      return {
        kind: "created" as const,
        record: created,
        // A staff override that took the room past its ceiling. The check-in
        // stands; the caller says so.
        overCapacity: cap && cap.taken >= cap.maxCapacity ? cap : undefined,
      };
    });
    if (straight.kind === "class_full") {
      return { kind: "class_full", taken: straight.taken, maxCapacity: straight.maxCapacity };
    }
    const record = straight.record;
    const overCapacity = straight.overCapacity;

    // Pack-redeem opportunistically for kiosk path so credits don't pile up
    // when a member already has a pack but no subscription.
    //
    // Concurrency: same atomic guard as the self/requireCoverage path above —
    // updateMany with creditsRemaining gt:0 prevents two simultaneous kiosk
    // check-ins from both decrementing the same pack to -1.
    if (method === "kiosk" && !hasActiveSubscription) {
      const packResult = await withTenantContext(tenantId, async (tx) => {
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
        const claimed = await tx.memberClassPack.updateMany({
          where: { id: pack.id, creditsRemaining: { gt: 0 } },
          data: { creditsRemaining: { decrement: 1 } },
        });
        if (claimed.count === 0) return null; // race lost — pack exhausted by another concurrent kiosk check-in
        const refreshed = await tx.memberClassPack.findUnique({
          where: { id: pack.id },
          select: { creditsRemaining: true },
        });
        await tx.classPackRedemption.create({
          data: { memberPackId: pack.id, attendanceRecordId: record.id },
        });
        return { creditsRemaining: refreshed?.creditsRemaining ?? 0 };
      });
      if (packResult) {
        return {
          kind: "success",
          record,
          coverage: { kind: "pack", creditsRemaining: packResult.creditsRemaining },
          ...(overCapacity ? { overCapacity } : {}),
        };
      }
      return {
        kind: "success",
        record,
        coverage: { kind: "uncovered_kiosk" },
        ...(overCapacity ? { overCapacity } : {}),
      };
    }

    return {
      kind: "success",
      record,
      coverage: { kind: hasActiveSubscription ? "subscription" : "manual" },
      ...(overCapacity ? { overCapacity } : {}),
    };
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") return { kind: "duplicate" };
    // Connection register gap 2 (30 Sep 2026): every door answered a 500 and
    // nothing was logged, so a check-in outage was invisible. Logged once
    // here, for the staff, kiosk, card and register doors alike.
    console.error("[checkin] unexpected failure", e);
    Sentry.captureException(e, { tags: { area: "checkin" } });
    return { kind: "error", error: e };
  }
}
