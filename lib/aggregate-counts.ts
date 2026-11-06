/**
 * Counts that used to be one COUNT per figure, read as ONE statement each (S3, 6 Nov 2026). Every call used to be
 * its own round trip inside the page's transaction: about 23 on the dashboard, one per chart bar on Reports.
 *
 * Rules (docs/TENANT-SCOPE-CONVENTION.md; the S3 brief):
 *  - run inside the caller's withTenantContext transaction, so RLS backs every statement;
 *  - every statement filters "tenantId" itself;
 *  - tagged-template parameters only, never $queryRawUnsafe;
 *  - each read returns exactly what the Prisma reads it replaced returned. The Prisma fragments those reads used
 *    (lib/member-population.ts, lib/class-live.ts, lib/dashboard-action-items.ts MATFLOW_CHECKIN_WHERE) are spelled
 *    out here in SQL, so tests/integration/s3-aggregate-parity-db.test.ts runs the old Prisma reads and these side by
 *    side on seeded rows and asserts the same numbers; a change to either side fails it.
 *
 * Dates: the columns are `timestamp(3)` WITHOUT zone holding a UTC wall clock (the Prisma convention). A JS Date goes
 * in as its ISO string cast to `timestamp` (the trailing Z is ignored, so it compares wall clock to wall clock, as
 * Prisma's own filters do — lib/class-allowance-count.ts does the same) and comes back as epoch milliseconds.
 *
 * Type-only imports: lib/dashboard-action-items.ts imports this and is itself imported by client components.
 */
import type { Prisma } from "@prisma/client";

type RawClient = Pick<Prisma.TransactionClient, "$queryRaw">;

const iso = (d: Date) => d.toISOString();

/** A bigint, numeric string or number from a raw row, as a JS number (counts are cast to int in SQL already). */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return 0;
}

function dateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  // Rounded: the column holds whole milliseconds, and a float epoch can land a hair below one (Date would truncate it).
  const ms = Math.round(num(v));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// ── Reports: the attendance chart's bars ──────────────────────────────────────

/**
 * The attendance-scope filter Reports applies to every attendance-derived count (lib/reports.ts `attendanceScope`):
 * the session's class, and the member's account types. Absent = no filter.
 */
export type AttendanceScope = { classId?: string; accountTypes?: readonly string[] };

/** One chart bar's window, half-open [start, end). */
export type CountWindow = { start: Date; end: Date };

/**
 * Row i (1-based, the window's position) → its count, in window order; a window with no row counts 0. Pure, so the
 * mapping is unit-tested apart from the database.
 */
export function windowCountsInOrder(rows: { i: unknown; n: unknown }[], windows: number): number[] {
  const byIndex = new Map(rows.map((r) => [num(r.i), num(r.n)]));
  return Array.from({ length: windows }, (_, k) => byIndex.get(k + 1) ?? 0);
}

/**
 * Check-ins in each window, in ONE statement: what Reports read as one `attendanceRecord.count` per bar. The windows
 * are the ones lib/reports.ts already builds (weeks, or the club's months, clipped to the period) and are passed in
 * unchanged, so every bar counts exactly the rows its old count did.
 *
 * Why not date_trunc('week', …): the bars are not plain calendar weeks. Their edges are clipped to the period, and the
 * weeks start at the server's local midnight, which is what the chart has always drawn and labelled. Grouping by a
 * truncated week in the club's zone would move check-ins between bars in BST and change the numbers. Counting the
 * given windows keeps every figure identical.
 */
export async function countAttendanceInWindows(
  tx: RawClient,
  tenantId: string,
  windows: readonly CountWindow[],
  scope: AttendanceScope = {},
): Promise<number[]> {
  if (windows.length === 0) return [];
  const starts = windows.map((w) => iso(w.start));
  const ends = windows.map((w) => iso(w.end));
  const classId = scope.classId ?? null;
  const accountTypes = scope.accountTypes ? [...scope.accountTypes] : null;
  const rows = await tx.$queryRaw<{ i: unknown; n: unknown }[]>`
    SELECT w."i"::int AS "i", count(a."id")::int AS "n"
      FROM unnest(${starts}::timestamp[], ${ends}::timestamp[]) WITH ORDINALITY AS w("s", "e", "i")
      LEFT JOIN "AttendanceRecord" a
        ON a."tenantId" = ${tenantId}
       AND a."checkInTime" >= w."s"
       AND a."checkInTime" < w."e"
       AND (${classId}::text IS NULL OR EXISTS (
             SELECT 1 FROM "ClassInstance" ci
               JOIN "Class" c ON c."id" = ci."classId" AND c."tenantId" = ${tenantId}
              WHERE ci."id" = a."classInstanceId" AND ci."classId" = ${classId}::text))
       AND (${accountTypes}::text[] IS NULL OR EXISTS (
             SELECT 1 FROM "Member" m
              WHERE m."id" = a."memberId" AND m."tenantId" = ${tenantId} AND m."accountType" = ANY(${accountTypes}::text[])))
     GROUP BY w."i"
     ORDER BY w."i"`;
  return windowCountsInOrder(rows, windows.length);
}

