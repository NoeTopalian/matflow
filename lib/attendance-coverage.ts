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
 * WHERE THE RECORDS STOP (31 Oct 2026). An imported history ends at its
 * export: Sean's club imported TeamUp's visits up to its export and had
 * recorded no check-in in MatFlow since, so every week after the export read
 * as a real 0 ("nobody trained"). The coverage therefore also knows the
 * HISTORY END (the club-local day after the latest imported visit) and where
 * MatFlow's own check-ins RESUME after it (the day of the first non-imported
 * check-in on or after the history end). Records cover [start, historyEnd)
 * and [resumes, now); a span inside neither is "gap": no records, said as
 * such, never 0. A club with no imported rows keeps one open run from its
 * first record, exactly as before.
 *
 * What this still cannot know: a quiet stretch INSIDE a run. One MatFlow
 * check-in after the export (a staff test, say) resumes the records from that
 * day, and a zero after it reads as real. Nothing in the data tells that from
 * a closure (the At-Risk gate has the same limit).
 *
 * The day is the club's (Tenant.timezone), as every period boundary is
 * (lib/report-period, lib/club-month). Pure apart from the two `readAttendanceCoverage...` reads.
 */
import { usableTimezone, zoneOffsetMs } from "@/lib/class-time";

/**
 * How much of a span the club's records cover:
 *   - "none": the club has no attendance records at all;
 *   - "before": the span ends on or before the coverage start (no records for it);
 *   - "gap": the span lies after the imported history ends and before (or
 *     without) any MatFlow check-in, so there are no records for it either;
 *   - "partial": the span is only partly inside the records (count only what exists);
 *   - "covered": the span lies wholly inside the records (a zero is a real zero).
 */
export type CoverageState = "none" | "before" | "gap" | "partial" | "covered";

/**
 * Where a club's records run: from `start` to `historyEnd` (exclusive; null =
 * no imported history, so one open run), then again from `resumes` (the first
 * MatFlow check-in day on or after the history end; null = none yet). A club
 * that checked people in on MatFlow before its import has check-ins inside the
 * history run too; `resumes` is only the first one after it.
 */
export type CoverageSpans = { start: Date | null; historyEnd: Date | null; resumes: Date | null };

/** The coverage of a statistics page's spans, computed once on the server. */
export type AttendanceCoverage = {
  /** The coverage start (ISO): midnight, club time, of the day of the earliest record. Null when there are no records. */
  start: string | null;
  /** Midnight, club time, after the day of the latest imported visit (ISO); absent = no imported history. */
  historyEnd?: string | null;
  /** Midnight, club time, of the first MatFlow check-in on or after the history end (ISO); null = none yet. */
  resumes?: string | null;
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

type Records = { start: number; historyEnd: number | null; resumes: number | null };
type CoverageInput = Instant | CoverageSpans | Pick<AttendanceCoverage, "start" | "historyEnd" | "resumes"> | null | undefined;

function recordsOf(c: CoverageInput): Records | null {
  if (!c) return null;
  if (typeof c === "string" || c instanceof Date) return { start: ms(c), historyEnd: null, resumes: null };
  if (!c.start) return null;
  return { start: ms(c.start), historyEnd: c.historyEnd ? ms(c.historyEnd) : null, resumes: c.resumes ? ms(c.resumes) : null };
}

/** The coverage of the half-open span [start, end): against a coverage start alone (one open run), or the club's runs. */
export function coverageOf(coverage: CoverageInput, start: Instant, end: Instant): CoverageState {
  const r = recordsOf(coverage);
  if (!r) return "none";
  const s = ms(start);
  const e = ms(end);
  if (e <= r.start) return "before";
  const runs: Array<[number, number]> =
    r.historyEnd === null ? [[r.start, Infinity]] : [[r.start, r.historyEnd], ...(r.resumes !== null ? [[r.resumes, Infinity] as [number, number]] : [])];
  const inside = runs.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(e, to) - Math.max(s, from)), 0);
  if (inside <= 0) return "gap";
  return inside >= e - s ? "covered" : "partial";
}

