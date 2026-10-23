import { unstable_cache } from "next/cache";
import { withTenantContext } from "@/lib/prisma-tenant";
import { noPaymentYetPayerWhere, overduePayerWhere } from "@/lib/overdue";
import { loadOtherAccountsOwing, otherOwingTotals } from "@/lib/other-accounts-owing";
import { ACTIVE_MEMBER, GUARDIAN_ACCOUNT, LEFT_MEMBER, ON_HOLD, TRAINING_MEMBER, isActiveMember } from "@/lib/member-population";
import { percent, ratePct1dp } from "@/lib/percent";
import { clubMonthKey, clubMonthWindow, defaultClubMonthWindow, monthRange, type ClubMonthWindow } from "@/lib/club-month";
import { emptyMembershipReport, loadMembershipReport, type MembershipReport } from "@/lib/membership-report";
import { joinedOf } from "@/lib/membership-movement";

export type { MembershipReport } from "@/lib/membership-report";

export interface ClassOption {
  id: string;
  name: string;
}

/**
 * Track G (2026-09-22): the attendance-rate DEFINITION is now customisable —
 * the owner picks which one metric the "Check-ins" figure means, instead of
 * a fixed implicit average. All three modes are computed from the SAME
 * windowed attendance data the rest of this file already fetches (no extra
 * queries, no divergent window) so the number always agrees with the charts
 * on the same page.
 *
 * `fillRate` uses `Class.maxCapacity` (prisma/schema.prisma) — real schema
 * support, so it is not dropped; a tenant that never set capacity on any
 * class simply reads "—" (see `computeAttendanceRate` below), which is an
 * honest empty state, not a missing feature.
 */
export type AttendanceRateMode = "checkins-per-member" | "attendance-percentage" | "fill-rate";

export interface AttendanceRateModeOption {
  mode: AttendanceRateMode;
  label: string;
  /** One-line explanation of the formula, shown as the selector's tooltip. */
  formula: string;
}

export interface AttendanceRate {
  mode: AttendanceRateMode;
  /** null when the formula's denominator is honestly zero for this tenant/window — render "—", never NaN or 0. */
  value: number | null;
  label: string;
  formula: string;
  /**
   * T2b (17 Oct 2026): the two counts behind `value`, so the readout and the
   * CSV can show "x% (n of m)" — check-ins and active members for the
   * per-member average, attendees and active members for the percentage,
   * check-ins and class places for the fill rate.
   */
  numerator: number;
  denominator: number;
}

/**
 * T2b (17 Oct 2026, owner decision Q6): every percentage on Reports carries
 * its numerator and denominator. `ratePct` is null exactly when the base is
 * 0 — the screen renders "—", never "0%" (MATFLOW-SPECIFICATION-2026-10.md
 * :144 "divide-by-zero → null", extended to every ratio here).
 */
export interface ChurnFigures {
  /** cancelled ÷ base × 100, one decimal place; null when base is 0. */
  ratePct: number | null;
  /** Training members whose cancelledAt falls in this calendar month. */
  cancelled: number;
  /** Active training members now + `cancelled` (the existing formula's base). */
  base: number;
  /**
   * D11: Joined this month by the movement definition — new + rejoined
   * (lib/membership-movement.ts), the same figure as the Net New Members
   * card. Tasters and imports are not joins.
   */
  joined: number;
  /** The movement net for the month: new + rejoined − left. */
  net: number;
}