// ── Attendance page: the summary line ─────────────────────────────────────────

export type AttendanceSummaryCounts = { totalThisMonth: number; totalThisWeek: number; uniqueMembersThisMonth: number };

/**
 * The Attendance page's three summary figures in one statement: check-ins since the month start, since the week start,
 * and the members who checked in since the month start (was a groupBy that returned every member to take its length).
 */
export async function readAttendanceSummaryCounts(
  tx: RawClient,
  tenantId: string,
  since: { monthStart: Date; weekStart: Date },
): Promise<AttendanceSummaryCounts> {
  const month = iso(since.monthStart);
  const week = iso(since.weekStart);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT count(*) FILTER (WHERE "checkInTime" >= ${month}::timestamp)::int AS "totalThisMonth",
           count(*) FILTER (WHERE "checkInTime" >= ${week}::timestamp)::int AS "totalThisWeek",
           count(DISTINCT "memberId") FILTER (WHERE "checkInTime" >= ${month}::timestamp)::int AS "uniqueMembersThisMonth"
      FROM "AttendanceRecord"
     WHERE "tenantId" = ${tenantId}
       AND "checkInTime" >= LEAST(${month}::timestamp, ${week}::timestamp)`;
  return attendanceSummaryFromRow(rows[0]);
}

export function attendanceSummaryFromRow(row: Record<string, unknown> | undefined): AttendanceSummaryCounts {
  return {
    totalThisMonth: num(row?.totalThisMonth),
    totalThisWeek: num(row?.totalThisWeek),
    uniqueMembersThisMonth: num(row?.uniqueMembersThisMonth),
  };
}

// ── Dashboard: the tiles and the setup banner ─────────────────────────────────

export type DashboardCounts = {
  /** ACTIVE_MEMBER: status active, not a guardian account. */
  totalActive: number;
  /** TRAINING_MEMBER joined since the month start. */
  newThisMonth: number;
  attendanceThisWeek: number;
  attendanceThisMonth: number;
  /** CAN_TRAIN_MEMBER (active or taster, not a guardian) with no signed waiver. */
  waiverMissing: number;
  /** CAN_TRAIN_MEMBER with no phone (null or empty). */
  missingPhone: number;
  /** Every member row of the club, guardians included (the setup banner's "Add your first members"). */
  memberCount: number;
  /** liveClassWhere: active, not archived, not imported history. */
  liveClassCount: number;
  tierCount: number;
};

/**
 * The dashboard's counts in one statement. Was nine COUNTs: five on Member, two on AttendanceRecord, one each on Class
 * and MembershipTier. "Payments due" is not here: its clause (lib/overdue owesMoneyClause / overduePayerWhere) is
 * shared with Payments → Outstanding and stays a Prisma count so the two cannot drift.
 */
export async function readDashboardCounts(
  tx: RawClient,
  tenantId: string,
  since: { monthStart: Date; weekStart: Date },
): Promise<DashboardCounts> {
  const month = iso(since.monthStart);
  const week = iso(since.weekStart);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT m.*, a.*,
           (SELECT count(*)::int FROM "Class"
             WHERE "tenantId" = ${tenantId} AND "isActive" = true AND "deletedAt" IS NULL AND "sourceImportJobId" IS NULL) AS "liveClassCount",
           (SELECT count(*)::int FROM "MembershipTier" WHERE "tenantId" = ${tenantId}) AS "tierCount"
      FROM (
        SELECT count(*) FILTER (WHERE "accountType" <> 'parent' AND "status" = 'active')::int AS "totalActive",
               count(*) FILTER (WHERE "accountType" <> 'parent' AND "joinedAt" >= ${month}::timestamp)::int AS "newThisMonth",
               count(*) FILTER (WHERE "accountType" <> 'parent' AND "status" IN ('active', 'taster') AND "waiverAccepted" = false)::int AS "waiverMissing",
               count(*) FILTER (WHERE "accountType" <> 'parent' AND "status" IN ('active', 'taster') AND ("phone" IS NULL OR "phone" = ''))::int AS "missingPhone",
               count(*)::int AS "memberCount"
          FROM "Member"
         WHERE "tenantId" = ${tenantId}
      ) m,
      (
        SELECT count(*) FILTER (WHERE "checkInTime" >= ${week}::timestamp)::int AS "attendanceThisWeek",
               count(*) FILTER (WHERE "checkInTime" >= ${month}::timestamp)::int AS "attendanceThisMonth"
          FROM "AttendanceRecord"
         WHERE "tenantId" = ${tenantId}
           AND "checkInTime" >= LEAST(${month}::timestamp, ${week}::timestamp)
      ) a`;
  return dashboardCountsFromRow(rows[0]);
}

