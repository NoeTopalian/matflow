/**
 * PATCH /api/class-categories/:id {version, name?, archived?} — rename, archive or restore (owner + manager;
 * only when category management is switched on).
 *
 * `version` is the category's version the caller saw; if it has changed since (another tab renamed, archived or
 * moved it) the write is refused with 409 and nothing changes: a stale edit never overwrites a newer one.
 * Archiving keeps every class on the category (it still shows on them) and stops it being chosen for a class again;
 * restoring makes it choosable again. The row is locked FOR UPDATE, then written: ClassCategory rows only
 * (docs/design/LOCK-ORDER-2026-10-24.md). An archive waits for an assignment of the category in flight (its FOR SHARE
 * in the bridge trigger), and the assignment that comes after is refused.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSession } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { CATEGORY_NAME_MAX, categoryNameKey, cleanCategoryName } from "@/lib/class-category";
import { categoryManagementEnabled } from "@/lib/class-category-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({ version: z.number().int().min(0), name: z.string().max(200).optional(), archived: z.boolean().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.archived !== undefined, { message: "nothing to change" });

const STALE = "This category was changed in another tab or by someone else. Close this and open Categories again.";

export async function PATCH(req: Request, { params }: Params) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  if (!categoryManagementEnabled()) return NextResponse.json({ error: "Category management isn't switched on yet." }, { status: 404 });
  const { tenantId, userId } = gate;
  const { id } = await params;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  const { version, archived } = parsed.data;
  let name: string | undefined;
  let nameKey: string | undefined;
  if (parsed.data.name !== undefined) {
    name = cleanCategoryName(parsed.data.name);
    nameKey = categoryNameKey(name);
    if (!nameKey) return NextResponse.json({ error: "Give the category a name." }, { status: 400 });
    if (name.length > CATEGORY_NAME_MAX) return NextResponse.json({ error: `A category name can be up to ${CATEGORY_NAME_MAX} characters.` }, { status: 400 });
  }

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; name: string; archivedAt: Date | null; version: number }[]>`
        SELECT "id", "name", "archivedAt", "version" FROM "ClassCategory" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      const row = locked[0];
      if (!row) return { ok: false as const, status: 404, error: "That category isn't one of this club's." };
      if (row.version !== version) return { ok: false as const, status: 409, error: STALE, code: "stale" as const };

      const data: { name?: string; nameKey?: string; archivedAt?: Date | null; version: number } = { version: row.version + 1 };
      const renamed = name !== undefined && name !== row.name;
      if (renamed) {
        const clash = await tx.classCategory.findFirst({ where: { tenantId, nameKey, NOT: { id } }, select: { name: true, archivedAt: true } });
        if (clash) return { ok: false as const, status: 409, error: clash.archivedAt ? `“${clash.name}” is an archived category. Restore it, or choose another name.` : `You already have a category called “${clash.name}”.` };
        data.name = name;
        data.nameKey = nameKey;
      }
      const archiving = archived === true && row.archivedAt === null;
      const restoring = archived === false && row.archivedAt !== null;
      if (archiving) data.archivedAt = new Date();
      if (restoring) data.archivedAt = null;
      if (!renamed && !archiving && !restoring) return { ok: true as const, changed: false, row: { id: row.id, name: row.name, archived: row.archivedAt !== null, version: row.version } };

      const updated = await tx.classCategory.update({ where: { id_tenantId: { id, tenantId } }, data, select: { id: true, name: true, archivedAt: true, version: true } });
      if (renamed) await logAudit({ tenantId, userId, action: "class_category.rename", entityType: "ClassCategory", entityId: id, metadata: { before: { name: row.name }, after: { name: updated.name } }, req, tx });
      if (archiving) await logAudit({ tenantId, userId, action: "class_category.archive", entityType: "ClassCategory", entityId: id, metadata: { name: updated.name }, req, tx });
      if (restoring) await logAudit({ tenantId, userId, action: "class_category.restore", entityType: "ClassCategory", entityId: id, metadata: { name: updated.name }, req, tx });
      return { ok: true as const, changed: true, row: { id: updated.id, name: updated.name, archived: updated.archivedAt !== null, version: updated.version } };
    });
    // `code: "stale"` tells the sheet a stale version from a name clash without reading the English text.
    if (!result.ok) return NextResponse.json({ error: result.error, ...("code" in result ? { code: result.code } : {}) }, { status: result.status });
    return NextResponse.json({ ...result.row, changed: result.changed });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: `You already have a category called “${name}”.` }, { status: 409 });
    throw e;
  }
}
