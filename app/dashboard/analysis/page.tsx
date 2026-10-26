import { withTenantContext } from "@/lib/prisma-tenant";
import AnalysisView from "@/components/dashboard/AnalysisView";
import { requireRole } from "@/lib/authz";
import { ACTIVE_MEMBER, TRAINING_MEMBER } from "@/lib/member-population";
import { monthWindows } from "@/lib/month-windows";
import { clubMonthWindow } from "@/lib/club-month";
import { loadJoinedInWindows } from "@/lib/membership-report";
import { liveClassWhere } from "@/lib/class-live";

export const metadata = { title: "Analysis | MatFlow" };

export default async function AnalysisPage() {
  // Audit iter-1-dashboard A4C-2: use centralised authz helper.
  const { session } = await requireRole(["owner"]);

  const tenantId = session.user.tenantId;
  const now = new Date();
  // Half-open months (T2c): last month is [startOfLastMonth, startOfMonth),
  // so the whole of its last day counts — `lte` 00:00 on that day dropped
  // every join and check-in after midnight.
  const { startOfMonth, startOfLastMonth, sixMonthsAgo } = monthWindows(now);

  const [
    totalMembers,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    statusGroups,
    monthlyCheckIns,
    // Distinct member IDs that checked in at least once this month — used to
    // compute a true engagement % bounded by total membership (was previously
    // computed as `checkins / members` and could blow past 100%).
    activeMemberIdsThisMonth,
  ] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      // Training members only (T1): guardian accounts are not members, so
      // they are neither "active members" nor "new this month".
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: startOfMonth } } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: startOfLastMonth, lt: startOfMonth } } }),
      tx.class.count({ where: liveClassWhere(tenantId) }),
      tx.member.groupBy({ by: ["status"], where: { tenantId, ...TRAINING_MEMBER }, _count: true }),
      tx.attendanceRecord.findMany({
        // Audit iter-2-database A8I2-P-H-2: cap at 60k rows. At a busy
        // 500-member tenant ~200 classes/month × 20 members = 24k rows over
        // 6 months; 60k gives 2.5× headroom before the JS bucketing pipe
        // truncates. Matches the lib/reports.ts pattern with a warn log
        // so we know when it bites.
        where: { tenantId, checkInTime: { gte: sixMonthsAgo } },
        select: { checkInTime: true },
        take: 60000,
      }).then((rows) => {
        if (rows.length === 60000) console.warn("[analysis] truncated at 60000 rows (6-month attendance window)");
        return rows;
      }),
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
          where: { tenantId, checkInTime: { gte: startOfMonth }, member: { ...ACTIVE_MEMBER } },
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
    async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      const cur = clubMonthWindow(now, tenant?.timezone, 0);
      const prev = clubMonthWindow(now, tenant?.timezone, -1);
      return loadJoinedInWindows(tx, tenantId, now, [
        { start: new Date(cur.monthStart), at: now },
        { start: new Date(prev.monthStart), at: new Date(new Date(prev.nextMonthStart).getTime() - 1) },
      ]);
    },
    { maxWait: 10_000, timeout: 30_000 },
  );
  const newThisMonth = joinedThis.joined;
  const newLastMonth = joinedLast.joined;
  const joinedEstimated = joinedThis.basis === "estimated" || joinedThis.basis === "mixed" || joinedLast.basis === "estimated" || joinedLast.basis === "mixed";

  const monthlyTrend: { label: string; value: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthlyTrend.push({
      label: d.toLocaleString("en-GB", { month: "short" }),
      value: 0,
    });
  }
  for (const rec of monthlyCheckIns) {
    const ageMonths = (now.getFullYear() - rec.checkInTime.getFullYear()) * 12 + (now.getMonth() - rec.checkInTime.getMonth());
    const idx = 5 - ageMonths;
    if (idx >= 0 && idx < 6) monthlyTrend[idx].value += 1;
  }

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
    monthLabel: now.toLocaleString("default", { month: "long", year: "numeric" }),
    gymName: session.user.tenantName,
    membersByStatus,
    leftMembers,
    monthlyTrend,
  };

  return <AnalysisView metrics={metrics} primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
