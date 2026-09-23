import { withTenantContext } from "@/lib/prisma-tenant";

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
}

export interface ReportsData {
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
    totalMembers: number;
    activeMembers: number;
    inactiveMembers: number;
    cancelledMembers: number;
    tasterMembers: number;
    totalCheckIns: number;
    totalActiveClasses: number;
    attendanceThisWeek: number;
    attendanceLastWeek: number;
    newMembersThisMonth: number;
    newMembersLastMonth: number;
  };
  weeklyAttendance: { week: string; count: number; isCurrentWeek: boolean }[];
  monthlySignups: { month: string; count: number; isCurrentMonth: boolean }[];
  membersByStatus: { status: string; label: string; count: number; percentage: number }[];
  checkInMethods: { method: string; label: string; count: number; percentage: number }[];
  topClasses: {
    name: string;
    count: number;
    sessions: number;
    averageAttendance: number;
    fillRate: number | null;
  }[];
  churnRate: number;
  retentionRate: number | null;
  netNewByMonth: { month: string; joined: number; cancelled: number; net: number }[];
  paymentHealth: {
    overdueCount: number;
    failedLast30Days: number;
    recoveryRate: number | null;
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
  switch (mode) {
    case "attendance-percentage":
      value = data.activeMembers > 0 ? percent(data.distinctAttendingMembers, data.activeMembers) : null;
      break;
    case "fill-rate":
      value = data.capacitySum > 0 ? percent(data.attendedAgainstCapacity, data.capacitySum) : null;
      break;
    case "checkins-per-member":
    default:
      value = data.activeMembers > 0 ? roundedAverage(data.totalCheckIns, data.activeMembers) : null;
      break;
  }
  return { mode, value, label: meta.label, formula: meta.formula };
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

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function formatWeek(date: Date) {
  return `${date.getDate()} ${date.toLocaleString("en-GB", { month: "short" })}`;
}

function formatMonth(date: Date) {
  return date.toLocaleString("en-GB", { month: "short", year: "2-digit" });
}

function percent(count: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

function roundedAverage(total: number, sessions: number) {
  if (sessions <= 0) return 0;
  return Math.round((total / sessions) * 10) / 10;
}

export function createEmptyReportsData(): ReportsData {
  return {
    weeksBack: DEFAULT_WEEKS,
    classOptions: [],
    filters: { classId: null, className: null, ageGroup: null },
    summary: {
      totalMembers: 0,
      activeMembers: 0,
      inactiveMembers: 0,
      cancelledMembers: 0,
      tasterMembers: 0,
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
    checkInMethods: [],
    topClasses: [],
    churnRate: 0,
    retentionRate: null,
    netNewByMonth: [],
    paymentHealth: {
      overdueCount: 0,
      failedLast30Days: 0,
      recoveryRate: null,
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
// (see prisma/schema.prisma). "parent" is an adult managing a kids' account,
// not a child, so it buckets with "adult" here — there is no third bucket in
// the UI toggle and a parent-only login is never itself a class attendee.
const ADULT_ACCOUNT_TYPES = ["adult", "parent"];
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
  const classOptionsRaw = await withTenantContext(tenantId, (tx) =>
    tx.class.findMany({
      where: { tenantId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
  const resolvedClassId = requestedClassId && classOptionsRaw.some((c) => c.id === requestedClassId)
    ? requestedClassId
    : undefined;

  const now = new Date();
  const currentWeekStart = startOfWeek(now);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const weeklyWindowStart = addDays(currentWeekStart, -(weeksBack - 1) * 7);
  const currentMonthStart = startOfMonth(now);
  const previousMonthStart = addMonths(currentMonthStart, -1);
  const sixMonthsAgo = addMonths(currentMonthStart, -5);

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
    newMembers,
    topResult, // Lane 1 iter-1 P-03: { topRaw, instances } — in-tx continuation
    totalMembers,
    totalCheckIns,
    totalActiveClasses,
    attendanceThisWeek,
    attendanceLastWeek,
    newMembersThisMonth,
    newMembersLastMonth,
    cancelledThisMonth,
    activeCount,
    retentionBase,
    retentionActive,
    overdueCount,
    failedLast30,
    membersWithRecentFailed,
    cancelledByMonth,
  ] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.attendanceRecord.findMany({
        where: { tenantId, checkInTime: { gte: weeklyWindowStart }, ...attendanceScope },
        // memberId added (Track G) for the "members who attended" rate mode
        // below — same rows already fetched for the weekly chart, no new
        // query, so the distinct-attendee count shares the identical window
        // and filter scope as everything else on this page.
        select: { checkInTime: true, memberId: true, member: { select: { status: true } } },
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
        where: { tenantId },
        _count: true,
      }),
      tx.member.findMany({
        where: { tenantId, joinedAt: { gte: sixMonthsAgo } },
        select: { joinedAt: true },
        take: 5000,
      }).then((rows) => {
        if (rows.length === 5000) console.warn("[reports] truncated at 5000 rows (member-join window)");
        return rows;
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
      tx.member.count({ where: { tenantId } }),
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
      tx.member.count({ where: { tenantId, joinedAt: { gte: currentMonthStart } } }),
      tx.member.count({
        where: {
          tenantId,
          joinedAt: { gte: previousMonthStart, lt: currentMonthStart },
        },
      }),
      // Health metrics — churn (D1: date by cancelledAt, not updatedAt, so an
      // unrelated edit to a cancelled member doesn't re-bucket them into churn)
      tx.member.count({ where: { tenantId, status: "cancelled", cancelledAt: { gte: currentMonthStart } } }),
      tx.member.count({ where: { tenantId, status: "active" } }),
      // Retention: joined ≥6 months ago
      tx.member.count({ where: { tenantId, joinedAt: { lt: sixMonthsAgo } } }),
      tx.member.count({ where: { tenantId, joinedAt: { lt: sixMonthsAgo }, status: "active" } }),
      // Payment health — D5: match the dashboard "payments due" tile predicate
      // (only active/taster members count as overdue; a cancelled member isn't
      // chased). Keeps the dashboard tile and this report in agreement.
      tx.member.count({ where: { tenantId, paymentStatus: "overdue", status: { in: ["active", "taster"] } } }),
      tx.payment.count({ where: { tenantId, status: "failed", createdAt: { gte: new Date(Date.now() - 30 * 86400000) } } }),
      tx.payment.findMany({
        where: { tenantId, status: "failed", createdAt: { gte: new Date(Date.now() - 90 * 86400000) } },
        select: { memberId: true },
        distinct: ["memberId"],
      }),
      // Net-new chart: members cancelled in the last 6 months (D1: by cancelledAt)
      tx.member.findMany({
        where: { tenantId, status: "cancelled", cancelledAt: { gte: sixMonthsAgo } },
        select: { cancelledAt: true },
      }),
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
    if (rec.member?.status === "active") distinctAttendingMemberIds.add(rec.memberId);
  }

  const monthlyMap = new Map<string, { month: string; count: number; isCurrentMonth: boolean }>();
  for (let i = 5; i >= 0; i--) {
    const d = addMonths(currentMonthStart, -i);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    monthlyMap.set(key, {
      month: formatMonth(d),
      count: 0,
      isCurrentMonth: d.getTime() === currentMonthStart.getTime(),
    });
  }

  for (const member of newMembers) {
    const d = startOfMonth(member.joinedAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = monthlyMap.get(key);
    if (bucket) bucket.count += 1;
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

  const churnRate = Math.round(
    ((cancelledThisMonth / Math.max(activeCount + cancelledThisMonth, 1)) * 100) * 10,
  ) / 10;

  // 0/0 is "no data", not "perfect": a club with no members who joined 6+
  // months ago has an UNDEFINED survival rate — surface it as null → "—", not a
  // fake 100% (same honesty rule as the attendance-rate modes).
  const retentionRate = retentionBase > 0
    ? Math.round((retentionActive / retentionBase) * 1000) / 10
    : null;

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
  const recoveryRate = failedMemberIds.length > 0
    ? Math.round((recoveredCount / failedMemberIds.length) * 1000) / 10
    : null;

  // Net-new by month: join monthlyMap (joined) with cancelledByMonth (cancelled)
  const cancelledByMonthMap = new Map<string, number>();
  for (const row of cancelledByMonth) {
    if (!row.cancelledAt) continue;
    const d = startOfMonth(row.cancelledAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
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
    weeksBack,
    classOptions: classOptionsRaw,
    filters: {
      classId: resolvedClass?.id ?? null,
      className: resolvedClass?.name ?? null,
      ageGroup: ageGroup ?? null,
    },
    summary: {
      totalMembers,
      activeMembers: statusCount.get("active") ?? 0,
      inactiveMembers: statusCount.get("inactive") ?? 0,
      cancelledMembers: statusCount.get("cancelled") ?? 0,
      tasterMembers: statusCount.get("taster") ?? 0,
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
    checkInMethods,
    topClasses,
    churnRate,
    retentionRate,
    netNewByMonth,
    paymentHealth: {
      overdueCount,
      failedLast30Days: failedLast30,
      recoveryRate,
    },
    attendanceRate: computeAttendanceRate(attendanceRateMode, {
      totalCheckIns,
      activeMembers: statusCount.get("active") ?? 0,
      distinctAttendingMembers: distinctAttendingMemberIds.size,
      capacitySum,
      attendedAgainstCapacity,
    }),
    attendanceRateModes: ATTENDANCE_RATE_MODES,
  };
}
