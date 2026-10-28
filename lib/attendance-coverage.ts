/**
 * Attendance coverage (owner rule, 28 Oct 2026): "Missing attendance coverage
 * must not automatically become a claim that nobody attended."
 *
 * MatFlow knows about a club's attendance only from the day its records
 * begin: the first check-in recorded in MatFlow, or the first visit of an
 * imported attendance history (a club moving from TeamUp brings years of it).
 * Before that day a COUNT of zero means "no records", not "nobody trained", so
 * the statistics section (Reports, its CSV, Analysis) shows "—" and says why
 * instead of printing 0. After it, a zero is a real zero and stays 0.
 *
 * THE DEFINITION. The coverage start is the club-local day of the earliest
 * `AttendanceRecord.checkInTime` of ANY method, imported history included —
 * imported rows are real attendance (the At-Risk predicate, PR #36,
 * `atRiskMemberWhere`, counts them as visits for the same reason). No better
 * recorded fact exists: an attendance import stores when its source was
 * exported (`ImportJob.sourceExportedAt`, the END of the history) but not
 * where the history begins, so the earliest row is the start. A club with no
 * attendance rows has no coverage at all.
 *
 * Not the At-Risk gate. PR #36's `readAtRiskGate` asks a different question —
 * is MatFlow the club's register NOW, for the whole of the last 14 days — and
 * so reads MatFlow check-ins only (MATFLOW_CHECKIN_WHERE). Coverage asks
 * whether any record of attendance exists for a period, which imported
 * history answers. The query below reuses the gate's shape (one indexed
 * `findFirst` on AttendanceRecord(tenantId, checkInTime)) without its filter.
 *
 * What this cannot know: a gap INSIDE coverage. A club whose imported history
 * stops at the export and whose MatFlow check-ins start weeks later has no
 * records for the weeks between, and those weeks read as zero. Nothing in the
 * data tells that gap from a real closure (the At-Risk gate has the same
 * limit, and handles its own window with a "paused" state).
 *
 * The day is the club's (Tenant.timezone), as every period boundary is
 * (lib/report-period, lib/club-month). Pure apart from `readAttendanceCoverageStart`.
 */
import { usableTimezone, zoneOffsetMs } from "@/lib/class-time";

/**
 * How much of a span the club's records cover:
 *   - "none": the club has no attendance records at all;
 *   - "before": the span ends on or before the coverage start (no records for it);
 *   - "partial": the coverage start falls inside the span (count only what exists);
 *   - "covered": the span starts on or after the coverage start (a zero is a real zero).
 */
export type CoverageState = "none" | "before" | "partial" | "covered";

/** The coverage of a statistics page's spans, computed once on the server. */
export type AttendanceCoverage = {
  /** The coverage start (ISO): midnight, club time, of the day of the earliest record. Null when there are no records. */
  start: string | null;
  timeZone: string;
  /** The selected period. */
  period: CoverageState;
  /** The equal run of months before it (the comparison base). */
  previous: CoverageState;
  /** Reports only: this week (Monday to now) and the whole of last week, for the "Attendance this week" comparison. */
  thisWeek?: CoverageState;
  lastWeek?: CoverageState;
};

/** Midnight, club time, of the club-local day `instant` falls on (DST-safe: the offset is read twice, as lib/club-month does). */
export function clubDayStart(instant: Date, timeZoneRaw: string | null | undefined): Date {
  const timeZone = usableTimezone(timeZoneRaw);
  const local = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  const naive = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const first = zoneOffsetMs(new Date(naive), timeZone);
  const second = zoneOffsetMs(new Date(naive - first), timeZone);
  return new Date(naive - second);
}

type Instant = string | Date;
const ms = (d: Instant) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** The coverage of the half-open span [start, end). */
export function coverageOf(coverageStart: Instant | null | undefined, start: Instant, end: Instant): CoverageState {
  if (!coverageStart) return "none";
  const c = ms(coverageStart);
  if (ms(end) <= c) return "before";
  if (ms(start) < c) return "partial";
  return "covered";
}

/** True when a span has no records at all: its figures are "—", never 0. */
export function noCoverage(state: CoverageState | null | undefined): boolean {
  return state === "none" || state === "before";
}

/** "3 Mar 2026": the coverage start's club-local date. */
export function coverageDate(coverageStart: Instant, timeZoneRaw: string | null | undefined): string {
  return new Date(ms(coverageStart)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: usableTimezone(timeZoneRaw) });
}

