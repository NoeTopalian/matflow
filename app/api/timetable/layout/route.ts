/**
 * PATCH /api/timetable/layout {layout} — choose how same-time classes are split (owner + manager)
 *
 * "mat" (one column per mat) or "time" (side by side in lanes). This is the
 * ONLY writer of Tenant.timetableLayout: until someone presses a choice the
 * column stays NULL and the timetable follows the mats
 * (lib/timetable-layout.ts). By mat cannot be chosen while no class is on a
 * mat; the choice already stored writes nothing and records nothing.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { lockClubMats } from "@/lib/mats";
import { countMatsInUse, readLayout } from "@/lib/mats-store";
import { effectiveLayout } from "@/lib/timetable-layout";

export const runtime = "nodejs";

const layoutSchema = z.object({ layout: z.enum(["mat", "time"]) }).strict();

export async function PATCH(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  const layout = parsed.data.layout;

  const result = await withTenantContext(tenantId, async (tx) => {
    // The same lock as every mats write, so the "is a class on a mat" answer cannot change under this.
    await lockClubMats(tx, tenantId);
    const before = await readLayout(tx, tenantId);
    const inUse = await countMatsInUse(tx, tenantId);
    if (layout === "mat" && inUse === 0) return { ok: false as const, status: 409, error: "Put a class on a mat first." };
    if (before.stored === layout) return { ok: true as const, layout: before, changed: false };
    await tx.tenant.update({ where: { id: tenantId }, data: { timetableLayout: layout } });
    await logAudit({
      tenantId, userId, action: "timetable.layout.update", entityType: "Tenant", entityId: tenantId,
      metadata: { before: { stored: before.stored, effective: before.effective }, after: { stored: layout, effective: effectiveLayout(layout, inUse) } }, req, tx,
    });
    return { ok: true as const, layout: { stored: layout, effective: effectiveLayout(layout, inUse) }, changed: true };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ layout: result.layout, changed: result.changed });
}
