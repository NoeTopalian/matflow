/**
 * The rolling session horizon, kept from the read side as well as by the nightly cron (Round 9, 16 Nov 2026).
 *
 * Members book and check in against ClassInstance rows. Those rows reach ROLLING_WINDOW_DAYS ahead only when a schedule
 * is edited, a class is created, the Generate button is pressed, or the nightly `GET /api/cron/class-instances` runs —
 * and that cron answers 503 until CRON_SECRET is set, which on production it never has been. So, per class, about
 * 56 days after its schedule was last rebuilt, `/api/member/schedule` stopped returning a `classInstanceId` and members
 * silently could not book or check in (staff could still sign people in for today: /api/coach/today mints today's
 * rows). The member read paths now top the horizon up themselves, so member check-in no longer depends on the cron.
 *
 * Same rows as the cron, byte for byte: `buildInstanceRows` over the club's active, undeleted classes and their active
 * schedules, from the CLUB's calendar day, inserted with `skipDuplicates` against @@unique([classId, date, startTime]).
 * A cancelled session keeps its row (`isCancelled`), so it is never re-created as bookable.
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";

/** Rows per createMany. Keeps each statement inside the transaction budget. */
export const HORIZON_INSERT_BATCH = 500;

/**
 * Generate every missing instance of the club's horizon starting at `from` (a club day marker). `shouldStop` lets the
 * cron stop between batches near its deadline; a stopped run reports `partial` and the next run resumes (idempotent).
 */
export async function generateClassHorizon(
  tenantId: string,
  from: Date,
  shouldStop: () => boolean = () => false,
): Promise<{ created: number; partial?: true }> {
  const classes = await withTenantContext(tenantId, (tx) =>
    tx.class.findMany({
      // A paused (isActive: false) or removed (deletedAt) class must not have instances minted for it — that would put
      // it back on the check-in screen while every list filters it out.
      where: { tenantId, isActive: true, deletedAt: null },
      select: {
        id: true,
        schedules: {
          where: { isActive: true },
          select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
        },
      },
    }),
  );

  const rows = buildInstanceRows(classes, { from, days: ROLLING_WINDOW_DAYS });
  if (rows.length === 0) return { created: 0 };

  let created = 0;
  for (let i = 0; i < rows.length; i += HORIZON_INSERT_BATCH) {
    if (shouldStop()) return { created, partial: true };
    const batch = rows.slice(i, i + HORIZON_INSERT_BATCH);
    const res = await withTenantContext(tenantId, (tx) =>
      // Idempotent since migration 20260819090000 gave ClassInstance @@unique([classId, date, startTime]).
      tx.classInstance.createMany({ data: batch, skipDuplicates: true }),
    );
    created += res.count;
  }
  return { created };
}

/** How long one server instance trusts its own last top-up of a club. The horizon is 56 days; this only bounds cost. */
export const HORIZON_TOP_UP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lastTopUp = new Map<string, number>();

/**
 * Top the club's horizon up before a member read lists sessions. At most once per club per server instance every
 * HORIZON_TOP_UP_INTERVAL_MS, so a busy schedule page costs nothing extra almost always. Never throws: a failed top-up
 * is logged and the read carries on with the sessions that already exist (it is no worse than before).
 */
export async function ensureClassHorizon(tenantId: string, now: Date = new Date()): Promise<void> {
  const last = lastTopUp.get(tenantId);
  if (last !== undefined && now.getTime() - last >= 0 && now.getTime() - last < HORIZON_TOP_UP_INTERVAL_MS) return;
  try {
    const tenant = await withTenantContext(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    );
    if (!tenant) return;
    await generateClassHorizon(tenantId, clubDayMarker(now, usableTimezone(tenant.timezone)));
    lastTopUp.set(tenantId, now.getTime());
  } catch (err) {
    console.error("[class-horizon] top-up failed; the sessions already generated still list", { tenantId }, err);
  }
}

/** Tests only: forget every remembered top-up. */
export function resetClassHorizonMemoForTests(): void {
  lastTopUp.clear();
}
