/**
 * GET /api/attribution
 * Per-staff conversion analytics (M1): trials run, sign-ups, conversions and
 * conversion % for each coach, with the min-N and feature-epoch guards applied
 * in lib/attribution.ts. Owner and manager only — this is the same audience as
 * the reports surface.
 */
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { getAttributionData } from "@/lib/attribution";
import { NextResponse } from "next/server";

export async function GET() {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;

  const data = await getAttributionData(gate.tenantId);

  // Per-tenant aggregate; never cache shared.
  return NextResponse.json(data, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
