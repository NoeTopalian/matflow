import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { snapshotDiff } from "@/lib/audit-snapshot";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { scheduleSchema, allowedTierIdsSchema } from "@/lib/schemas/class";
import { classTierCovers } from "@/lib/class-tier-gate";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker, scheduleStartMarker } from "@/lib/today-sessions";
import { dayMarkerUtc, usableTimezone } from "@/lib/class-time";
import { classRefError, CLASS_REF_ERRORS } from "@/lib/class-refs";
import { classLifecycle, IMPORTED_CLASS_REACTIVATE_REFUSAL } from "@/lib/class-live";
import { mintUpcomingSessions } from "@/lib/class-lifecycle";

/** A tier vanished between the pre-flight and the write: roll the edit back. */
class TierRefError extends Error {}

const rosterEntrySchema = z.object({ memberId: z.string().min(1) });

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  coachName: z.string().max(100).optional().nullable(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  // ADR-001 D2: the venue. Must be one of this club's locations; null = all.
  locationId: z.string().min(1).max(64).optional().nullable(),
  duration: z.number().int().min(1).max(480).optional(),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  // T6b lifecycle: `false` PAUSES the class (hidden from the timetable,
  // booking, member app and kiosk; no new sessions; history and bookings
  // kept). `true` RESUMES a paused class or RESTORES an archived one: it also
  // clears `deletedAt`. Archiving is DELETE. Refused (409) for a class an
  // attendance-history import created.
  isActive: z.boolean().optional(),
  // A kids class refuses adults at self and kiosk check-in (lib/checkin.ts).
  isKids: z.boolean().optional(),
  // Task 5: optional roster array; mutually exclusive with rank fields at the API layer.
  roster: z.array(rosterEntrySchema).optional(),
  // Task 3c. TimetableManager has been sending this since it was written and
  // Zod stripped it, so `class.updateMany` never touched ClassSchedule, the
  // client merged the OLD rows back into state, and the toast still said
  // "Class updated" — RULES §2, a success message must mean success. There was
  // no PUT/PATCH for ClassSchedule anywhere: a class's day or time could only
  // ever be set at creation time.
  schedules: z.array(scheduleSchema).max(50).optional(),
  // T6a "Who can attend": omitted = unchanged; [] = everyone. Every id must be
  // one of this club's tiers (classRefError) or the whole edit is refused.
  allowedTierIds: allowedTierIdsSchema.optional(),
});

type Params = { params: Promise<{ id: string }> };

type ScheduleInput = z.infer<typeof scheduleSchema>;

type Tx = Parameters<Parameters<typeof withTenantContext>[1]>[0];

/**
 * T6a narrowing cascade: members booked on the class (ClassSubscription) whose
 * plan the NEW membership list does not include. Owner decision 17 Oct 2026:
 * a class with a roster is governed by its roster, so no one loses a booking
 * on tier grounds there; an empty list is open, so no one loses one either.
 * Run in the pre-flight for the dry-run preview, and again INSIDE the write
 * transaction after the Class lock, which is the set actually removed.
 */
async function tierLosers(
  tx: Tx,
  tenantId: string,
  classId: string,
  allowedTierIds: readonly string[],
  hasRosterAfter: boolean,
): Promise<string[]> {
  if (allowedTierIds.length === 0 || hasRosterAfter) return [];
  const subs = await tx.classSubscription.findMany({
    where: { classId, member: { tenantId } },
    select: { memberId: true, member: { select: { membershipTierId: true } } },
  });
  return subs
    .filter((s) => !classTierCovers({ allowedTierIds, memberTierId: s.member.membershipTierId, hasRoster: false }))
    .map((s) => s.memberId);
}

/** Same set of ids, order ignored. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** The class's roster after this edit: a roster body replaces it, a rank gate clears it. */
async function rosterAfterEdit(
  tx: Tx,
  tenantId: string,
  classId: string,
  wantsRoster: boolean,
  wantsRankGate: boolean,
  rosterIds: string[],
): Promise<boolean> {
  if (wantsRoster) return rosterIds.length > 0;
  if (wantsRankGate) return false;
  return (await tx.classRoster.count({ where: { classId, tenantId } })) > 0;
}