export function dashboardCountsFromRow(row: Record<string, unknown> | undefined): DashboardCounts {
  return {
    totalActive: num(row?.totalActive),
    newThisMonth: num(row?.newThisMonth),
    attendanceThisWeek: num(row?.attendanceThisWeek),
    attendanceThisMonth: num(row?.attendanceThisMonth),
    waiverMissing: num(row?.waiverMissing),
    missingPhone: num(row?.missingPhone),
    memberCount: num(row?.memberCount),
    liveClassCount: num(row?.liveClassCount),
    tierCount: num(row?.tierCount),
  };
}

// ── Dashboard: the At-Risk gate's probes ──────────────────────────────────────

/** The gate's edges (lib/dashboard-action-items.ts atRiskGateWindows). */
export type AtRiskGateWindows = { weekBefore: Date; since: Date; mid: Date };

/**
 * The MatFlow check-in times the gate rule reads (lib/dashboard-action-items.ts readAtRiskGate). Each was a findFirst
 * ordered by checkInTime; each is now the min or max of the same rows. A probe the rule does not need is null.
 */
export type AtRiskGateProbes = {
  /** Latest MatFlow check-in in the week before the window. */
  before: Date | null;
  /** Earliest MatFlow check-in since the window start. */
  first: Date | null;
  /** Latest MatFlow check-in before the week before the window. Read only when `before` and `first` are both null. */
  earlier: Date | null;
  /** Earliest MatFlow check-in in the window's first half. Read only when `before` is set. */
  firstHalf: Date | null;
  /** Earliest MatFlow check-in in the window's second half. Read only when `before` is set. */
  secondHalf: Date | null;
};

/**
 * The gate's probes in one statement (were two to four findFirst round trips). A MatFlow check-in is
 * MATFLOW_CHECKIN_WHERE: `checkInMethod <> 'import' AND importJobId IS NULL`. The probes the rule would not have run are
 * behind CASE, and Postgres evaluates an uncorrelated sub-select only when its value is needed, so a club without
 * MatFlow check-ins still walks its imported history only when the old gate did.
 */
export async function readAtRiskGateProbes(tx: RawClient, tenantId: string, w: AtRiskGateWindows): Promise<AtRiskGateProbes> {
  const weekBefore = iso(w.weekBefore);
  const since = iso(w.since);
  const mid = iso(w.mid);
  const rows = await tx.$queryRaw<Record<string, unknown>[]>`
    SELECT (EXTRACT(EPOCH FROM p."before") * 1000)::float8 AS "before",
           (EXTRACT(EPOCH FROM p."first") * 1000)::float8 AS "first",
           (EXTRACT(EPOCH FROM CASE WHEN p."before" IS NULL AND p."first" IS NULL THEN (
              SELECT max("checkInTime") FROM "AttendanceRecord"
               WHERE "tenantId" = ${tenantId} AND "checkInMethod" <> 'import' AND "importJobId" IS NULL
                 AND "checkInTime" < ${weekBefore}::timestamp) END) * 1000)::float8 AS "earlier",
           (EXTRACT(EPOCH FROM CASE WHEN p."before" IS NOT NULL THEN (
              SELECT min("checkInTime") FROM "AttendanceRecord"
               WHERE "tenantId" = ${tenantId} AND "checkInMethod" <> 'import' AND "importJobId" IS NULL
                 AND "checkInTime" >= ${since}::timestamp AND "checkInTime" < ${mid}::timestamp) END) * 1000)::float8 AS "firstHalf",
           (EXTRACT(EPOCH FROM CASE WHEN p."before" IS NOT NULL THEN (
              SELECT min("checkInTime") FROM "AttendanceRecord"
               WHERE "tenantId" = ${tenantId} AND "checkInMethod" <> 'import' AND "importJobId" IS NULL
                 AND "checkInTime" >= ${mid}::timestamp) END) * 1000)::float8 AS "secondHalf"
      FROM (
        SELECT (SELECT max("checkInTime") FROM "AttendanceRecord"
                 WHERE "tenantId" = ${tenantId} AND "checkInMethod" <> 'import' AND "importJobId" IS NULL
                   AND "checkInTime" >= ${weekBefore}::timestamp AND "checkInTime" < ${since}::timestamp) AS "before",
               (SELECT min("checkInTime") FROM "AttendanceRecord"
                 WHERE "tenantId" = ${tenantId} AND "checkInMethod" <> 'import' AND "importJobId" IS NULL
                   AND "checkInTime" >= ${since}::timestamp) AS "first"
      ) p`;
  return atRiskProbesFromRow(rows[0]);
}

export function atRiskProbesFromRow(row: Record<string, unknown> | undefined): AtRiskGateProbes {
  return {
    before: dateOrNull(row?.before),
    first: dateOrNull(row?.first),
    earlier: dateOrNull(row?.earlier),
    firstHalf: dateOrNull(row?.firstHalf),
    secondHalf: dateOrNull(row?.secondHalf),
  };
}
