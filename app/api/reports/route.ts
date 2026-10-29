/**
 * GET /api/reports
 * Returns aggregated analytics for the owner reports dashboard.
 * Query params (lib/report-period):
 *   period=this-month|last-month|3m|6m|12m|custom, with from=YYYY-MM&to=YYYY-MM for custom.
 *   weeks=N   The earlier control; used only when period is absent, mapped to the nearest preset.
 */
import { auth } from "@/auth";
import { getReportsDataCached } from "@/lib/reports";
import { apiError } from "@/lib/api-error";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canView = ["owner", "manager"].includes(session.user.role);
  if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const period = { period: searchParams.get("period"), from: searchParams.get("from"), to: searchParams.get("to"), weeks: searchParams.get("weeks") };
  // 60-second per-tenant, per-window cache (lib/reports.ts) — the body
  // carries `generatedAt` so a client can say how old the figures are.
  let data: Awaited<ReturnType<typeof getReportsDataCached>>;
  try {
    data = await getReportsDataCached(session.user.tenantId, { period });
  } catch (e) {
    // Connection register gap 25 (30 Sep 2026): no catch meant a bare 500
    // with no reference and no Sentry event.
    return apiError("Couldn't build the report", 500, e, "[reports GET]", { tenantId: session.user.tenantId, req });
  }

  // Lane 1 iter-2 L1-I2-S-02 [High]: per-tenant aggregate; never cache shared.
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
