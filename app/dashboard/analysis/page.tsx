import { withTenantContext } from "@/lib/prisma-tenant";
import AnalysisView from "@/components/dashboard/AnalysisView";
import { requireRole } from "@/lib/authz";

export const metadata = { title: "Analysis | MatFlow" };

export default async function AnalysisPage() {
  // Audit iter-1-dashboard A4C-2: use centralised authz helper.
  const { session } = await requireRole(["owner"]);

  const tenantId = session.user.tenantId;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  const [
    totalMembers,
    newThisMonth,
    newLastMonth,
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
      tx.member.count({ where: { tenantId, status: "active" } }),
      tx.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
      tx.member.count({ where: { tenantId, joinedAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: startOfMonth } } }),
      tx.attendanceRecord.count({ where: { tenantId, checkInTime: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
      tx.class.count({ where: { tenantId, isActive: true } }),
      tx.member.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
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
          where: { tenantId, checkInTime: { gte: startOfMonth } },
        })
        .then((groups) => groups.length),
    ]),
  );

  // Lane 1 iter-1 P-04 fix: now a count number directly, not an array.
  const activeMembersThisMonth = activeMemberIdsThisMonth;

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
  const membersByStatus = statusGroups
    .map((g) => ({ status: g.status, label: STATUS_LABELS[g.status] ?? g.status, count: g._count }))
    .sort((a, b) => b.count - a.count);

  const metrics = {
    totalMembers,
    newThisMonth,
    newLastMonth,
    checkinsThisMonth,
    checkinsLastMonth,
    activeClasses,
    activeMembersThisMonth,
    monthLabel: now.toLocaleString("default", { month: "long", year: "numeric" }),
    gymName: session.user.tenantName,
    membersByStatus,
    monthlyTrend,
  };

  return <AnalysisView metrics={metrics} primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