export interface ReportsData {
  /**
   * When these numbers were computed (ISO). The cached read
   * (`getReportsDataCached`) serves a result for up to 60 seconds, so the
   * page shows this rather than implying the figures are live; a report a
   * minute old is fine, a report that claims to be live and is not is not
   * (UI-RULES §7).
   */
  generatedAt: string;
  /**
   * The calendar month every "this month" figure counts (review L4, 23 Oct
   * 2026): resolved ONCE, in the club's time zone (Tenant.timezone), as the
   * half-open window [monthStart, nextMonthStart). Joined this month,
   * cancelled this month, churn and the monthly buckets all use it; the
   * drill-through links carry its `monthKey` so the Members page lists the
   * same month even if the calendar has turned since this was computed.
   */
  period: ClubMonthWindow;
  /**
   * Width of the reporting window, in weeks (4-24, default 12). Every
   * attendance-derived figure below — `summary.totalCheckIns`,
   * `checkInMethods`, `topClasses`, `weeklyAttendance` — covers exactly this
   * window, not all time (audit memory-storage 2026-08-16 P1-12). The UI
   * labels these numbers with it so they never read as lifetime totals.
   */
  weeksBack: number;
  /**
   * Every active, non-deleted class for this tenant — the options list for
   * the class-filter control. Not filtered by the currently-applied
   * `filters.classId`, so the dropdown always offers every class even when
   * one is selected.
   */
  classOptions: ClassOption[];
  /**
   * The class/age-group filters actually applied to THIS response. Echoed
   * back rather than trusted from the request so the UI can label filtered
   * tiles honestly even if the URL and the data ever disagree (e.g. a
   * classId that no longer resolves to a class gets silently dropped below,
   * not applied as a phantom filter).
   *
   * Scope (Track A, 2026-09-21): these two filters only narrow the
   * attendance-derived figures — `summary.totalCheckIns`,
   * `summary.attendanceThisWeek`, `summary.attendanceLastWeek`,
   * `weeklyAttendance`, `checkInMethods`, `topClasses`. Growth, churn,
   * retention and payment health are membership-lifecycle metrics, not
   * attendance records, and are NOT scoped by class or age group — they
   * stay tenant-wide regardless of these filters. The UI must not label
   * them as filtered.
   */
  filters: {
    classId: string | null;
    className: string | null;
    ageGroup: "adult" | "kids" | null;
  };
  summary: {
    /** Every training member on record, in any status — including those who have left. */
    totalMembers: number;
    /**
     * T2b: current training members — active, inactive and tasters (not
     * cancelled, not guardians; CURRENT_MEMBER). The denominator of the
     * status shares and of "x% of current members are active".
     */
    currentMembers: number;
    activeMembers: number;
    inactiveMembers: number;
    cancelledMembers: number;
    tasterMembers: number;
    /**
     * Active training members whose membership is on hold (ACTIVE_MEMBER +
     * ON_HOLD). They stay inside activeMembers (owner decision Q4 A-1) and the
     * tile marks them: "includes N on hold".
     */
    activeOnHoldMembers: number;
    totalCheckIns: number;
    totalActiveClasses: number;
    attendanceThisWeek: number;
    attendanceLastWeek: number;
    newMembersThisMonth: number;
    newMembersLastMonth: number;
  };
  weeklyAttendance: { week: string; count: number; isCurrentWeek: boolean }[];
  monthlySignups: { month: string; count: number; isCurrentMonth: boolean }[];
  /**
   * @deprecated All-time partition (percentages over every training member
   * ever recorded, cancelled included). Kept so the shape stays additive;
   * the screen and the CSV read `currentMembersByStatus` instead (T2b, Q4
   * A-2 split status card).
   */
  membersByStatus: { status: string; label: string; count: number; percentage: number }[];
  /**
   * T2b: current members only (no cancelled row), each share over
   * `summary.currentMembers`, so the rows add to 100% ± rounding. Members
   * who have left are `summary.cancelledMembers`, shown as a count with no
   * percentage.
   */
  currentMembersByStatus: { status: string; label: string; count: number; percentage: number }[];
  checkInMethods: { method: string; label: string; count: number; percentage: number }[];
  topClasses: {
    name: string;
    count: number;
    sessions: number;
    averageAttendance: number;
    fillRate: number | null;
    /** T2b: the class places behind `fillRate` (0 when no session had capacity set). */
    capacityTotal: number;
  }[];
  /** Kept for compatibility (tests/e2e/full-app-qa.spec.ts reads it); 0 when the base is 0. Prefer `churn`. */
  churnRate: number;
  /** T2b: churn with its counts, and joined beside it for the same month. */
  churn: ChurnFigures;
  retentionRate: number | null;
  /** T2b: the counts behind `retentionRate` (members who joined 6+ months ago, and how many are still active). */
  retention: { ratePct: number | null; survived: number; cohort: number };
  /**
   * @deprecated Joins by joinedAt against members currently cancelled, by
   * cancelledAt (a rejoin vanishes). Kept so the shape stays additive; the Net
   * New Members card and the CSV read `membership` instead (T8c).
   */
  netNewByMonth: { month: string; joined: number; cancelled: number; net: number }[];
  /**
   * T8c: movement (new, rejoined, lost incl. completed course, net) and
   * active-member headcount per club month, replayed from status history
   * (lib/membership-movement.ts). The current month's headcount equals
   * `summary.activeMembers`. Club-wide: never scoped by the class or age filter.
   */
  membership: MembershipReport;
  /**
   * Money totals count PAYERS, not members (review L2, 23 Oct 2026): active
   * and taster accounts of any type, guardians who pay included (lib/overdue
   * overduePayerWhere / noPaymentYetPayerWhere — the Payments → Outstanding
   * and Members "Payers overdue" definition). Overdue and "No payment yet"
   * never overlap; together they are the Outstanding list.
   */
  paymentHealth: {
    /** Payers overdue, by Stripe or by a passed due date. */
    overdueCount: number;
    /** How many of `overdueCount` are parent or guardian accounts. */
    overdueGuardianCount: number;
    /** Payers on a plan with no payment ever recorded, MatFlow-billed. */
    noPaymentYetCount: number;
    /** How many of `noPaymentYetCount` are parent or guardian accounts. */
    noPaymentYetGuardianCount: number;
    /**
     * D9 (23 Oct 2026): inactive or cancelled accounts that still owe — a
     * failed latest charge or marked overdue (lib/other-accounts-owing.ts).
     * Not chased, not in `overdueCount`, not in any member total.
     */
    otherOwingCount: number;
    /** How many of `otherOwingCount` are parent or guardian accounts. */
    otherOwingGuardianCount: number;
    failedLast30Days: number;
    recoveryRate: number | null;
    /** T2b: the counts behind `recoveryRate` (members with a failed payment in 90 days, and how many are now paid). */
    recovery: { ratePct: number | null; recovered: number; failedMembers: number };
  };
  /** The active attendance-rate definition, computed and labelled. */
  attendanceRate: AttendanceRate;
  /** Every selectable definition, for the UI's picker — label + formula, no hardcoding on the client. */
  attendanceRateModes: AttendanceRateModeOption[];
}