/** True when a span has no records at all: its figures are "—", never 0. */
export function noCoverage(state: CoverageState | null | undefined): boolean {
  return state === "none" || state === "before" || state === "gap";
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

type NoteCoverage = Pick<AttendanceCoverage, "start" | "timeZone" | "historyEnd" | "resumes">;

/** "27 Oct 2026": the last day of the imported history (the day before its exclusive end). */
function historyLastDay(coverage: NoteCoverage): string {
  return coverageDate(new Date(ms(coverage.historyEnd!) - 1), coverage.timeZone);
}

/** Why a "gap" span has no records, in a few words. */
function gapReason(coverage: NoteCoverage): string {
  return coverage.resumes
    ? `imported history ends ${historyLastDay(coverage)}; MatFlow check-ins from ${coverageDate(coverage.resumes, coverage.timeZone)}`
    : `imported history ends ${historyLastDay(coverage)}; no check-ins recorded in MatFlow since`;
}

/** "Records start 3 Mar 2026", or after an imported history "Records cover 3 Mar 2024 – 27 Oct 2026 (and from 14 Nov 2026)". */
function runsText(coverage: NoteCoverage): string {
  const from = coverageDate(coverage.start!, coverage.timeZone);
  if (!coverage.historyEnd) return `Records start ${from}`;
  const runs = `Records cover ${from} – ${historyLastDay(coverage)}`;
  return coverage.resumes ? `${runs} and from ${coverageDate(coverage.resumes, coverage.timeZone)}` : runs;
}

/**
 * The note in place of a figure for a span with no records:
 * "No attendance recorded yet", "No attendance records for this period
 * (MatFlow's records start 3 Mar 2026)", or after an imported history "No
 * attendance records for this period (imported history ends 27 Oct 2026; no
 * check-ins recorded in MatFlow since)". Null for a span with records.
 */
export function noRecordsNote(coverage: NoteCoverage, state: CoverageState | null | undefined): string | null {
  if (state === "none") return NO_ATTENDANCE_YET;
  if (state !== "before" && state !== "gap") return null;
  if (!coverage.start) return NO_ATTENDANCE_YET;
  if (state === "gap" && coverage.historyEnd) return `No attendance records for this period (${gapReason(coverage)})`;
  return `No attendance records for this period (MatFlow's records start ${coverageDate(coverage.start, coverage.timeZone)})`;
}

/** The label on a figure whose span is only partly inside the records ("Records start 3 Mar 2026", or the runs). Null otherwise. */
export function partialNote(coverage: NoteCoverage, state: CoverageState | null | undefined): string | null {
  if (state !== "partial" || !coverage.start) return null;
  return runsText(coverage);
}

/** The one note a span's figures carry, if any: the no-records note or the partial label. */
export function coverageNote(coverage: NoteCoverage, state: CoverageState | null | undefined): string | null {
  return noRecordsNote(coverage, state) ?? partialNote(coverage, state);
}

/**
 * One chart bar's (or CSV bucket row's) note: "No records (MatFlow's records
 * start 3 Mar 2026)" for a bucket before the records, "No records (imported
 * history ends 27 Oct 2026; ...)" for one after them, "Partly covered (records
 * start 3 Mar 2026)" for a bucket only partly inside them, null when covered.
 */
export function bucketNote(coverage: NoteCoverage, state: CoverageState | null | undefined): string | null {
  if (state === "none" || ((state === "before" || state === "gap" || state === "partial") && !coverage.start)) return NO_ATTENDANCE_YET;
  if (state === "gap" && coverage.historyEnd) return `No records (${gapReason(coverage)})`;
  if (state === "before" || state === "gap") return `No records (MatFlow's records start ${coverageDate(coverage.start!, coverage.timeZone)})`;
  if (state === "partial") {
    const runs = runsText(coverage);
    return `Partly covered (${runs.charAt(0).toLowerCase()}${runs.slice(1)})`;
  }
  return null;
}

/**
 * The comparison text in place of a change when its base is not fully
 * covered, or null when the base is covered and the ordinary change applies.
 */
export function comparisonGap(previous: CoverageState | null | undefined): string | null {
  if (previous === "none" || previous === "before" || previous === "gap") return NO_RECORDS_BEFORE;
  if (previous === "partial") return PARTLY_COVERED_BEFORE;
  return null;
}

/** The slice of a Prisma (transaction) client the coverage read uses. */
export type CoverageClient = {
  attendanceRecord: {
    findFirst(args: {
      where: {
        tenantId: string;
        checkInTime?: { gte: Date };
        checkInMethod?: { not: "import" };
        importJobId?: null;
        OR?: Array<{ checkInMethod: "import" } | { importJobId: { not: null } }>;
      };
      orderBy: { checkInTime: "asc" | "desc" };
      select: { checkInTime: true };
    }): PromiseLike<{ checkInTime: Date } | null>;
  };
  importJob?: {
    findFirst(args: { where: { tenantId: string }; select: { id: true } }): PromiseLike<{ id: string } | null>;
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

/** Midnight, club time, of the club-local day after the one `instant` falls on (DST-safe: 36 h past a midnight is always the next day). */
function nextClubDayStart(instant: Date, timeZone: string | null | undefined): Date {
  return clubDayStart(new Date(clubDayStart(instant, timeZone).getTime() + 36 * 3_600_000), timeZone);
}

/**
 * Where the club's records run (31 Oct 2026): the coverage start and, when it
 * has imported history, the day after its latest imported visit and the first
 * MatFlow check-in day on or after that. Imported = method "import" or an
 * import job: the complement of MATFLOW_CHECKIN_WHERE (lib/dashboard-action-items).
 * The history ends at the day after the last imported VISIT, not at the
 * export time (ImportJob.sourceExportedAt can be a provisional estimate): days
 * between the last visit and the export read "no records", never a zero.
 *
 * Cost: the latest-imported probe walks the club's records from the newest, so
 * a club that never imported is first asked one indexed question instead — does
 * it have any import job at all (ImportJob(tenantId, createdAt))? Every
 * attendance import runs as a job, so none means no imported history. Up to
 * four probes in all. Tenant-scoped by `where`; run it inside
 * withTenantContext so RLS backs the filter.
 */
export async function readAttendanceCoverage(tx: CoverageClient, tenantId: string, timeZone: string | null | undefined): Promise<CoverageSpans> {
  const start = await readAttendanceCoverageStart(tx, tenantId, timeZone);
  if (!start) return { start: null, historyEnd: null, resumes: null };
  if (tx.importJob && !(await tx.importJob.findFirst({ where: { tenantId }, select: { id: true } }))) return { start, historyEnd: null, resumes: null };
  const lastImported = await tx.attendanceRecord.findFirst({
    where: { tenantId, OR: [{ checkInMethod: "import" }, { importJobId: { not: null } }] },
    orderBy: { checkInTime: "desc" },
    select: { checkInTime: true },
  });
  if (!lastImported) return { start, historyEnd: null, resumes: null };
  const historyEnd = nextClubDayStart(lastImported.checkInTime, timeZone);
  const firstAfter = await tx.attendanceRecord.findFirst({
    where: { tenantId, checkInMethod: { not: "import" }, importJobId: null, checkInTime: { gte: historyEnd } },
    orderBy: { checkInTime: "asc" },
    select: { checkInTime: true },
  });
  return { start, historyEnd, resumes: firstAfter ? clubDayStart(firstAfter.checkInTime, timeZone) : null };
}

/** The page-level coverage for a period and the run before it. */
export function attendanceCoverageFor(
  records: Date | CoverageSpans | null,
  timeZoneRaw: string | null | undefined,
  period: { start: Instant; end: Instant },
  previous: { start: Instant; end: Instant },
): AttendanceCoverage {
  const spans: CoverageSpans = records instanceof Date || records === null ? { start: records, historyEnd: null, resumes: null } : records;
  return {
    start: spans.start ? spans.start.toISOString() : null,
    ...(spans.historyEnd ? { historyEnd: spans.historyEnd.toISOString(), resumes: spans.resumes ? spans.resumes.toISOString() : null } : {}),
    timeZone: usableTimezone(timeZoneRaw),
    period: coverageOf(spans, period.start, period.end),
    previous: coverageOf(spans, previous.start, previous.end),
  };
}
