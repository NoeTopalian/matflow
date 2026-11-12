/**
 * PUT /api/class-categories/order {items: [{id, version}]} — put the club's categories in this order (owner +
 * manager; only when category management is switched on).
 *
 * `items` must be exactly the club's categories, each once, each with the version the caller saw. A list that is
 * missing one (another tab added a category) or carries an old version (another tab renamed or archived one) is
 * refused with 409, not guessed at. The order is the order the class form and the management sheet offer them;
 * archived categories are listed after the active ones whatever their position. Rows are locked and written in id
 * order (docs/design/LOCK-ORDER-2026-10-24.md).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSession } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { CATEGORY_LIMIT, categoryManagementEnabled, lockClubCategories } from "@/lib/class-category-store";

export const runtime = "nodejs";

const orderSchema = z
  .object({ items: z.array(z.object({ id: z.string().min(1).max(64), version: z.number().int().min(0) }).strict()).min(1).max(CATEGORY_LIMIT) })
  .strict();

const STALE = "Your categories have changed. Close this and open Categories again.";

export async function PUT(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  if (!categoryManagementEnabled()) return NextResponse.json({ error: "Category management isn't switched on yet." }, { status: 404 });
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  const items = parsed.data.items;

  const result = await withTenantContext(tenantId, async (tx) => {
    await lockClubCategories(tx, tenantId);
    const rows = await tx.$queryRaw<{ id: string; sortOrder: number; version: number }[]>`
      SELECT "id", "sortOrder", "version" FROM "ClassCategory" WHERE "tenantId" = ${tenantId} ORDER BY "id" FOR UPDATE`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ids = items.map((i) => i.id);
    const same = ids.length === rows.length && new Set(ids).size === ids.length && items.every((i) => byId.get(i.id)?.version === i.version);
    if (!same) return { ok: false as const, status: 409, error: STALE };
    const before = [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).map((r) => r.id);
    if (ids.every((id, i) => id === before[i])) return { ok: true as const, changed: false };
    const moved = items.map((it, i) => ({ id: it.id, sortOrder: i })).filter((m) => byId.get(m.id)!.sortOrder !== m.sortOrder).sort((a, b) => a.id.localeCompare(b.id));
    for (const m of moved) {
      await tx.classCategory.updateMany({ where: { id: m.id, tenantId }, data: { sortOrder: m.sortOrder, version: { increment: 1 } } });
    }
    await logAudit({ tenantId, userId, action: "class_category.reorder", entityType: "Tenant", entityId: tenantId, metadata: { before, after: ids }, req, tx });
    return { ok: true as const, changed: true };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, changed: result.changed });
}