/**
 * What a schedule edit did, so the operator can be told rather than guess.
 * RULES §5: a cascade that removes user-visible state must be visible to the
 * user, and it is recorded by id — a count cannot restore anything.
 */
type ScheduleChange = {
  slotsAdded: number;
  slotsRemoved: number;
  /** Upcoming sessions deleted because no active slot matches them any more. */
  instancesRemoved: string[];
  /**
   * Upcoming sessions that no longer match a slot but were KEPT because members
   * have already checked in or joined their waitlist. Deleting those would
   * destroy a register; they are surfaced so staff can cancel them by hand.
   */
  instancesKept: string[];
  /** Sessions minted for the new slots, so check-in works from now, not from the next cron run. */
  instancesCreated: number;
};

/** A slot's identity for diffing. Day + both times — a 30-minute change is a different slot. */
const slotKey = (s: { dayOfWeek: number; startTime: string; endTime: string }) =>
  `${s.dayOfWeek}|${s.startTime}|${s.endTime}`;

/**
 * Bring ClassSchedule into line with `desired`, then reconcile the
 * ClassInstance rows those slots had already generated.
 *
 * The instance half is not optional. `/api/member/schedule` joins instances to
 * the timetable grid by `${classId}-${startTime}`, so moving a class from 18:00
 * to 19:00 orphans every instance already generated: the member sees the class
 * at its new time with no `classInstanceId`, and check-in silently disappears —
 * the same failure as task 3a, reached in one click instead of four weeks.
 *
 * Removal is conservative. An orphaned future session with attendance or
 * waitlist rows is real member state, so it is left alone and reported rather
 * than deleted. Past sessions are never touched: they are the register.
 */
