/**
 * PUT /api/mats/order {ids} — put the club's mats in this order (owner + manager)
 *
 * The order of the mats is the order of the columns on a timetable split by
 * mat. `ids` must be exactly the club's mats, each once: a list that is
 * missing one (someone added a mat in another tab) is refused, not guessed at.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSessionUnlessEdit } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { MAT_LIMIT, lockClubMats } from "@/lib/mats";
import { listMats } from "@/lib/mats-store";

export const runtime = "nodejs";

const orderSchema = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MAT_LIMIT) }).strict();

export async function PUT(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSessionUnlessEdit(gate.session); if (support) return support; // view refused; an EDIT session may set up mats and the split (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  const ids = parsed.data.ids;

  const result = await withTenantContext(tenantId, async (tx) => {
    await lockClubMats(tx, tenantId);
    const mats = await listMats(tx, tenantId);
    const before = mats.map((m) => m.id);
    const same = ids.length === before.length && new Set(ids).size === ids.length && ids.every((id) => before.includes(id));
    if (!same) return { ok: false as const, status: 409, error: "Your mats have changed. Close this and open Mats again." };
    if (ids.every((id, i) => id === before[i])) return { ok: true as const, changed: false };
    for (const [i, id] of ids.entries()) {
      await tx.mat.updateMany({ where: { id, tenantId }, data: { sortOrder: i } });
    }
    await logAudit({ tenantId, userId, action: "mat.reorder", entityType: "Tenant", entityId: tenantId, metadata: { before, after: ids }, req, tx });
    return { ok: true as const, changed: true };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, changed: result.changed });
}
