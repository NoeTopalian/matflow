/**
 * Vercel cron entry — runs on the 1st of each month at 02:00 UTC.
 * Schedule defined in vercel.json: "0 2 1 * *".
 *
 * Generates a MonthlyReport for every active tenant.
 * Phase 1 (this WP): writes placeholder rows so the loop is exercised.
 * Phase 2 (WP7): swaps placeholder text for real Claude AI causal analysis.
 */
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateMonthlyReport } from "@/lib/ai-causal-report";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  // Vercel cron sends Authorization: Bearer ${CRON_SECRET}
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const tenants = await prisma.tenant.findMany({
    where: {
      subscriptionStatus: { in: ["active", "trial"] },
      deletedAt: null,
    },
    select: { id: true, name: true },
  });

  let succeeded = 0;
  const failures: { tenantId: string; error: string }[] = [];

  for (const tenant of tenants) {
    try {
      const existing = await prisma.monthlyReport.findFirst({
        where: { tenantId: tenant.id, periodStart, generationType: "auto" },
      });
      if (existing) continue;

      const result = await generateMonthlyReport({
        tenantId: tenant.id,
        tenantName: tenant.name,
        periodStart,
        periodEnd,
      });

      await prisma.monthlyReport.create({
        data: {
          tenantId: tenant.id,
          periodStart,
          periodEnd,
          generationType: "auto",
          modelUsed: result.modelUsed,
          costPence: result.costPence,
          summary: result.summary,
          wins: result.wins,
          watchOuts: result.watchOuts,
          recommendations: result.recommendations,
          metricSnapshot: result.metricSnapshot,
          driveFilesUsed: result.driveFilesUsed,
          initiativesUsed: result.initiativesUsed,
        },
      });
      succeeded += 1;
    } catch (e) {
      failures.push({ tenantId: tenant.id, error: e instanceof Error ? e.message : "unknown" });
    }
  }

  return NextResponse.json({
    ok: true,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    tenantsProcessed: tenants.length,
    succeeded,
    failures,
  });
}