async function reconcileSchedules(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  classId: string,
  desired: ScheduleInput[],
  timeZone: string,
): Promise<ScheduleChange> {
  // RULES §4: ClassSchedule and ClassInstance carry no tenantId, so every
  // read and every write below scopes through the class relation. The caller
  // has already proved ownership of `classId` inside this same transaction;
  // this is the second lock, so no statement here is safe only by virtue of
  // its neighbours. The two createMany calls are the exception only because
  // createMany takes no `where` — their rows carry the proven-owned classId.
  const existing = await tx.classSchedule.findMany({
    where: { classId, class: { tenantId } },
    select: { id: true, dayOfWeek: true, startTime: true, endTime: true, isActive: true },
  });

  const desiredKeys = new Set(desired.map(slotKey));
  const activeByKey = new Map(existing.filter((s) => s.isActive).map((s) => [slotKey(s), s]));
  const inactiveByKey = new Map(existing.filter((s) => !s.isActive).map((s) => [slotKey(s), s]));

  // Gone: active slots the operator removed. Deactivated, not deleted — every
  // reader already filters `isActive`, and the row is the only record that this
  // class once ran at that time.
  const removedIds = existing
    .filter((s) => s.isActive && !desiredKeys.has(slotKey(s)))
    .map((s) => s.id);
  if (removedIds.length > 0) {
    await tx.classSchedule.updateMany({
      where: { id: { in: removedIds }, class: { tenantId } },
      data: { isActive: false },
    });
  }

  // New: anything not already active. Reactivate a matching deactivated row
  // where one exists, so toggling a slot off and on again does not accumulate
  // a new row every time.
  const toReactivate: string[] = [];
  const toCreate: ScheduleInput[] = [];
  for (const slot of desired) {
    const key = slotKey(slot);
    if (activeByKey.has(key)) continue;
    const dormant = inactiveByKey.get(key);
    if (dormant) toReactivate.push(dormant.id);
    else toCreate.push(slot);
  }
  if (toReactivate.length > 0) {
    await tx.classSchedule.updateMany({
      where: { id: { in: toReactivate }, class: { tenantId } },
      data: { isActive: true },
    });
  }
  if (toCreate.length > 0) {
    await tx.classSchedule.createMany({
      data: toCreate.map((s) => ({
        classId,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
        startDate: scheduleStartMarker(s.startDate, new Date(), timeZone),
        endDate: s.endDate ? new Date(s.endDate) : null,
      })),
    });
  }

  const slotsAdded = toReactivate.length + toCreate.length;
  const slotsRemoved = removedIds.length;

  // Nothing moved → nothing to reconcile, and in particular no instance churn
  // on a plain rename.
  if (slotsAdded === 0 && slotsRemoved === 0) {
    return { slotsAdded: 0, slotsRemoved: 0, instancesRemoved: [], instancesKept: [], instancesCreated: 0 };
  }

  // The CLUB's today at UTC midnight. This used to be the PROCESS's midnight,
  // which is how a schedule edit on a BST laptop wrote `23:00Z of yesterday`
  // while `ensureTodayInstances` wrote the club's own date — two rows for one
  // session, and an orphan sweep below that read the weekday in the wrong zone.
  const from = clubDayMarker(new Date(), timeZone);

  const active = await tx.classSchedule.findMany({
    where: { classId, isActive: true, class: { tenantId } },
    select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });
  const validSlots = new Set(active.map((s) => `${s.dayOfWeek}|${s.startTime}`));

  // Only from today forward. Past instances are the attendance record.
  //
  // The bound is half a day BEFORE the marker, which is `todayWindow`'s own
  // ±12 h band: a row written for today under the pre-migration spelling sits
  // at 23:00Z (BST) or 16:00Z (Bali) of yesterday, and a bare `gte: from` would
  // file it as past and leave it orphaned at the old start time for ever.
  // Yesterday's own marker is a full 24 h back and stays outside.
  const sweepFrom = new Date(from.getTime() - 12 * 60 * 60 * 1000);

  const upcoming = await tx.classInstance.findMany({
    where: { classId, date: { gte: sweepFrom }, class: { tenantId } },
    select: {
      id: true,
      date: true,
      startTime: true,
      endTime: true,
      _count: { select: { attendances: true, waitlists: true } },
    },
  });

  // `i.date` is a calendar-day marker, so its weekday is read in UTC off the
  // normalised marker — never `getDay()`, which resolves in the process's zone
  // and made a 23:00Z legacy row look like the previous weekday. Get this wrong
  // and the sweep deletes every upcoming session as an "orphan".
  const orphans = upcoming.filter(
    (i) => !validSlots.has(`${dayMarkerUtc(i.date).getUTCDay()}|${i.startTime}`),
  );
  const instancesKept = orphans
    .filter((i) => i._count.attendances > 0 || i._count.waitlists > 0)
    .map((i) => i.id);
  const instancesRemoved = orphans
    .filter((i) => i._count.attendances === 0 && i._count.waitlists === 0)
    .map((i) => i.id);

  if (instancesRemoved.length > 0) {
    await tx.classInstance.deleteMany({
      where: { id: { in: instancesRemoved }, class: { tenantId } },
    });
  }

  // Regenerate immediately rather than waiting for the nightly cron: a class
  // whose time just changed would otherwise have no check-in until tomorrow.
  // Idempotent against @@unique([classId, date, startTime]) (task 3b), so this
  // and the cron cannot fight.
  const rows = buildInstanceRows([{ id: classId, schedules: active }], {
    from,
    days: ROLLING_WINDOW_DAYS,
  });
  const created =
    rows.length > 0
      ? await tx.classInstance.createMany({ data: rows, skipDuplicates: true })
      : { count: 0 };

  // A new END time on an unchanged start: sessions are unique on (class, date,
  // start), so createMany above skips them and they kept the old end — the
  // register and kiosk said 06:55 while the class said 07:25, and the kiosk
  // closed check-in 30 minutes early (verifier lane 3, 30 Sep 2026). Bring
  // every upcoming session on a still-scheduled slot to that slot's end time.
  // Past sessions are the record of what ran and are left alone.
  const endBySlot = new Map(active.map((a) => [`${a.dayOfWeek}|${a.startTime}`, a.endTime]));
  const retimeByEnd = new Map<string, string[]>();
  for (const i of upcoming) {
    if (i.date.getTime() < from.getTime()) continue;
    const want = endBySlot.get(`${dayMarkerUtc(i.date).getUTCDay()}|${i.startTime}`);
    if (want && want !== i.endTime) retimeByEnd.set(want, [...(retimeByEnd.get(want) ?? []), i.id]);
  }
  for (const [endTime, ids] of retimeByEnd) {
    await tx.classInstance.updateMany({ where: { id: { in: ids }, class: { tenantId } }, data: { endTime } });
  }

  return {
    slotsAdded,
    slotsRemoved,
    instancesRemoved,
    instancesKept,
    instancesCreated: created.count,
  };
}

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const cls = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findFirst({
        where: { id, tenantId: session.user.tenantId },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
          allowedTiers: { select: { tier: { select: { id: true, name: true, isActive: true } } } },
        },
      }),
    );
    if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const { allowedTiers, ...rest } = cls;
    return NextResponse.json({ ...rest, allowedTiers: allowedTiers.map((t) => t.tier) });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Params) {
  // Lane 1 iter-1 CSRF-sweep [High]: assertSameOrigin guard. Inserted by the
  // bulk-fix script in audit/loop-fixes-01-dashboard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const tenantId = session.user.tenantId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  // TRUTHY, not merely present. This used to be `!== undefined`, which made
  // `{ requiredRankId: null, maxRankId: null }` — the body every non-roster
  // edit sends, including a pure rename — read as "the operator is setting a
  // rank gate", and the branch below then hard-deleted the class's roster.
  // Clearing a rank gate must clear the rank columns and nothing else; only
  // actually naming a rank is a switch into rank-gate mode.
  const wantsRankGate = Boolean(parsed.data.requiredRankId) || Boolean(parsed.data.maxRankId);
  const wantsRoster = Array.isArray(parsed.data.roster);
  const wantsSchedules = Array.isArray(parsed.data.schedules);
  const wantsTiers = Array.isArray(parsed.data.allowedTierIds);
  const nextTierIds = parsed.data.allowedTierIds ?? [];
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    // Pre-flight: ownership, then every foreign id in the body, then the
    // subscribers who would lose access (for the warning UI and the cascade).
    //
    // OWNERSHIP FIRST (finding E-1, 6 Oct 2026). The subscriber lookups below
    // used to run before any ownership check, with no tenant predicate —
    // ClassSubscription has no tenantId column — and `?dryRun=1` returned the
    // result. Under a BYPASSRLS runtime role gym A could read gym B's
    // subscriber member ids for any class id it held, and even under RLS the
    // dry run answered 200 for a class that was not the caller's.
    const pre = await withTenantContext(tenantId, async (tx) => {
      const owned = await tx.class.findFirst({
        where: { id, tenantId },
        select: { id: true, sourceImportJobId: true },
      });
      if (!owned) return { kind: "not_found" as const };

      // T6b: imported history classes are locked out of reactivation. They
      // were created inactive with no schedule to hold past sessions; putting
      // one on the timetable would offer a class that never ran.
      if (parsed.data.isActive === true && owned.sourceImportJobId) return { kind: "imported" as const };

      // Finding E-2: rank, coach and location ids must be this club's. Checked
      // here, before the write transaction, so a refusal never follows a
      // committed roster delete (returning from an interactive transaction
      // callback commits; it does not roll back).
      const refError = await classRefError(tx, tenantId, parsed.data);
      if (refError) return { kind: "bad_ref" as const, error: refError };

      // Roster ids are re-read under the club's scope: an id from another gym
      // (or a member deleted since the form loaded) is not written, it is
      // simply absent — the same rule POST /api/classes and the roster route
      // follow. A ClassRoster row carries the caller's tenantId, so RLS would
      // not stop a foreign memberId either.
      let rosterIds: string[] = [];
      if (wantsRoster) {
        const requested = Array.from(new Set((parsed.data.roster ?? []).map((m) => m.memberId)));
        if (requested.length > 0) {
          const ours = await tx.member.findMany({
            where: { id: { in: requested }, tenantId },
            select: { id: true },
          });
          rosterIds = ours.map((m) => m.id);
        }
      }

      let losers: string[] = [];
      if (wantsRankGate && parsed.data.requiredRankId) {
        const newRank = await tx.rankSystem.findFirst({
          where: { id: parsed.data.requiredRankId, tenantId, deletedAt: null },
          select: { id: true, order: true, discipline: true },
        });
        if (newRank) {
          // Lane 1 iter-2 L1-I2-S-03 [Critical] fix: P-07 narrowed select.
          // The previous bare `include: { member: ... }` pulled every Member
          // scalar including passwordHash, totpSecret, totpRecoveryCodes,
          // sessionVersion, failedLoginCount, lockedUntil, waiverIpAddress —
          // into process memory. Not exposed in the response today, but
          // sits in heap dumps and Vercel error stacks. Narrow to only the
          // fields the loser-calculation actually reads.
          const subs = await tx.classSubscription.findMany({
            // ClassSubscription has no tenantId column: scope through the
            // member, so this cannot read another club's subscribers even if
            // the ownership check above is ever moved.
            where: { classId: id, member: { tenantId } },
            select: {
              memberId: true,
              member: {
                select: {
                  memberRanks: {
                    select: {
                      rankSystem: {
                        select: { discipline: true, order: true },
                      },
                    },
                  },
                },
              },
            },
          });
          losers = subs
            .filter((s) => {
              const r = s.member.memberRanks.find((mr) => mr.rankSystem.discipline === newRank.discipline);
              return !r || r.rankSystem.order < newRank.order;
            })
            .map((s) => s.memberId);
        }
      }
      if (wantsRoster) {
        const subs = await tx.classSubscription.findMany({
          where: { classId: id, memberId: { notIn: rosterIds }, member: { tenantId } },
          select: { memberId: true },
        });
        losers = [...losers, ...subs.map((s) => s.memberId)];
      }
      // T6a preview only: the authoritative set is recomputed after the lock.
      let tierPreview: string[] = [];
      const currentTiers = wantsTiers
        ? (await tx.classMembershipTier.findMany({ where: { classId: id, tenantId }, select: { tierId: true } })).map((t) => t.tierId)
        : [];
      if (wantsTiers && !sameIds(currentTiers, nextTierIds)) {
        const hasRosterAfter = await rosterAfterEdit(tx, tenantId, id, wantsRoster, wantsRankGate, rosterIds);
        tierPreview = await tierLosers(tx, tenantId, id, nextTierIds, hasRosterAfter);
      }
      return { kind: "ok" as const, affected: Array.from(new Set(losers)), rosterIds, tierPreview };
    });

    if (pre.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (pre.kind === "bad_ref") return NextResponse.json({ error: pre.error }, { status: 400 });
    if (pre.kind === "imported") {
      return NextResponse.json({ error: IMPORTED_CLASS_REACTIVATE_REFUSAL, reason: "imported_class" }, { status: 409 });
    }
    const { affected, rosterIds, tierPreview } = pre;

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        affectedMemberIds: Array.from(new Set([...affected, ...tierPreview])),
        tierAffectedMemberIds: tierPreview,
      });
    }

    const updated = await withTenantContext(tenantId, async (tx) => {
      // OWNERSHIP FIRST — before any destructive statement.
      //
      // This check used to sit AFTER the deletes below, as the `updateMany`
      // guarded on { id, tenantId }. That was a cross-tenant wipe: returning
      // null from a Prisma interactive-transaction callback COMMITS, it does not
      // roll back, so `PATCH /api/classes/<gym-B-class-id>` with a roster body
      // hard-deleted gym B's roster and cancelled its ClassSubscription rows,
      // then answered 404 — leaving the caller believing nothing happened and
      // gym B with no audit row, since logAudit runs after the 404 return.
      // Checking here means no write has occurred when we bail. (The pre-flight
      // above checks it too; this one stays as the lock inside the transaction
      // that actually writes.)
      //
      // T6a: the ownership read is also the Class row LOCK, taken before any
      // roster, tier or booking write. A check-in takes the same lock before it
      // reads the tier list (lib/checkin.ts), so it is judged against whichever
      // list committed first, never a half-written one.
      const owned = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Class" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE
      `;
      if (owned.length === 0) return null;

      // T6a: replace the membership list inside the lock. The ids were proved
      // to be this club's in the pre-flight; re-read here so a tier deleted in
      // between is not written, and so the before/after pair is exact.
      const tiersBefore = wantsTiers
        ? (await tx.classMembershipTier.findMany({ where: { classId: id, tenantId }, select: { tierId: true } }))
            .map((t) => t.tierId).sort()
        : [];
      let tiersAfter = tiersBefore;
      if (wantsTiers) {
        const ours = nextTierIds.length > 0
          ? await tx.membershipTier.findMany({ where: { id: { in: nextTierIds }, tenantId }, select: { id: true } })
          : [];
        if (ours.length !== nextTierIds.length) throw new TierRefError();
        tiersAfter = ours.map((t) => t.id).sort();
        // An unchanged list (the form sends it on every save) is not rewritten
        // and cascades nothing.
        if (!sameIds(tiersBefore, tiersAfter)) {
          await tx.classMembershipTier.deleteMany({ where: { classId: id, tenantId } });
          if (ours.length > 0) {
            await tx.classMembershipTier.createMany({
              data: ours.map((t) => ({ tenantId, classId: id, tierId: t.id, createdByUserId: session.user.id })),
              skipDuplicates: true,
            });
          }
        }
      }
      // The narrowing cascade's members, computed after the lock, and only
      // when the list actually changed.
      const tierAffected = wantsTiers && !sameIds(tiersBefore, tiersAfter)
        ? await tierLosers(
            tx, tenantId, id, tiersAfter,
            await rosterAfterEdit(tx, tenantId, id, wantsRoster, wantsRankGate, rosterIds),
          )
        : [];

      // Mutual exclusion: setting rank fields clears roster; setting roster clears rank fields.
      if (wantsRankGate) {
        await tx.classRoster.deleteMany({ where: { classId: id, tenantId } });
      }
      if (wantsRoster) {
        await tx.classRoster.deleteMany({ where: { classId: id, tenantId } });
        const rows = rosterIds.map((memberId) => ({
          tenantId,
          classId: id,
          memberId,
          addedByUserId: session.user.id,
        }));
        if (rows.length > 0) {
          await tx.classRoster.createMany({ data: rows, skipDuplicates: true });
        }
      }
      // Cascade-cancel ClassSubscription rows for members losing access.
      const allAffected = Array.from(new Set([...affected, ...tierAffected]));
      if (allAffected.length > 0) {
        await tx.classSubscription.deleteMany({
          // ClassSubscription carries no tenantId column, so it scopes through
          // the member relation.
          where: { classId: id, memberId: { in: allAffected }, member: { tenantId } },
        });
      }
      // Task 3c: reconcile the recurring slots, then the instances they
      // generated. Runs before class.updateMany so a failure anywhere in here
      // rolls the whole edit back rather than leaving a class whose name
      // changed and whose timetable did not.
      //
      // The club's zone is read inside the same transaction and handed down:
      // the day marker every instance row carries is the club's calendar date,
      // and resolving it from the process's clock is the defect the round-3
      // migration closes.
      const scheduleChange = wantsSchedules
        ? await reconcileSchedules(
            tx,
            tenantId,
            id,
            parsed.data.schedules ?? [],
            usableTimezone(
              (await tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }))
                ?.timezone,
            ),
          )
        : null;

      // Explicit pick, not a rest-spread. `roster` and `schedules` are
      // API-layer concerns reconciled above and must never reach
      // class.updateMany; listing the columns makes that impossible to get
      // wrong the next time a field is added to updateSchema. Every value here
      // may be `undefined`, which Prisma treats as "leave alone".
      const classFields = {
        name: parsed.data.name,
        description: parsed.data.description,
        coachName: parsed.data.coachName,
        coachUserId: parsed.data.coachUserId,
        location: parsed.data.location,
        duration: parsed.data.duration,
        maxCapacity: parsed.data.maxCapacity,
        // Roster mode and rank gates are mutually exclusive, so entering roster
        // mode clears the rank columns outright.
        requiredRankId: wantsRoster ? null : parsed.data.requiredRankId,
        maxRankId: wantsRoster ? null : parsed.data.maxRankId,
        color: parsed.data.color,
        isActive: parsed.data.isActive,
        // T6b: resume / restore clears the archive marker too, so a restored
        // class is never "active but hidden everywhere". Pausing leaves an
        // archived class archived.
        deletedAt: parsed.data.isActive === true ? null : undefined,
        isKids: parsed.data.isKids,
        locationId: parsed.data.locationId,
      };
      // locationId, requiredRankId, maxRankId and coachUserId were proved to be
      // this club's in the pre-flight (classRefError) before any write here.
      // Before snapshot of the scalar fields, for the owner's Undo (schedule
      // and roster cascades are recorded by id below and are not undone here).
      const before = await tx.class.findFirst({ where: { id, tenantId } });
      const r = await tx.class.updateMany({
        where: { id, tenantId },
        data: classFields,
      });
      if (r.count === 0) return null;
      // T6b: a class coming back (Resume / Restore) had no sessions generated
      // while it was off the timetable; mint the rolling window now.
      const cameBack = parsed.data.isActive === true && !!before && classLifecycle(before) !== "active";
      const sessionsCreatedOnResume = cameBack ? await mintUpcomingSessions(tx, tenantId, id) : 0;
      const found = await tx.class.findFirst({
        where: { id, tenantId },
        include: {
          schedules: { where: { isActive: true } }, requiredRank: true, maxRank: true, coachUser: { select: { id: true, name: true } },
          allowedTiers: { select: { tier: { select: { id: true, name: true, isActive: true } } } },
        },
      });
      if (!found) return null;
      const { allowedTiers, ...rest } = found;
      const cls = { ...rest, allowedTiers: (allowedTiers ?? []).map((t) => t.tier) };
      return { cls, scheduleChange, before, tiersBefore, tiersAfter, tierAffected, allAffected, sessionsCreatedOnResume };
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.updated",
      entityType: "Class",
      entityId: id,
      metadata: {
        fields: Object.keys(parsed.data),
        cascadeCancelledSubscriptions: updated.allAffected.length,
        // The member IDS, not just the count. This cascade hard-deletes
        // ClassSubscription rows and there is no undo; recording only a number
        // meant a mis-save could not be reversed even once noticed. The common
        // path is a staff member enabling roster mode, ticking nobody, and
        // saving — `roster: []` makes every existing subscriber a "loser".
        cascadeCancelledMemberIds: updated.allAffected,
        // T6a: the membership list before and after, and the members whose
        // booking the narrowing removed (computed inside the write lock). The
        // class.updated undo stays scalar: tier ids are recorded, not undone.
        ...(wantsTiers
          ? {
              allowedTierIds: { before: updated.tiersBefore, after: updated.tiersAfter },
              tierCascadeMemberIds: updated.tierAffected,
            }
          : {}),
        // Same rule for the timetable cascade: the ids of every upcoming
        // session the schedule edit deleted, not just how many (RULES §5 — a
        // count cannot restore anything).
        ...(updated.scheduleChange ? { scheduleChange: updated.scheduleChange } : {}),
        ...(updated.sessionsCreatedOnResume > 0 ? { sessionsCreatedOnResume: updated.sessionsCreatedOnResume } : {}),
        // `isActive` and `deletedAt` before and after (T6b): undoing a Resume
        // or Restore puts the class back exactly as paused or archived.
        ...(() => {
          const { before: b, after: a, changed } = snapshotDiff(
            updated.before as unknown as Record<string, unknown> | null,
            updated.cls as unknown as Record<string, unknown>,
            ["name", "description", "instructorId", "coachName", "coachUserId", "location", "locationId", "duration", "maxCapacity", "isKids", "requiredRankId", "maxRankId", "color", "isActive", "deletedAt"],
          );
          return changed.length > 0 ? { before: b, after: a } : {};
        })(),
      },
      req,
    });

    // `scheduleChange` rides alongside the class so the client can say what
    // actually happened instead of an unconditional "Class updated".
    return NextResponse.json({
      ...updated.cls,
      scheduleChange: updated.scheduleChange,
      sessionsCreatedOnResume: updated.sessionsCreatedOnResume,
    });
  } catch (e) {
    // Thrown, not returned, so the transaction rolls back: no roster, tier or
    // booking change survives a refused tier list.
    if (e instanceof TierRefError) {
      return NextResponse.json({ error: CLASS_REF_ERRORS.tier }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to update class" }, { status: 500 });
  }
}

/**
 * DELETE /api/classes/[id] — ARCHIVE the class (T6b, Sean note 7).
 *
 * Archive = `isActive = false` plus `deletedAt = now()`: removed from the
 * timetable and every list, history kept (reports still count its
 * check-ins), bookings and sessions kept, restorable from the timetable's
 * "Paused and archived" section and undoable from Activity. Nothing is
 * deleted, so there is no 409 "force" dance any more: the owner is shown the
 * counts in a confirmation first.
 *
 * `?dryRun=1` returns those counts without changing anything — the counted
 * confirmation reads it. `?force=true` is still accepted (old clients send
 * it) and changes nothing.
 *
 * The audit row records the state the class was in before (`before`: paused
 * or active) so Undo puts back exactly that — a class paused before it was
 * archived goes back to paused, not active.
 */
export async function DELETE(req: Request, { params }: Params) {
  // Lane 1 iter-1 CSRF-sweep [High]: assertSameOrigin guard. Inserted by the
  // bulk-fix script in audit/loop-fixes-01-dashboard.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const tenantId = session.user.tenantId;
  const search = new URL(req.url).searchParams;
  const force = search.get("force") === "true";
  const dryRun = search.get("dryRun") === "1";

  try {
    // OWNERSHIP FIRST — before anything is counted, let alone returned.
    //
    // The counts below are disclosed (in the dry run, and on the audit row),
    // and they used to be computed before this handler had established that
    // the class belongs to the caller's club at all. Each count carried its
    // own tenant predicate, so the numbers were scoped — but that made the
    // answer depend on separate `where` clauses staying right for ever. One
    // edit away from telling gym A how busy gym B's class is.
    const owned = await withTenantContext(tenantId, (tx) =>
      tx.class.findFirst({
        where: { id, tenantId },
        select: { id: true, isActive: true, deletedAt: true, sourceImportJobId: true },
      }),
    );
    if (!owned) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Imported history is not on the timetable and is owned by the import's
    // own Rollback, which knows exactly which rows it created.
    if (owned.sourceImportJobId) {
      return NextResponse.json(
        { error: "This class holds imported attendance history. Undo the import with its own Rollback instead.", reason: "imported_class" },
        { status: 409 },
      );
    }

    // What the archive keeps, for the counted confirmation and the audit row.
    const [attendanceCount, rosterCount, bookingCount] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.attendanceRecord.count({ where: { classInstance: { class: { id, tenantId } } } }),
        tx.classRoster.count({ where: { classId: id, tenantId } }),
        // ClassSubscription carries no tenantId column: scoped through the member.
        tx.classSubscription.count({ where: { classId: id, member: { tenantId } } }),
      ]),
    );

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        state: classLifecycle(owned),
        attendanceCount,
        rosterCount,
        bookingCount,
      });
    }

    // Already archived: nothing to do, and no second audit row to confuse Undo.
    if (owned.deletedAt) {
      return NextResponse.json({ success: true, alreadyArchived: true });
    }

    const archivedAt = new Date();
    // Guarded on the state just read, so `before` on the audit row is exactly
    // what this write replaced: a pause or resume committing in between makes
    // this match nothing rather than record the wrong prior state.
    const result = await withTenantContext(tenantId, (tx) =>
      tx.class.updateMany({
        where: { id, tenantId, deletedAt: null, isActive: owned.isActive },
        data: { isActive: false, deletedAt: archivedAt },
      }),
    );

    if (result.count === 0) {
      return NextResponse.json(
        { error: "This class changed while it was being archived. Refresh the page and try again." },
        { status: 409 },
      );
    }

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.deleted",
      entityType: "Class",
      entityId: id,
      metadata: {
        soft: true,
        archived: true,
        force,
        attendanceCount,
        rosterCount,
        bookingCount,
        before: { isActive: owned.isActive, deletedAt: null },
        after: { isActive: false, deletedAt: archivedAt.toISOString() },
      },
      req,
    });

    return NextResponse.json({ success: true, archivedAt: archivedAt.toISOString(), attendanceCount, rosterCount, bookingCount });
  } catch {
    return NextResponse.json({ error: "Could not archive the class. Try again." }, { status: 500 });
  }
}
