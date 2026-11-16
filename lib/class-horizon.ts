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
 * A cancelled session keeps its row (`isCancelled`), so it is never re-created as bookable. The club filter differs from
 * the cron's on purpose: the cron sweeps active and trial clubs; a member read tops up any club its doors admit
 * (lib/tenant-admission.ts), which includes a past-due club its members can still sign in to.
 *
 * Known, pre-existing and unchanged: a schedule edit committing between this read of the schedules and its insert can
 * have sessions at the old time re-inserted, exactly as the Generate button and the cron can (review of PR #93, LOW).
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";
import { tenantAdmission } from "@/lib/tenant-admission";

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
/** After a failed top-up, the reads that follow do not retry it for this long (a struggling database is not hammered). */
export const HORIZON_RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

const lastTopUp = new Map<string, { at: number; ok: boolean }>();
const inFlight = new Map<string, Promise<void>>();

/**
 * Top the club's horizon up before a member read lists sessions. At most once per club per server instance every
 * HORIZON_TOP_UP_INTERVAL_MS (HORIZON_RETRY_AFTER_FAILURE_MS after a failure); concurrent first reads share one run.
 * Only a club the doors admit (lib/tenant-admission.ts) is topped up. Never throws: a failure is logged and the read
 * carries on with the sessions that already exist (it is no worse than before).
 */
export function ensureClassHorizon(tenantId: string, now: Date = new Date()): Promise<void> {
  const last = lastTopUp.get(tenantId);
  if (last) {
    const age = now.getTime() - last.at;
    if (age >= 0 && age < (last.ok ? HORIZON_TOP_UP_INTERVAL_MS : HORIZON_RETRY_AFTER_FAILURE_MS)) return Promise.resolve();
  }
  const running = inFlight.get(tenantId);
  if (running) return running;
  const run = (async () => {
    try {
      const tenant = await withTenantContext(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true, subscriptionStatus: true, deletedAt: true } }),
      );
      if (tenant && tenantAdmission(tenant).admits) {
        await generateClassHorizon(tenantId, clubDayMarker(now, usableTimezone(tenant.timezone)));
      }
      lastTopUp.set(tenantId, { at: now.getTime(), ok: true });
    } catch (err) {
      lastTopUp.set(tenantId, { at: now.getTime(), ok: false });
      console.error("[class-horizon] top-up failed; the sessions already generated still list", { tenantId }, err);
    } finally {
      inFlight.delete(tenantId);
    }
  })();
  inFlight.set(tenantId, run);
  return run;
}

/** Tests only: forget every remembered top-up. */
export function resetClassHorizonMemoForTests(): void {
  lastTopUp.clear();
  inFlight.clear();
}
