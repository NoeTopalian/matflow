/**
 * The one place that turns recurring ClassSchedule rows into concrete
 * ClassInstance rows.
 *
 * Three callers walk the same weekday arithmetic — POST /api/instances/generate,
 * POST /api/classes/[id]/instances, and the nightly GET /api/cron/class-instances.
 * They had three copies of the loop, which is how the cron would have quietly
 * grown its own rules; the row shape has to be byte-identical across all three
 * or `skipDuplicates` stops matching and the nightly run re-inserts everything
 * the buttons already made.
 *
 * Pure and synchronous on purpose: no Prisma, no clock. The caller supplies the
 * window, so the cron's rolling horizon and a button's "next 4 weeks" are the
 * same code with different arguments, and the whole thing is testable without a
 * database.
 */
import { dayMarkerUtc } from "@/lib/class-time";

/**
 * How far ahead instances are kept generated. Owned here rather than by the
 * cron so that a schedule edit rebuilds exactly the horizon the nightly job
 * maintains — a smaller number here would leave a gap the cron only closes the
 * following night, which for a class whose time just changed is a night of
 * members unable to check in.
 */
export const ROLLING_WINDOW_DAYS = 56;

export type ScheduleSlot = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** ClassSchedule.startDate — the slot does not exist before this. */
  startDate?: Date | null;
  /** ClassSchedule.endDate — null means "runs indefinitely". */
  endDate?: Date | null;
};

export type ClassWithSchedules = {
  id: string;
  schedules: ScheduleSlot[];
};

export type InstanceRow = {
  classId: string;
  date: Date;
  startTime: string;
  endTime: string;
};

/**
 * Every occurrence of every schedule inside a window of exactly `days` days
 * beginning on `from`. The last date included is `from + (days - 1)`.
 *
 * THE WINDOW IS A DAY COUNT, NOT AN END DATE, and that is the whole point.
 * Every caller wants "the next N weeks", i.e. N*7 days, and all four of them
 * used to compute `to = from + N*7` and hand it to a builder that compared
 * `current <= to`. That includes BOTH endpoints, so a window advertised as N
 * weeks actually spanned N*7 + 1 days and emitted N+1 occurrences of whichever
 * weekday `from` happens to fall on — "the next 1 week" produced two Mondays
 * when you asked for it on a Monday. Taking a count instead of an end date
 * makes that class of off-by-one unreachable from a call site: the number of
 * occurrences is now exactly `days / 7` per schedule, invariant to which
 * weekday the window starts on.
 *
 * `from` is a CALENDAR-DAY MARKER and every emitted `date` is one too: exactly
 * `00:00:00.000Z` of its date, via `dayMarkerUtc`. The whole walk is UTC —
 * `getUTCDay`, `setUTCDate` — and that is the round-3 migration, not a tidy.
 *
 * What it replaces: `from` used to be `new Date(); setHours(0,0,0,0)` and the
 * walk used `getDay()` / `setDate()`, both of which resolve in the PROCESS's
 * zone. Two failures followed, both observed rather than theorised:
 *
 *  - On a host with DST, a 56-day window CROSSES the transition, so the same
 *    weekly slot emitted `Sunday 23:00Z` before 25 Oct and `Monday 00:00Z`
 *    after it. One class, one slot, two spellings of the day — caught by
 *    `ld-1-timetable.spec.ts:205`, whose `SELECT DISTINCT extract(dow from
 *    date)` came back `[0, 1]`.
 *  - On a host WEST of UTC, a UTC-midnight `from` read back as the PREVIOUS
 *    local day, so `current.getDay()` advanced to the wrong weekday and every
 *    session was minted a day out.
 *
 * Both are unreachable from a call site now: the arithmetic no longer has a
 * process zone to resolve in.
 *
 * A schedule's own `startDate` / `endDate` are honoured: a course that finished
 * in March must not still be minting instances in September, and an unattended
 * nightly job is exactly where that would go unnoticed.
 */
export function buildInstanceRows(
  classes: ClassWithSchedules[],
  window: { from: Date; days: number },
): InstanceRow[] {
  const rows: InstanceRow[] = [];
  if (window.days < 1) return rows;

  // Normalise the caller's marker, so a legacy `setHours(0,0,0,0)` `from`
  // cannot reintroduce the off-midnight spelling through the back door.
  const from = dayMarkerUtc(window.from);

  // The last date inside the window. `days - 1` because `from` is day one.
  const windowEnd = new Date(from);
  windowEnd.setUTCDate(from.getUTCDate() + window.days - 1);

  for (const cls of classes) {
    for (const sched of cls.schedules) {
      // Never start before the schedule itself does. `startDate`/`endDate` are
      // day markers too (ClassSchedule columns written from a date input), so
      // they are normalised the same way — comparing a raw 23:00Z startDate
      // against a 00:00Z window edge is an off-by-one waiting to happen.
      const start = new Date(from);
      if (sched.startDate) {
        const schedStart = dayMarkerUtc(sched.startDate);
        if (schedStart > start) start.setTime(schedStart.getTime());
      }

      // Never run past the schedule's end.
      const end = new Date(windowEnd);
      if (sched.endDate) {
        const schedEnd = dayMarkerUtc(sched.endDate);
        if (schedEnd < end) end.setTime(schedEnd.getTime());
      }
      if (start > end) continue;

      const current = new Date(start);
      // Advance to the first occurrence of this weekday. Bounded by 7 steps.
      // UTC accessors throughout: a marker is a UTC midnight, and reading its
      // weekday in the process's zone is how a host west of UTC minted every
      // session on the day before.
      while (current.getUTCDay() !== sched.dayOfWeek) {
        current.setUTCDate(current.getUTCDate() + 1);
      }
      while (current <= end) {
        rows.push({
          classId: cls.id,
          date: new Date(current),
          startTime: sched.startTime,
          endTime: sched.endTime,
        });
        current.setUTCDate(current.getUTCDate() + 7);
      }
    }
  }

  return rows;
}