/** The note for a club with no attendance records at all. */
export const NO_ATTENDANCE_YET = "No attendance recorded yet";

/** A comparison whose base has no records: no percentage, and why. */
export const NO_RECORDS_BEFORE = "— (no records for the period before)";

/** A comparison whose base is only partly covered: no percentage either, since the base undercounts. */
export const PARTLY_COVERED_BEFORE = "— (the period before is only partly covered)";

/**
 * The note in place of a figure for a span with no records:
 * "No attendance recorded yet", or "No attendance records for this period
 * (MatFlow's records start 3 Mar 2026)". Null for a span with records.
 */
export function noRecordsNote(coverage: Pick<AttendanceCoverage, "start" | "timeZone">, state: CoverageState | null | undefined): string | null {
  if (state === "none") return NO_ATTENDANCE_YET;
  if (state !== "before") return null;
  if (!coverage.start) return NO_ATTENDANCE_YET;
  return `No attendance records for this period (MatFlow's records start ${coverageDate(coverage.start, coverage.timeZone)})`;
}

/** "Records start 3 Mar 2026": the label on a figure whose span starts before the records do. Null otherwise. */
export function partialNote(coverage: Pick<AttendanceCoverage, "start" | "timeZone">, state: CoverageState | null | undefined): string | null {
  if (state !== "partial" || !coverage.start) return null;
  return `Records start ${coverageDate(coverage.start, coverage.timeZone)}`;
}

/** The one note a span's figures carry, if any: the no-records note or the partial label. */
export function coverageNote(coverage: Pick<AttendanceCoverage, "start" | "timeZone">, state: CoverageState | null | undefined): string | null {
  return noRecordsNote(coverage, state) ?? partialNote(coverage, state);
}

/**
 * One chart bar's (or CSV bucket row's) note: "No records (MatFlow's records
 * start 3 Mar 2026)" for a bucket before the records, "Partly covered (records
 * start 3 Mar 2026)" for the bucket they start in, null for a covered one.
 */
export function bucketNote(coverage: Pick<AttendanceCoverage, "start" | "timeZone">, state: CoverageState | null | undefined): string | null {
  if (state === "none" || ((state === "before" || state === "partial") && !coverage.start)) return NO_ATTENDANCE_YET;
  if (state === "before") return `No records (MatFlow's records start ${coverageDate(coverage.start!, coverage.timeZone)})`;
  if (state === "partial") return `Partly covered (records start ${coverageDate(coverage.start!, coverage.timeZone)})`;
  return null;
}

/**
 * The comparison text in place of a change when its base is not fully
 * covered, or null when the base is covered and the ordinary change applies.
 */
export function comparisonGap(previous: CoverageState | null | undefined): string | null {
  if (previous === "none" || previous === "before") return NO_RECORDS_BEFORE;
  if (previous === "partial") return PARTLY_COVERED_BEFORE;
  return null;
}

/** The slice of a Prisma (transaction) client the coverage read uses. */
export type CoverageClient = {
  attendanceRecord: {
    findFirst(args: {
      where: { tenantId: string };
      orderBy: { checkInTime: "asc" };
      select: { checkInTime: true };
    }): PromiseLike<{ checkInTime: Date } | null>;
  };
};

/**
 * The club's coverage start: midnight (club time) of the day of its earliest
 * attendance record of any method, or null when it has none. One indexed probe
 * on AttendanceRecord(tenantId, checkInTime). Tenant-scoped by `where`; run it
 * inside withTenantContext so RLS backs the filter.
 */
export async function readAttendanceCoverageStart(tx: CoverageClient, tenantId: string, timeZone: string | null | undefined): Promise<Date | null> {
  const first = await tx.attendanceRecord.findFirst({
    where: { tenantId },
    orderBy: { checkInTime: "asc" },
    select: { checkInTime: true },
  });
  return first ? clubDayStart(first.checkInTime, timeZone) : null;
}

/** The page-level coverage for a period and the run before it. */
export function attendanceCoverageFor(
  start: Date | null,
  timeZoneRaw: string | null | undefined,
  period: { start: Instant; end: Instant },
  previous: { start: Instant; end: Instant },
): AttendanceCoverage {
  const iso = start ? start.toISOString() : null;
  return {
    start: iso,
    timeZone: usableTimezone(timeZoneRaw),
    period: coverageOf(iso, period.start, period.end),
    previous: coverageOf(iso, previous.start, previous.end),
  };
}
