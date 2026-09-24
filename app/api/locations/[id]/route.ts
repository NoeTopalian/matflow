/**
 * PATCH  /api/locations/[id] {name?, address?, isDefault?} — owner + manager
 * DELETE /api/locations/[id]                              — owner + manager
 *
 * The default location cannot be deleted, and a location with classes on it
 * cannot be deleted either: move the classes first, so nothing on the
 * timetable silently loses its venue. Making a location the default clears
 * the flag on the previous default in the same transaction (the partial
 * unique index would refuse two defaults anyway).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  address: z.string().trim().max(200).optional().nullable(),
  isDefault: z.literal(true).optional(),
});

const SELECT = { id: true, name: true, address: true, isDefault: true, createdAt: true } as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const result = await withTenantContext(tenantId, async (tx) => {
    const existing = await tx.location.findFirst({ where: { id, tenantId }, select: SELECT });
    if (!existing) return { ok: false as const, status: 404, error: "Location not found" };
    if (parsed.data.name && parsed.data.name !== existing.name) {
      const clash = await tx.location.findFirst({ where: { tenantId, name: parsed.data.name, id: { not: id } }, select: { id: true } });
      if (clash) return { ok: false as const, status: 409, error: "A location with that name already exists" };
    }
    if (parsed.data.isDefault && !existing.isDefault) {
      await tx.location.updateMany({ where: { tenantId, isDefault: true }, data: { isDefault: false } });
    }
    const row = await tx.location.update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
        ...(parsed.data.isDefault ? { isDefault: true } : {}),
      },
      select: SELECT,
    });
    return { ok: true as const, row, before: existing };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await logAudit({ tenantId, userId, action: "location.update", entityType: "Location", entityId: id, metadata: { before: result.before, after: result.row }, req });
  return NextResponse.json(result.row);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  const result = await withTenantContext(tenantId, async (tx) => {
    const existing = await tx.location.findFirst({ where: { id, tenantId }, select: { id: true, name: true, isDefault: true } });
    if (!existing) return { ok: false as const, status: 404, error: "Location not found" };
    if (existing.isDefault) return { ok: false as const, status: 409, error: "The default location cannot be removed — make another location the default first" };
    const classes = await tx.class.count({ where: { tenantId, locationId: id, deletedAt: null } });
    if (classes > 0) return { ok: false as const, status: 409, error: `${classes} ${classes === 1 ? "class is" : "classes are"} at this location — move them first` };
    await tx.location.delete({ where: { id } });
    return { ok: true as const, name: existing.name };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  await logAudit({ tenantId, userId, action: "location.delete", entityType: "Location", entityId: id, metadata: { name: result.name }, req });
  return NextResponse.json({ ok: true });
}
