import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { scheduleSchema } from "@/lib/schemas/class";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";

const rosterEntrySchema = z.object({ memberId: z.string().min(1) });

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  coachName: z.string().max(100).optional().nullable(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  duration: z.number().int().min(1).max(480).optional(),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional(),
  // Task 5: optional roster array; mutually exclusive with rank fields at the API layer.
  roster: z.array(rosterEntrySchema).optional(),
  // Task 3c. TimetableManager has been sending this since it was written and
  // Zod stripped it, so `class.updateMany` never touched ClassSchedule, the
  // client merged the OLD rows back into state, and the toast still said
  // "Class updated" — RULES §2, a success message must mean success. There was
  // no PUT/PATCH for ClassSchedule anywhere: a class's day or time could only
  // ever be set at creation time.
  schedules: z.array(scheduleSchema).max(50).optional(),
});

type Params = { params: Promise<{ id: string }> };

type ScheduleInput = z.infer<typeof scheduleSchema>;

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
        startDate: s.startDate ? new Date(s.startDate) : new Date(),
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

  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(from.getDate() + ROLLING_WINDOW_DAYS);

  const active = await tx.classSchedule.findMany({
    where: { classId, isActive: true, class: { tenantId } },
    select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });
  const validSlots = new Set(active.map((s) => `${s.dayOfWeek}|${s.startTime}`));

  // Only from today forward. Past instances are the attendance record.
  const upcoming = await tx.classInstance.findMany({
    where: { classId, date: { gte: from }, class: { tenantId } },
    select: {
      id: true,
      date: true,
      startTime: true,
      _count: { select: { attendances: true, waitlists: true } },
    },
  });

  const orphans = upcoming.filter(
    (i) => !validSlots.has(`${i.date.getDay()}|${i.startTime}`),
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
  const rows = buildInstanceRows([{ id: classId, schedules: active }], { from, to });
  const created =
    rows.length > 0
      ? await tx.classInstance.createMany({ data: rows, skipDuplicates: true })
      : { count: 0 };

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
        },
      }),
    );
    if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(cls);
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
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  try {
    // Compute affected subscribers (those who would lose access) for warning UI.
    const affected = await withTenantContext(tenantId, async (tx) => {
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
            where: { classId: id },
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
        const rosterIds = (parsed.data.roster ?? []).map((m) => m.memberId);
        const subs = await tx.classSubscription.findMany({
          where: { classId: id, memberId: { notIn: rosterIds } },
          select: { memberId: true },
        });
        losers = [...losers, ...subs.map((s) => s.memberId)];
      }
      return Array.from(new Set(losers));
    });

    if (dryRun) {
      return NextResponse.json({ dryRun: true, affectedMemberIds: affected });
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
      // Checking here means no write has occurred when we bail.
      const owned = await tx.class.findFirst({
        where: { id, tenantId },
        select: { id: true },
      });
      if (!owned) return null;

      // Mutual exclusion: setting rank fields clears roster; setting roster clears rank fields.
      if (wantsRankGate) {
        await tx.classRoster.deleteMany({ where: { classId: id, tenantId } });
      }
      if (wantsRoster) {
        await tx.classRoster.deleteMany({ where: { classId: id, tenantId } });
        const rows = (parsed.data.roster ?? []).map((m) => ({
          tenantId,
          classId: id,
          memberId: m.memberId,
          addedByUserId: session.user.id,
        }));
        if (rows.length > 0) {
          await tx.classRoster.createMany({ data: rows, skipDuplicates: true });
        }
      }
      // Cascade-cancel ClassSubscription rows for members losing access.
      if (affected.length > 0) {
        await tx.classSubscription.deleteMany({
          // ClassSubscription carries no tenantId column, so it scopes through
          // the member relation.
          where: { classId: id, memberId: { in: affected }, member: { tenantId } },
        });
      }
      // Task 3c: reconcile the recurring slots, then the instances they
      // generated. Runs before class.updateMany so a failure anywhere in here
      // rolls the whole edit back rather than leaving a class whose name
      // changed and whose timetable did not.
      const scheduleChange = wantsSchedules
        ? await reconcileSchedules(tx, tenantId, id, parsed.data.schedules ?? [])
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
      };
      const r = await tx.class.updateMany({
        where: { id, tenantId },
        data: classFields,
      });
      if (r.count === 0) return null;
      const cls = await tx.class.findFirst({
        where: { id, tenantId },
        include: { schedules: { where: { isActive: true } }, requiredRank: true, maxRank: true, coachUser: { select: { id: true, name: true } } },
      });
      return cls ? { cls, scheduleChange } : null;
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
        cascadeCancelledSubscriptions: affected.length,
        // The member IDS, not just the count. This cascade hard-deletes
        // ClassSubscription rows and there is no undo; recording only a number
        // meant a mis-save could not be reversed even once noticed. The common
        // path is a staff member enabling roster mode, ticking nobody, and
        // saving — `roster: []` makes every existing subscriber a "loser".
        cascadeCancelledMemberIds: affected,
        // Same rule for the timetable cascade: the ids of every upcoming
        // session the schedule edit deleted, not just how many (RULES §5 — a
        // count cannot restore anything).
        ...(updated.scheduleChange ? { scheduleChange: updated.scheduleChange } : {}),
      },
      req,
    });

    // `scheduleChange` rides alongside the class so the client can say what
    // actually happened instead of an unconditional "Class updated".
    return NextResponse.json({ ...updated.cls, scheduleChange: updated.scheduleChange });
  } catch {
    return NextResponse.json({ error: "Failed to update class" }, { status: 500 });
  }
}

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
  const force = new URL(req.url).searchParams.get("force") === "true";

  try {
    // Task 6: precondition counts. Refuse delete if attendance OR roster exists, unless ?force=true.
    const [attendanceCount, rosterCount] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        // Both counts are returned in the 409 body BEFORE the tenant-scoped
        // soft-delete gate below, so without a tenant predicate a foreign
        // classId discloses how many members are on another gym's roster and
        // how often that class is attended.
        tx.attendanceRecord.count({ where: { classInstance: { class: { id, tenantId } } } }),
        tx.classRoster.count({ where: { classId: id, tenantId } }),
      ]),
    );

    if (!force && (attendanceCount > 0 || rosterCount > 0)) {
      return NextResponse.json(
        {
          error: "Class has attendance or roster history. Pass ?force=true to delete anyway.",
          attendanceCount,
          rosterCount,
        },
        { status: 409 },
      );
    }

    // Soft-delete by setting isActive = false
    const result = await withTenantContext(tenantId, (tx) =>
      tx.class.updateMany({
        where: { id, tenantId },
        data: { isActive: false },
      }),
    );

    if (result.count === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.deleted",
      entityType: "Class",
      entityId: id,
      metadata: { soft: true, force, attendanceCount, rosterCount },
      req,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete class" }, { status: 500 });
  }
}
