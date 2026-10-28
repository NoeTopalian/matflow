import { withTenantContext } from "@/lib/prisma-tenant";
import AnalysisView from "@/components/dashboard/AnalysisView";
import { requireRole } from "@/lib/authz";
import { ACTIVE_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { loadJoinedInWindows } from "@/lib/membership-report";
import { liveClassWhere } from "@/lib/class-live";
import { resolveReportPeriod } from "@/lib/report-period";

export const metadata = { title: "Analysis | MatFlow" };

interface Props {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}

export default async function AnalysisPage({ searchParams }: Props) {
  // Audit iter-1-dashboard A4C-2: use centralised authz helper.
  const { session } = await requireRole(["owner"]);

  const tenantId = session.user.tenantId;
  const now = new Date();
  const { period, from, to } = await searchParams;

  // The page's period (Noe, 26 Oct 2026; lib/report-period), resolved in the
  // club's zone: the same whole club months as Reports. Its comparisons are
  // the equal run of months straight before it — for "this month" that is
  // exactly the old this-month-vs-last-month view.
  const tenant = await withTenantContext(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }));
  const range = resolveReportPeriod({ period, from, to }, now, tenant?.timezone);
  const inPeriod = { gte: new Date(range.start), lt: new Date(range.end) };
  const inPrevious = { gte: new Date(range.previous.start), lt: new Date(range.previous.end) };

  const [
    totalMembers,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    statusGroups,
    trendCounts,
    // Distinct member IDs that checked in at least once in the period — used
    // to compute a true engagement % bounded by total membership (was
    // previously computed as `checkins / members` and could blow past 100%).
    activeMemberIdsThisMonth,
  ] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      // Training members only (T1): guardian accounts are not members, so
      // they are neither "active members" nor "new this month".
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: inPeriod } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: inPrevious } }),
      tx.class.count({ where: liveClassWhere(tenantId) }),
      tx.member.groupBy({ by: ["status"], where: { tenantId, ...TRAINING_MEMBER }, _count: true }),
      // Check-ins per club month over the chart's months (the period, or the six
      // months ending with it): one COUNT per month in the database, so a long
      // period never reads or truncates rows (it used to cap at 60,000 rows).
      Promise.all(range.chartMonths.map((m) => tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: new Date(m.monthStart), lt: new Date(m.nextMonthStart) } } }))),
      // Lane 1 iter-1 P-04 [Critical] fix: count distinct members at the DB.
      // The previous `findMany({ distinct: ["memberId"] })` materialised every
      // row to JS and discarded everything but the member ids — ~10k rows
      // transferred per render at a 500-member, 20-sessions/month tenant.
      // groupBy() pushes the dedup into Postgres and returns one row per
      // distinct memberId; .length is the active-member count.
      tx.attendanceRecord
        .groupBy({
          by: ["memberId"],
          // Engagement is measured over active training members (T1): the
          // numerator counts only attendees who are in the denominator, so a
          // cancelled member's or a guardian's check-in cannot lift the rate.
          where: { tenantId, checkInTime: inPeriod, member: { ...ACTIVE_MEMBER } },
        })
        .then((groups) => groups.length),
    ]),
  );

  // Lane 1 iter-1 P-04 fix: now a count number directly, not an array.
  const activeMembersThisMonth = activeMemberIdsThisMonth;

  // Joined (new + rejoined) by the movement definition, in the club's months
  // (review 25 Oct): Member.joinedAt defaults to the import time, so counting
  // by it made every undated imported member a "new member" this month.
  // Its own read, after the block above: one pooled connection at a time.
  const [joinedThis, joinedLast] = await withTenantContext(
    tenantId,
    (tx) =>
      loadJoinedInWindows(tx, tenantId, now, [
        { start: new Date(range.start), at: new Date(range.at) },
        { start: new Date(range.previous.start), at: new Date(range.previous.at) },
      ]),
    { maxWait: 10_000, timeout: 30_000 },
  );
  const newThisMonth = joinedThis.joined;
  const newLastMonth = joinedLast.joined;
  const joinedEstimated = joinedThis.basis === "estimated" || joinedThis.basis === "mixed" || joinedLast.basis === "estimated" || joinedLast.basis === "mixed";

  // Labels in the club's zone; past 12 months a month name repeats, so the year goes with it ("Oct 25").
  const withYear = range.chartMonths.length > 12;
  const monthlyTrend = range.chartMonths.map((m, i) => ({
    label: new Date(new Date(m.monthStart).getTime() + 15 * 86_400_000).toLocaleString("en-GB", { month: "short", ...(withYear ? { year: "2-digit" } : {}), timeZone: range.timeZone }),
    value: trendCounts[i],
  }));

  const STATUS_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive", cancelled: "Cancelled", taster: "Taster" };
  // Q4 A-2, as on Reports' "Current members by status": the mix is shared over
  // CURRENT members only (active, inactive, tasters); members who have left
  // are a count of their own with no share, so Analysis and Reports give the
  // same "Active" percentage for the same club.
  const membersByStatus = statusGroups
    .filter((g) => g.status !== "cancelled")
    .map((g) => ({ status: g.status, label: STATUS_LABELS[g.status] ?? g.status, count: g._count }))
    .sort((a, b) => b.count - a.count);
  const leftMembers = statusGroups.find((g) => g.status === "cancelled")?._count ?? 0;

  const metrics = {
    totalMembers,
    newThisMonth,
    newLastMonth,
    joinedEstimated,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    activeMembersThisMonth,
    monthLabel: range.label,
    gymName: session.user.tenantName,
    membersByStatus,
    leftMembers,
    monthlyTrend,
    range,
  };

  return <AnalysisView metrics={metrics} primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
