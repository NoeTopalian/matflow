/**
 * GET /api/promotions/candidates
 *
 * Owner / manager: returns the list of "ready for promotion" candidates
 * for the current tenant. Live-computed (no cron). See
 * lib/promotion-candidates.ts for the threshold logic + per-discipline
 * defaults.
 *
 * Response shape: { candidates: PromotionCandidate[], generatedAt: ISO }
 */
import { NextResponse } from "next/server";
import { requireOwnerOrManager } from "@/lib/authz";
import { apiError } from "@/lib/api-error";
import { listPromotionCandidates } from "@/lib/promotion-candidates";

export const runtime = "nodejs";

export async function GET() {
  const { tenantId } = await requireOwnerOrManager();
  try {
    const candidates = await listPromotionCandidates(tenantId);
    return NextResponse.json({
      candidates,
      generatedAt: new Date().toISOString(),
      count: candidates.length,
    });
  } catch (e) {
    return apiError("Failed to compute promotion candidates", 500, e, "[promotions/candidates]");
  }
}
