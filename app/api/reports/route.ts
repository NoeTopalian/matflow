/**
 * GET /api/reports
 * Returns aggregated analytics for the owner reports dashboard.
 * Query params:
 *   weeks=12  Number of weekly attendance buckets, clamped from 4 to 24.
 */
import { auth } from "@/auth";
import { getReportsDataCached } from "@/lib/reports";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canView = ["owner", "manager"].includes(session.user.role);
  if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const requestedWeeks = Number(searchParams.get("weeks") ?? "12");
  // 60-second per-tenant, per-window cache (lib/reports.ts) — the body
  // carries `generatedAt` so a client can say how old the figures are.
  const data = await getReportsDataCached(session.user.tenantId, { weeksBack: requestedWeeks });

  // Lane 1 iter-2 L1-I2-S-02 [High]: per-tenant aggregate; never cache shared.
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
