/**
 * GET /api/mats/suggestions — the places already typed on the club's classes (owner + manager)
 *
 * One line per distinct place whatever its capitals and spacing, over the
 * classes that are on the timetable or paused and are on no mat. It is what
 * the Mats sheet offers to turn into mats in one press, and how a mat added
 * by hand finds the classes that already say its name.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { placeSuggestions } from "@/lib/mats";
import { listMats } from "@/lib/mats-store";

export const runtime = "nodejs";

export async function GET() {
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const body = await withTenantContext(tenantId, async (tx) => {
    const mats = await listMats(tx, tenantId);
    const classes = await tx.class.findMany({
      where: { tenantId, matId: null, deletedAt: null, sourceImportJobId: null },
      select: { location: true },
    });
    return { ...placeSuggestions(classes, mats), matCount: mats.length };
  });
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
