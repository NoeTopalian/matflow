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
 * Every occurrence of every schedule that falls inside `[from, to]`, inclusive.
 *
 * `from` is expected to be a midnight boundary — the callers all pass
 * `new Date()` with `setHours(0, 0, 0, 0)`, and the emitted `date` values
 * inherit that boundary, which is what the (classId, date, startTime) unique
 * key matches on.
 *
 * A schedule's own `startDate` / `endDate` are honoured: a course that finished
 * in March must not still be minting instances in September, and an unattended
 * nightly job is exactly where that would go unnoticed.
 */
export function buildInstanceRows(
  classes: ClassWithSchedules[],
  window: { from: Date; to: Date },
): InstanceRow[] {
  const rows: InstanceRow[] = [];

  for (const cls of classes) {
    for (const sched of cls.schedules) {
      // Never start before the schedule itself does.
      const start = new Date(window.from);
      if (sched.startDate && sched.startDate > start) {
        start.setTime(sched.startDate.getTime());
        start.setHours(0, 0, 0, 0);
      }

      // Never run past the schedule's end.
      const end = new Date(window.to);
      if (sched.endDate && sched.endDate < end) {
        end.setTime(sched.endDate.getTime());
      }
      if (start > end) continue;

      const current = new Date(start);
      // Advance to the first occurrence of this weekday. Bounded by 7 steps.
      while (current.getDay() !== sched.dayOfWeek) {
        current.setDate(current.getDate() + 1);
      }
      while (current <= end) {
        rows.push({
          classId: cls.id,
          date: new Date(current),
          startTime: sched.startTime,
          endTime: sched.endTime,
        });
        current.setDate(current.getDate() + 7);
      }
    }
  }

  return rows;
}
