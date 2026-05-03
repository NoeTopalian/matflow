import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireOwnerOrManager } from "@/lib/authz";
import { generateMonthlyReport } from "@/lib/ai-causal-report";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwnerOrManager();

  const rl = await checkRateLimit(`report:gen:${tenantId}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many report generations. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  try {
    const result = await generateMonthlyReport({
      tenantId,
      tenantName: tenant.name,
      periodStart,
      periodEnd,
    });

    const row = await withTenantContext(tenantId, (tx) =>
      tx.monthlyReport.create({
        data: {
          tenantId,
          periodStart,
          periodEnd,
          generationType: "on_demand",
          triggeredById: userId,
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
      }),
    );

    await logAudit({
      tenantId,
      userId,
      action: "report.generate",
      entityType: "MonthlyReport",
      entityId: row.id,
      metadata: {
        generationType: "on_demand",
        modelUsed: result.modelUsed,
        costPence: result.costPence,
        driveAvailable: result.driveAvailable,
        insufficientData: result.insufficientData,
      },
      req,
    });

    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    return apiError("Report generation failed", 500, e, "[reports/generate]");
  }
}

export async function GET() {
  const { tenantId } = await requireOwnerOrManager();
  const reports = await withTenantContext(tenantId, (tx) =>
    tx.monthlyReport.findMany({
      where: { tenantId },
      orderBy: { generatedAt: "desc" },
      take: 12,
    }),
  );
  return NextResponse.json(reports);
}
