// One-shot script. Run via: npx tsx scripts/check-stats-accuracy.ts <tenant-slug>
// Compares /api/reports totals to direct Prisma queries via withRlsBypass.

import { withRlsBypass } from "@/lib/prisma-tenant";
import { getReportsData } from "@/lib/reports";

const slug = process.argv[2];
if (!slug) {
  console.error("Usage: tsx scripts/check-stats-accuracy.ts <tenant-slug>");
  process.exit(1);
}

(async () => {
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({ where: { slug }, select: { id: true, name: true } }),
  );
  if (!tenant) {
    console.error(`No tenant with slug=${slug}`);
    process.exit(1);
  }

  const reports = await getReportsData(tenant.id, { weeksBack: 12 });

  const directWeekly = await withRlsBypass(async (tx) => {
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84);
    return tx.attendanceRecord.count({
      where: { tenantId: tenant.id, checkInTime: { gte: twelveWeeksAgo } },
    });
  });

  const reportTotal = reports.weeklyAttendance.reduce((s, w) => s + w.count, 0);

  console.log(`Tenant: ${tenant.name} (${slug})`);
  console.log(`  /api/reports total (12 weeks): ${reportTotal}`);
  console.log(`  Direct Prisma count:           ${directWeekly}`);
  console.log(`  Match: ${reportTotal === directWeekly ? "✓" : "✗"}`);
  process.exit(reportTotal === directWeekly ? 0 : 2);
})();