const DEFAULT_WEEKS = 12;

const METHOD_LABELS: Record<string, string> = {
  qr: "QR",
  admin: "Admin",
  self: "Self",
  auto: "Auto",
  kiosk: "Kiosk",
  import: "Imported",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  inactive: "Inactive",
  cancelled: "Cancelled",
  taster: "Taster",
};

const DEFAULT_ATTENDANCE_RATE_MODE: AttendanceRateMode = "checkins-per-member";

const ATTENDANCE_RATE_MODES: AttendanceRateModeOption[] = [
  {
    mode: "checkins-per-member",
    label: "Check-ins per active member",
    formula: "Total check-ins ÷ active members, this window.",
  },
  {
    mode: "attendance-percentage",
    label: "Members who attended",
    formula: "Active members with at least one check-in this window ÷ active members.",
  },
  {
    mode: "fill-rate",
    label: "Class fill rate",
    formula: "Check-ins ÷ total class capacity, for classes with capacity set, this window.",
  },
];

function resolveAttendanceRateMode(value: string | undefined): AttendanceRateMode {
  return ATTENDANCE_RATE_MODES.some((m) => m.mode === value)
    ? (value as AttendanceRateMode)
    : DEFAULT_ATTENDANCE_RATE_MODE;
}

/**
 * Divide-by-zero safe by construction: every branch returns `null` (never
 * NaN) when its denominator is honestly zero, and ReportsView renders that
 * as "—" (UI-RULES §7 — an honest empty state, not a fabricated 0).
 */
function computeAttendanceRate(
  mode: AttendanceRateMode,
  data: {
    totalCheckIns: number;
    activeMembers: number;
    distinctAttendingMembers: number;
    capacitySum: number;
    attendedAgainstCapacity: number;
  },
): AttendanceRate {
  const meta = ATTENDANCE_RATE_MODES.find((m) => m.mode === mode) ?? ATTENDANCE_RATE_MODES[0];
  let value: number | null;
  let numerator: number;
  let denominator: number;
  switch (mode) {
    case "attendance-percentage":
      numerator = data.distinctAttendingMembers;
      denominator = data.activeMembers;
      value = denominator > 0 ? percent(numerator, denominator) : null;
      break;
    case "fill-rate":
      numerator = data.attendedAgainstCapacity;
      denominator = data.capacitySum;
      value = denominator > 0 ? percent(numerator, denominator) : null;
      break;
    case "checkins-per-member":
    default:
      numerator = data.totalCheckIns;
      denominator = data.activeMembers;
      value = denominator > 0 ? roundedAverage(numerator, denominator) : null;
      break;
  }
  return { mode, value, label: meta.label, formula: meta.formula, numerator, denominator };
}

function titleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function clampWeeks(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_WEEKS;
  return Math.min(Math.max(Math.trunc(value ?? DEFAULT_WEEKS), 4), 24);
}

function startOfWeek(date: Date) {
  const d = new Date(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatWeek(date: Date) {
  return `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })}`;
}

function formatMonth(date: Date, timeZone: string) {
  return date.toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone });
}

function roundedAverage(total: number, sessions: number) {
  if (sessions <= 0) return 0;
  return Math.round((total / sessions) * 10) / 10;
}

export function createEmptyReportsData(): ReportsData {
  return {
    generatedAt: new Date().toISOString(),
    period: defaultClubMonthWindow(),
    weeksBack: DEFAULT_WEEKS,
    classOptions: [],
    filters: { classId: null, className: null, ageGroup: null },
    summary: {
      totalMembers: 0,
      currentMembers: 0,
      activeMembers: 0,
      inactiveMembers: 0,
      cancelledMembers: 0,
      tasterMembers: 0,
      activeOnHoldMembers: 0,
      totalCheckIns: 0,
      totalActiveClasses: 0,
      attendanceThisWeek: 0,
      attendanceLastWeek: 0,
      newMembersThisMonth: 0,
      newMembersLastMonth: 0,
    },
    weeklyAttendance: [],
    monthlySignups: [],
    membersByStatus: [],
    currentMembersByStatus: [],
    checkInMethods: [],
    topClasses: [],
    churnRate: 0,
    churn: { ratePct: null, cancelled: 0, base: 0, joined: 0, net: 0 },
    retentionRate: null,
    retention: { ratePct: null, survived: 0, cohort: 0 },
    netNewByMonth: [],
    membership: emptyMembershipReport(),
    paymentHealth: {
      overdueCount: 0,
      overdueGuardianCount: 0,
      noPaymentYetCount: 0,
      noPaymentYetGuardianCount: 0,
      otherOwingCount: 0,
      otherOwingGuardianCount: 0,
      failedLast30Days: 0,
      recoveryRate: null,
      recovery: { ratePct: null, recovered: 0, failedMembers: 0 },
    },
    attendanceRate: computeAttendanceRate(DEFAULT_ATTENDANCE_RATE_MODE, {
      totalCheckIns: 0,
      activeMembers: 0,
      distinctAttendingMembers: 0,
      capacitySum: 0,
      attendedAgainstCapacity: 0,
    }),
    attendanceRateModes: ATTENDANCE_RATE_MODES,
  };
}

