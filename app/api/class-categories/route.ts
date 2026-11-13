/**
 * GET  /api/class-categories        — the club's categories, with how many classes use each (any staff)
 * POST /api/class-categories {name} — add a category (owner + manager; only when management is switched on)
 *
 * Release B of club-managed categories (12 Nov 2026). A category is the club's own label for a class
 * ("Beginners", "Open Mat"); a class has at most one. Names are unique per club whatever their capitals and spacing,
 * archived ones included, and at most 32 characters (lib/class-category.ts). Creates take the club's categories lock
 * (lib/class-category-store.ts), so the next position cannot be raced; the unique index is the backstop.
 * Category management is recorded in Activity and has no Undo (Noe, 11 Nov 2026).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiStaff, requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSession } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { CATEGORY_NAME_MAX, categoryNameKey, cleanCategoryName } from "@/lib/class-category";
import { CATEGORY_LIMIT, categoryManagementEnabled, listManagedCategories, lockClubCategories } from "@/lib/class-category-store";

export const runtime = "nodejs";

const createSchema = z.object({ name: z.string().max(200) }).strict();

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const categories = await withTenantContext(tenantId, (tx) => listManagedCategories(tx, tenantId));
  return NextResponse.json({ categories, managementEnabled: categoryManagementEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  if (!categoryManagementEnabled()) return NextResponse.json({ error: "Category management isn't switched on yet." }, { status: 404 });
  const { tenantId, userId } = gate;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Give the category a name." }, { status: 400 });
  const name = cleanCategoryName(parsed.data.name);
  const nameKey = categoryNameKey(name);
  if (!nameKey) return NextResponse.json({ error: "Give the category a name." }, { status: 400 });
  if (name.length > CATEGORY_NAME_MAX) return NextResponse.json({ error: `A category name can be up to ${CATEGORY_NAME_MAX} characters.` }, { status: 400 });

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      await lockClubCategories(tx, tenantId);
      const rows = await tx.classCategory.findMany({ where: { tenantId }, select: { name: true, nameKey: true, sortOrder: true, archivedAt: true } });
      const clash = rows.find((r) => r.nameKey === nameKey);
      if (clash) {
        return { ok: false as const, status: 409, error: clash.archivedAt ? `“${clash.name}” is an archived category. Restore it instead.` : `You already have a category called “${clash.name}”.` };
      }
      if (rows.length >= CATEGORY_LIMIT) return { ok: false as const, status: 409, error: `A club can have up to ${CATEGORY_LIMIT} categories.` };
      const sortOrder = rows.reduce((max, r) => Math.max(max, r.sortOrder), -1) + 1;
      const row = await tx.classCategory.create({ data: { tenantId, name, nameKey, sortOrder }, select: { id: true, name: true, version: true } });
      await logAudit({ tenantId, userId, action: "class_category.create", entityType: "ClassCategory", entityId: row.id, metadata: { name: row.name }, req, tx });
      return { ok: true as const, row };
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ id: result.row.id, name: result.row.name, legacyKey: null, archived: false, version: result.row.version, classCount: 0 }, { status: 201 });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: `You already have a category called “${name}”.` }, { status: 409 });
    throw e;
  }
}
