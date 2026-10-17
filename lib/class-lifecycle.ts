/**
 * T6b: server-side lifecycle helpers (the pure predicates live in
 * lib/class-live.ts).
 *
 * A paused or archived class gets no new sessions: every generator (the
 * nightly cron, the club-wide and per-class Generate, `ensureTodayInstances`)
 * skips it. So when it comes back — Resume, Restore, or an Undo that returns
 * it to active — the rolling window is minted at once, exactly as a schedule
 * edit does, instead of leaving a gap until something else generates.
 */
import type { Prisma } from "@prisma/client";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";

/**
 * Mint the class's sessions from the club's today for the rolling window.
 * Idempotent against @@unique([classId, date, startTime]): a session kept
 * through the pause is not duplicated, and a cancelled one stays cancelled.
 * The caller has already proved `classId` belongs to `tenantId` inside `tx`.
 * Returns the number of sessions created.
 */
export async function mintUpcomingSessions(
  tx: Prisma.TransactionClient,
  tenantId: string,
  classId: string,
  now: Date = new Date(),
): Promise<number> {
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } });
  const schedules = await tx.classSchedule.findMany({
    where: { classId, isActive: true, class: { tenantId } },
    select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
  });
  if (schedules.length === 0) return 0;
  const rows = buildInstanceRows([{ id: classId, schedules }], {
    from: clubDayMarker(now, usableTimezone(tenant?.timezone)),
    days: ROLLING_WINDOW_DAYS,
  });
  if (rows.length === 0) return 0;
  const created = await tx.classInstance.createMany({ data: rows, skipDuplicates: true });
  return created.count;
}

/**
 * Classes archived BEFORE T6b, among the given paused-looking ids.
 *
 * Until 17 Oct 2026 the timetable's "Archive class" button (DELETE) set
 * `isActive = false` and nothing else, and nothing in the product could pause
 * a class. So such a row is not paused: its owner archived it. No data is
 * rewritten for that (a backfill migration was not taken); instead a class is
 * read as archived when its most recent lifecycle audit row is `class.deleted`.
 * Every archive since T6b sets `deletedAt`, so it never reaches here, and a
 * Resume or a pause writes `class.updated`, which then becomes the latest row.
 *
 * Returns id -> when it was archived. Ids not in the map are genuinely paused.
 * Tenant-scoped (RLS plus the explicit `tenantId`).
 */
export async function legacyArchivedAt(
  tx: Prisma.TransactionClient,
  tenantId: string,
  classIds: string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (classIds.length === 0) return out;
  const rows = await tx.auditLog.findMany({
    where: {
      tenantId,
      entityType: "Class",
      entityId: { in: classIds },
      action: { in: ["class.deleted", "class.updated"] },
    },
    select: { entityId: true, action: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.entityId)) continue;
    seen.add(r.entityId);
    if (r.action === "class.deleted") out.set(r.entityId, r.createdAt);
  }
  return out;
}