// Member.accountType is a free CHECK string: adult | junior | kids | parent
// (see prisma/schema.prisma). A "parent" is an account holder managing a
// child, never a class attendee: it is in NEITHER bucket (2 Oct 2026,
// acceptance P1 — guardian drafts an import makes were inflating the adult
// denominator of the attendance rate). lib/member-population.ts says the same.
const ADULT_ACCOUNT_TYPES = ["adult"];
const KIDS_ACCOUNT_TYPES = ["kids", "junior"];

export async function getReportsData(
  tenantId: string,
  options: {
    weeksBack?: number;
    classId?: string;
    ageGroup?: "adult" | "kids";
    attendanceRateMode?: string;
  } = {},
): Promise<ReportsData> {
  const weeksBack = clampWeeks(options.weeksBack);
  const requestedClassId = options.classId?.trim() || undefined;
  const ageGroup = options.ageGroup === "adult" || options.ageGroup === "kids" ? options.ageGroup : undefined;
  const attendanceRateMode = resolveAttendanceRateMode(options.attendanceRateMode);

  // Class-filter dropdown options — every active, undeleted class. Fetched
  // up front (not inside the big parallel block below) because the requested
  // classId has to be validated against it BEFORE building the attendance
  // filter: a stale or foreign id must resolve to "no filter", never to a
  // real-but-empty filter that would make the whole tenant's attendance
  // silently read as zero (UI-RULES §7 — an honest empty state must come
  // from an honest query, not a filter nobody asked for).
  // The club's zone is read in the same transaction: every month window below
  // is the CLUB's calendar month, not the server's (review L4).
  const [classOptionsRaw, club] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.class.findMany({
        where: { tenantId, isActive: true, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    ]),
  );
  const resolvedClassId = requestedClassId && classOptionsRaw.some((c) => c.id === requestedClassId)
    ? requestedClassId
    : undefined;

  const now = new Date();
  const currentWeekStart = startOfWeek(now);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const weeklyWindowStart = addDays(currentWeekStart, -(weeksBack - 1) * 7);
  // Club-zone months, half-open [start, next start). The server's own zone
  // (UTC on Vercel) and the reader's browser zone play no part (review L4).
  const period = clubMonthWindow(now, club?.timezone);
  const thisMonth = monthRange(period);
  const chartMonths = [5, 4, 3, 2, 1, 0].map((back) => clubMonthWindow(now, period.timeZone, -back));
  const sixMonthsAgo = new Date(chartMonths[0].monthStart);

  // Attendance-scope filter fragment (Track A, D5): merged into every
  // attendance-derived query below. `classInstance: { classId }` and
  // `member: { accountType: { in: [...] } }` are ordinary Prisma relation
  // filters — real queries, not a client-side narrowing of an unfiltered
  // fetch, so an honestly-empty result (e.g. a class with no kids' attendance
  // this window) reads as a real zero rather than a fabricated one.
  const attendanceScope = {
    ...(resolvedClassId ? { classInstance: { classId: resolvedClassId } } : {}),
    ...(ageGroup ? { member: { accountType: { in: ageGroup === "adult" ? ADULT_ACCOUNT_TYPES : KIDS_ACCOUNT_TYPES } } } : {}),
  };

  const [
    weeklyRecords,
    methodCounts,
    memberStatusCounts,
    topResult, // Lane 1 iter-1 P-03: { topRaw, instances } — in-tx continuation
    totalMembers,
    totalCheckIns,
    totalActiveClasses,
    attendanceThisWeek,
    attendanceLastWeek,
    cancelledThisMonth,
    activeCount,
    retentionBase,
    retentionActive,
    overdueCount,
    overdueGuardianCount,
    noPaymentYetCount,
    noPaymentYetGuardianCount,
    failedLast30,
    membersWithRecentFailed,
    cancelledByMonth,
    activeOnHoldMembers,
    otherOwingRows,
  ] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.attendanceRecord.findMany({
        where: { tenantId, checkInTime: { gte: weeklyWindowStart }, ...attendanceScope },
        // memberId added (Track G) for the "members who attended" rate mode
        // below — same rows already fetched for the weekly chart, no new
        // query, so the distinct-attendee count shares the identical window
        // and filter scope as everything else on this page.
        select: { checkInTime: true, memberId: true, member: { select: { status: true, accountType: true } } },
        take: 10000,
      }).then((rows) => {
        if (rows.length === 10000) console.warn("[reports] truncated at 10000 rows (attendance window)");
        return rows;
      }),
      // Audit memory-storage 2026-08-16 P1-12: this and the two aggregates
      // below used to run all-time, so every reports visit re-scanned the
      // tenant's whole attendance history with zero caching. They now share
      // the `weeklyWindowStart` window the rest of the page already uses —
      // the UI labels say "last N weeks" to match.
      tx.attendanceRecord.groupBy({
        by: ["checkInMethod"],
        where: { tenantId, checkInTime: { gte: weeklyWindowStart }, ...attendanceScope },
        _count: true,
      }),
      tx.member.groupBy({
        by: ["status"],
        where: { tenantId, ...TRAINING_MEMBER },
        _count: true,
      }),
      // Lane 1 iter-1 P-03 [Critical] fix: fold the previously-separate
      // `withTenantContext` (lines 257-263) into this same parallel block.
      // The follow-up `classInstance.findMany` for top-class names depended
      // on `topRaw.classInstanceId` — it used to run in its own transaction,
      // doubling Neon connection pressure under report concurrency. Doing
      // the dependent resolve as a continuation keeps it inside ONE pooled
      // connection while still running parallel with the other queries.
      tx.attendanceRecord
        .groupBy({
          by: ["classInstanceId"],
          where: { tenantId, checkInTime: { gte: weeklyWindowStart }, ...attendanceScope },
          _count: true,
          orderBy: { _count: { classInstanceId: "desc" } },
          take: 200,
        })
        .then(async (topRaw) => {
          const instanceIds = topRaw.map((row) => row.classInstanceId);
          // Resolve names BEFORE returning so the inferred type of `instances`
          // includes the `class` relation. An empty findMany still gives the
          // right type, so we no longer need the `[]`-cast shortcut.
          const instances = instanceIds.length
            ? await tx.classInstance.findMany({
                where: { id: { in: instanceIds } },
                include: { class: { select: { name: true, maxCapacity: true } } },
              })
            : await tx.classInstance.findMany({
                where: { id: "__never__" },
                include: { class: { select: { name: true, maxCapacity: true } } },
              });
          return { topRaw, instances };
        }),
      tx.member.count({ where: { tenantId, ...TRAINING_MEMBER } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: weeklyWindowStart }, ...attendanceScope } }),
      tx.class.count({ where: { tenantId, isActive: true } }),
      tx.attendanceRecord.count({
        where: { tenantId, checkInTime: { gte: currentWeekStart }, ...attendanceScope },
      }),
      tx.attendanceRecord.count({
        where: {
          tenantId,
          checkInTime: { gte: previousWeekStart, lt: currentWeekStart },
          ...attendanceScope,
        },
      }),
      // Health metrics — churn (D1: date by cancelledAt, not updatedAt, so an
      // unrelated edit to a cancelled member doesn't re-bucket them into churn)
      tx.member.count({ where: { tenantId, ...LEFT_MEMBER, cancelledAt: thisMonth } }),
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
      // Retention: joined ≥6 months ago
      tx.member.count({ where: { tenantId, joinedAt: { lt: sixMonthsAgo }, ...TRAINING_MEMBER } }),
      tx.member.count({ where: { tenantId, joinedAt: { lt: sixMonthsAgo }, ...ACTIVE_MEMBER } }),
      // Payment health (review L2): PAYERS, the definition Payments →
      // Outstanding and the Members "Payers overdue" tile share. It used to be
      // Stripe's stored "overdue" only, so a cash member past their due date
      // was on Outstanding and missing here. Guardians who pay are counted —
      // a debt is never dropped — and how many of them is reported beside.
      tx.member.count({ where: { tenantId, ...overduePayerWhere(now) } }),
      tx.member.count({ where: { tenantId, ...GUARDIAN_ACCOUNT, ...overduePayerWhere(now) } }),
      // Payers who owe without being overdue — never "all in good standing" while
      // Payments → Outstanding lists them (end-user check, 30 Sep 2026).
      tx.member.count({ where: { tenantId, ...noPaymentYetPayerWhere() } }),
      tx.member.count({ where: { tenantId, ...GUARDIAN_ACCOUNT, ...noPaymentYetPayerWhere() } }),
      tx.payment.count({ where: { tenantId, status: "failed", createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
      tx.payment.findMany({
        where: { tenantId, status: "failed", createdAt: { gte: new Date(Date.now() - 90 * 86400000) } },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
      // Net-new chart: members cancelled in the last 6 months (D1: by cancelledAt)
      tx.member.findMany({
        where: { tenantId, ...LEFT_MEMBER, cancelledAt: { gte: sixMonthsAgo } },
        select: { cancelledAt: true },
      }),
      // Q4 A-1: members on hold stay inside "Active members" and are marked there.
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER, ...ON_HOLD } }),
      // D9: inactive or cancelled accounts that still owe — counted beside
      // the payers, never inside them or a member total.
      loadOtherAccountsOwing(tx, tenantId),
    ]),
    // ~12 parallel aggregate queries in one transaction — needs more than the
    // default budget on large tenants (was expiring with P2028/commit-expired).
    { maxWait: 10_000, timeout: 30_000 },
  );

  const weeklyMap = new Map<number, { week: string; count: number; isCurrentWeek: boolean }>();
  for (let i = 0; i < weeksBack; i++) {
    const d = addDays(weeklyWindowStart, i * 7);
    weeklyMap.set(d.getTime(), {
      week: formatWeek(d),
      count: 0,
      isCurrentWeek: d.getTime() === currentWeekStart.getTime(),
    });
  }

  // Distinct ACTIVE attendees this window — the "members who attended" rate
  // mode's numerator (only active members count; see the loop below). Built from
  // the same `weeklyRecords` fetch as the chart above, so it shares the identical
  // window and class/age scope (Track G).
  const distinctAttendingMemberIds = new Set<string>();

  for (const rec of weeklyRecords) {
    const week = startOfWeek(rec.checkInTime).getTime();
    const bucket = weeklyMap.get(week);
    if (bucket) bucket.count += 1;
    // "Members who attended" is an ACTIVE-member engagement rate, so its
    // numerator must stay within the active-member denominator. An ex-member
    // (cancelled/inactive) whose check-in falls in the window used to be counted
    // here, which could push the rate past 100% — count a distinct attendee only
    // while they are currently active. The weekly chart bucket above still counts
    // every check-in regardless of status.
    // The denominator is ACTIVE_MEMBER, which leaves guardian accounts out, so
    // the numerator uses the same predicate: a guardian's check-in is never a
    // "(n of m)" person who is missing from m.
    if (rec.member && isActiveMember(rec.member)) distinctAttendingMemberIds.add(rec.memberId);
  }

  // T8c: movement and headcount, in its own read (one events findMany plus the
  // ledger when the back-fill has not been applied), after the block above so
  // the report never holds two pooled connections at once.
  const membership = await withTenantContext(
    tenantId,
    (tx) => loadMembershipReport(tx, tenantId, { now }),
    { maxWait: 10_000, timeout: 30_000 },
  );
  // D11 (23 Oct 2026): every "joined" on the page is the movement definition
  // (lib/membership-movement.ts) — never Member.joinedAt — so the tiles, the
  // charts, the CSV and the Members drill-throughs count the same events.
  const moveIn = (monthKey: string) => membership.movementsByMonth.find((r) => r.month === monthKey && r.basis !== "none") ?? null;
  const thisMonthMoves = moveIn(period.monthKey);
  const lastMonthMoves = moveIn(clubMonthWindow(now, period.timeZone, -1).monthKey);
  const newMembersThisMonth = thisMonthMoves?.new ?? 0;
  const newMembersLastMonth = lastMonthMoves?.new ?? 0;

  // Buckets keyed by the club-zone month ("2026-10") and labelled in that
  // zone: joined (new + rejoined) by the movement definition (D11).
  const monthlyMap = new Map<string, { month: string; count: number; isCurrentMonth: boolean }>();
  for (const w of chartMonths) {
    const moves = moveIn(w.monthKey);
    monthlyMap.set(w.monthKey, {
      month: formatMonth(new Date(w.monthStart), period.timeZone),
      count: moves ? joinedOf(moves) : 0,
      isCurrentMonth: w.monthKey === period.monthKey,
    });
  }

  const statusCount = new Map(memberStatusCounts.map((row) => [row.status, row._count]));
  const membersByStatus = memberStatusCounts
    .map((row) => ({
      status: row.status,
      label: STATUS_LABELS[row.status] ?? titleCase(row.status),
      count: row._count,
      percentage: percent(row._count, totalMembers),
    }))
    .sort((a, b) => b.count - a.count);

  // Q4 A-2 (split status card, T2b): shares over CURRENT members only, so a
  // cancelled slice is never a share of the people still on the books. The
  // count of those who left is `summary.cancelledMembers`, shown on its own.
  const currentRows = memberStatusCounts.filter((row) => row.status !== "cancelled");
  const currentMembers = currentRows.reduce((sum, row) => sum + row._count, 0);
  const currentMembersByStatus = currentRows
    .map((row) => ({
      status: row.status,
      label: STATUS_LABELS[row.status] ?? titleCase(row.status),
      count: row._count,
      percentage: percent(row._count, currentMembers),
    }))
    .sort((a, b) => b.count - a.count);

  const totalMethodCount = methodCounts.reduce((sum, row) => sum + row._count, 0);
  const checkInMethods = methodCounts
    .map((row) => ({
      method: row.checkInMethod,
      label: METHOD_LABELS[row.checkInMethod] ?? titleCase(row.checkInMethod),
      count: row._count,
      percentage: percent(row._count, totalMethodCount),
    }))
    .sort((a, b) => b.count - a.count);

  // Lane 1 iter-1 P-03 fix: topRaw + instances now arrive together from
  // the in-transaction continuation (see groupBy.then above).
  const { topRaw, instances } = topResult;

  const instancesById = new Map(instances.map((instance) => [instance.id, instance]));
  const classStats = new Map<
    string,
    { count: number; sessions: Set<string>; capacityTotal: number }
  >();

  for (const row of topRaw) {
    const instance = instancesById.get(row.classInstanceId);
    if (!instance) continue;

    const name = instance.class.name;
    const existing = classStats.get(name) ?? { count: 0, sessions: new Set<string>(), capacityTotal: 0 };
    existing.count += row._count;
    existing.sessions.add(row.classInstanceId);
    if (typeof instance.class.maxCapacity === "number" && instance.class.maxCapacity > 0) {
      existing.capacityTotal += instance.class.maxCapacity;
    }
    classStats.set(name, existing);
  }

  const topClasses = Array.from(classStats.entries())
    .map(([name, stats]) => {
      const sessions = stats.sessions.size;
      return {
        name,
        count: stats.count,
        sessions,
        averageAttendance: roundedAverage(stats.count, sessions),
        fillRate: stats.capacityTotal > 0 ? percent(stats.count, stats.capacityTotal) : null,
        capacityTotal: stats.capacityTotal,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Tenant-wide fill-rate inputs for the "fill-rate" attendance-rate mode
  // (Track G) — only classes with `maxCapacity` set contribute to either
  // side, same honesty rule as each class's own `fillRate` above: a class
  // with no capacity configured neither inflates the numerator nor pads the
  // denominator. Built from `classStats`, the SAME windowed groupBy already
  // fetched for "Top Classes" — no new query, no divergent window.
  let capacitySum = 0;
  let attendedAgainstCapacity = 0;
  for (const stats of classStats.values()) {
    if (stats.capacityTotal > 0) {
      capacitySum += stats.capacityTotal;
      attendedAgainstCapacity += stats.count;
    }
  }

  // ── Health metrics ───────────────────────────────────────────────────────

  // Owner decision Q6 (17 Oct 2026): keep the existing formula — cancelled
  // this month ÷ (active now + cancelled this month) — but return its counts
  // so every surface prints "x% (n of m)". An empty base is null ("—"), not
  // the "0%" the old Math.max(…, 1) produced; `churnRate` keeps that number
  // only for its existing numeric readers.
  const churnBase = activeCount + cancelledThisMonth;
  const churnPct = ratePct1dp(cancelledThisMonth, churnBase);
  const churn: ChurnFigures = {
    ratePct: churnPct,
    cancelled: cancelledThisMonth,
    base: churnBase,
    joined: thisMonthMoves ? joinedOf(thisMonthMoves) : 0,
    net: thisMonthMoves?.net ?? 0,
  };
  const churnRate = churnPct ?? 0;

  // 0/0 is "no data", not "perfect": a club with no members who joined 6+
  // months ago has an UNDEFINED survival rate — surface it as null → "—", not a
  // fake 100% (same honesty rule as the attendance-rate modes).
  const retentionRate = ratePct1dp(retentionActive, retentionBase);

  // Recovery rate: of members with a failed payment in the last 90 days,
  // what fraction now have paymentStatus='paid'?
  const failedMemberIds = membersWithRecentFailed
    .map((r) => r.memberId)
    .filter((id): id is string => id !== null);

  const recoveredCount = failedMemberIds.length > 0
    ? await withTenantContext(tenantId, (tx) =>
        tx.member.count({ where: { id: { in: failedMemberIds }, tenantId, paymentStatus: "paid" } }),
      )
    : 0;

  // No members had a failed payment → recovery rate is UNDEFINED (nothing to
  // recover), not 100%. null → "—" so the metric never claims a fake success.
  const recoveryRate = ratePct1dp(recoveredCount, failedMemberIds.length);

  // The rate readout's denominator must carry the SAME age scope as its
  // numerator: under "Kids" the check-ins are kids' check-ins, so the "active
  // members" they are divided by must be active KIDS — otherwise the formula
  // the tooltip promises ("check-ins ÷ active members") is not the one
  // computed (Reports UX assessment, lane 6, 2026-09-23). Club-wide when no
  // age filter is set, so the summary tile and the readout agree there. One
  // extra count, only when an age group is selected.
  const scopedActiveMembers = ageGroup
    ? await withTenantContext(tenantId, (tx) =>
        tx.member.count({
          where: {
            tenantId,
            status: "active",
            accountType: { in: ageGroup === "adult" ? ADULT_ACCOUNT_TYPES : KIDS_ACCOUNT_TYPES },
          },
        }),
      )
    : statusCount.get("active") ?? 0;

  // Net-new by month: join monthlyMap (joined) with cancelledByMonth (cancelled)
  const cancelledByMonthMap = new Map<string, number>();
  for (const row of cancelledByMonth) {
    if (!row.cancelledAt) continue;
    const key = clubMonthKey(row.cancelledAt, period.timeZone);
    cancelledByMonthMap.set(key, (cancelledByMonthMap.get(key) ?? 0) + 1);
  }

  const netNewByMonth = Array.from(monthlyMap.entries()).map(([key, bucket]) => {
    const cancelled = cancelledByMonthMap.get(key) ?? 0;
    return {
      month: bucket.month,
      joined: bucket.count,
      cancelled,
      net: bucket.count - cancelled,
    };
  });

  const resolvedClass = resolvedClassId
    ? classOptionsRaw.find((c) => c.id === resolvedClassId) ?? null
    : null;

  return {
    period,
    weeksBack,
    classOptions: classOptionsRaw,
    filters: {
      classId: resolvedClass?.id ?? null,
      className: resolvedClass?.name ?? null,
      ageGroup: ageGroup ?? null,
    },
    summary: {
      totalMembers,
      currentMembers,
      activeMembers: statusCount.get("active") ?? 0,
      inactiveMembers: statusCount.get("inactive") ?? 0,
      cancelledMembers: statusCount.get("cancelled") ?? 0,
      tasterMembers: statusCount.get("taster") ?? 0,
      activeOnHoldMembers,
      totalCheckIns,
      totalActiveClasses,
      attendanceThisWeek,
      attendanceLastWeek,
      newMembersThisMonth,
      newMembersLastMonth,
    },
    weeklyAttendance: Array.from(weeklyMap.values()),
    monthlySignups: Array.from(monthlyMap.values()),
    membersByStatus,
    currentMembersByStatus,
    checkInMethods,
    topClasses,
    churnRate,
    churn,
    retentionRate,
    retention: { ratePct: retentionRate, survived: retentionActive, cohort: retentionBase },
    netNewByMonth,
    membership,
    paymentHealth: {
      overdueCount,
      overdueGuardianCount,
      noPaymentYetCount,
      noPaymentYetGuardianCount,
      otherOwingCount: otherOwingTotals(otherOwingRows).count,
      otherOwingGuardianCount: otherOwingTotals(otherOwingRows).guardians,
      failedLast30Days: failedLast30,
      recoveryRate,
      recovery: { ratePct: recoveryRate, recovered: recoveredCount, failedMembers: failedMemberIds.length },
    },
    attendanceRate: computeAttendanceRate(attendanceRateMode, {
      totalCheckIns,
      activeMembers: scopedActiveMembers,
      distinctAttendingMembers: distinctAttendingMemberIds.size,
      capacitySum,
      attendedAgainstCapacity,
    }),
    attendanceRateModes: ATTENDANCE_RATE_MODES,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Cache version token — the second element of every reports cache key. Bump
 * it with EVERY change to the `ReportsData` shape, so a 60-second entry
 * written by the previous deployment is never served to code that expects
 * the new fields (and vice versa); old and new deployments never share an
 * entry. "v2" = T2b counts (churn, retention, recovery, rate
 * numerator/denominator, current status shares). T2c added no field.
 * "v3" = summary.activeOnHoldMembers (T1 review, 17 Oct 2026).
 * "v4" = period, the club-zone month window (review L4, 23 Oct 2026).
 * "v5" = paymentHealth payer counts and guardian counts (review L2, 23 Oct 2026).
 * "v6" = membership: movement and headcount by month (T8c). The headcount
 * branch shipped this field as its own "v4" before the reporting branch was
 * merged in; the merged shape (period + payer counts + membership) matches
 * neither earlier token, so it gets a fresh one. On the reporting branch
 * alone "v6" meant paymentHealth.otherOwingCount (D9); that shape is also
 * different from this one.
 * "v7" = the merged shape: membership (T8c) + paymentHealth.otherOwingCount /
 * otherOwingGuardianCount (D9, 23 Oct 2026).
 */
export const REPORTS_CACHE_VERSION = "v7";

/**
 * The cached read the reports page and API use. Under 25 concurrent staff
 * sessions the uncached report was the slowest path in the product (p95 5 s
 * in the 2026-09-24 pilot load run — docs/readiness/CAPACITY-PILOT): every
 * open dashboard re-ran the ~12-query window transaction. Cached for 60
 * seconds per tenant AND per filter combination, so two owners looking at
 * different windows never share a result and one club never sees another's.
 * The 60 seconds are disclosed on the page via `generatedAt`. Tag
 * `reports-<tenantId>` lets a write path bust it early; none does today —
 * a minute's staleness on aggregates is the documented trade (write-path
 * invalidation is deferred, A-7). A future call should go through
 * `revalidateTagLogged` (lib/revalidate-tag-logged.ts) so a failure is logged.
 *
 * The CSV export does NOT recompute: it is built in the browser
 * (ReportsView `reportsCsv`) from the same cached `ReportsData` the page
 * received, so it carries exactly the on-screen figures — and its first data
 * row states their `generatedAt`, so the file says when they were computed.
 */
export function getReportsDataCached(
  tenantId: string,
  options: Parameters<typeof getReportsData>[1] = {},
): Promise<ReportsData> {
  const key = [
    "reports",
    REPORTS_CACHE_VERSION,
    tenantId,
    String(clampWeeks(options.weeksBack)),
    options.classId?.trim() || "-",
    options.ageGroup ?? "-",
    resolveAttendanceRateMode(options.attendanceRateMode),
  ];
  return unstable_cache(() => getReportsData(tenantId, options), key, {
    revalidate: 60,
    tags: [`reports-${tenantId}`],
  })();
}
