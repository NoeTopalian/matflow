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
 * **UTC** midnight of the CLUB's calendar date — the single spelling of a day
 * marker, now used by all five writers: this one, `POST /api/classes`,
 * `POST /api/instances/generate`, `reconcileSchedules` in
 * `app/api/classes/[id]/route.ts`, and the nightly
 * `GET /api/cron/class-instances`.
 *
 * The club date, not the process date: at 23:30Z on a BST evening the club is
 * already on tomorrow, and a New York club at 02:00Z is still on yesterday.
 *
 * It used to return `new Date(y, m, d)` — that date at the PROCESS's midnight —
 * and the other writers used the process's own date at its midnight. Three
 * failures came out of that, all measured:
 *
 *  1. The process's zone leaked into a value that is supposed to be a calendar
 *     date, so the same club day was `00:00Z` on Vercel and `23:00Z of the day
 *     before` on a BST laptop. `skipDuplicates` cannot match across those.
 *  2. A host beyond +12 (Chatham, Kiritimati, or a laptop there) wrote a marker
 *     12.75–14 h from UTC midnight, outside `todayWindow`'s ±12 h band — that
 *     club had no today at all.
 *  3. A club whose calendar date differed from the host's was a full day apart
 *     from its own Generate button.
 *
 * `Date.UTC` removes all three at once: the returned instant depends only on
 * `now` and the club's zone, never on where the code is running.
 */
export function clubDayMarker(now: Date, timeZone: string): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
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
