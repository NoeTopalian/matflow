/**
 * Today's sessions exist before anyone asks for them.
 *
 * Every attendance surface lists ClassInstance rows, and until 18 Sep 2026
 * those rows came only from the nightly cron (which has never run on
 * production — CRON_SECRET was never set), the timetable's Generate button, or
 * the PATCH route on a schedule edit. POST /api/classes minted none. So a
 * class created for 12:30 today had no session to check into until someone
 * found the right button. Noe: "it doesn't come up with the option to sign
 * people into classes happening at this moment."
 *
 * `ensureTodayInstances` closes that from the read side: /api/coach/today
 * materialises today's rows from the active schedules before it lists them.
 * It is idempotent against @@unique([classId, date, startTime]) — createMany
 * with skipDuplicates — so calling it on every read costs one SELECT and one
 * no-op INSERT once the rows exist, and it can never fight the cron or the
 * buttons: `clubDayMarker` spells the day exactly as they do.
 */
import { buildInstanceRows } from "@/lib/class-instances";
import { zoneOffsetMs } from "@/lib/class-time";

/**
 * Process-local midnight of the CLUB's calendar date. This is the spelling of
 * a day marker every existing writer uses — the cron (00:00Z on Vercel), the
 * two Generate buttons and the PATCH route all pass `new Date()` with
 * `setHours(0,0,0,0)` into buildInstanceRows — so rows minted here collide
 * with theirs on the unique index instead of duplicating. The club date, not
 * the process date: at 23:30Z on a BST evening the club is already on
 * tomorrow, and a New York club at 02:00Z is still on yesterday.
 */
export function clubDayMarker(now: Date, timeZone: string): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  return new Date(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

type ScheduleRow = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  startDate?: Date | null;
  endDate?: Date | null;
};

/** The slice of a Prisma transaction client this helper touches. */
export type TodaySessionsTx = {
  class: {
    findMany: (args: {
      where: { tenantId: string; isActive: boolean; deletedAt: null };
      select: {
        id: true;
        schedules: {
          where: { isActive: boolean };
          select: { dayOfWeek: true; startTime: true; endTime: true; startDate: true; endDate: true };
        };
      };
    }) => Promise<Array<{ id: string; schedules: ScheduleRow[] }>>;
  };
  classInstance: {
    createMany: (args: {
      data: Array<{ classId: string; date: Date; startTime: string; endTime: string }>;
      skipDuplicates: boolean;
    }) => Promise<{ count: number }>;
  };
};

/**
 * Materialise today's ClassInstance rows from the active schedules of the
 * club's active, undeleted classes. Returns the number of rows actually
 * created — 0 once they all exist.
 */
export async function ensureTodayInstances(
  tx: TodaySessionsTx,
  tenantId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<number> {
  const classes = await tx.class.findMany({
    where: { tenantId, isActive: true, deletedAt: null },
    select: {
      id: true,
      schedules: {
        where: { isActive: true },
        select: { dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
      },
    },
  });
  const rows = buildInstanceRows(classes, { from: clubDayMarker(now, timeZone), days: 1 });
  if (rows.length === 0) return 0;
  const created = await tx.classInstance.createMany({ data: rows, skipDuplicates: true });
  return created.count;
}
