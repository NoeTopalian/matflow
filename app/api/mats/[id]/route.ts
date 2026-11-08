/**
 * PATCH  /api/mats/[id] {name} — rename a mat (owner + manager)
 * DELETE /api/mats/[id]        — remove a mat (owner + manager)
 *
 * Renaming rewrites the place text of every class on the mat in the same
 * transaction (the write-through rule, lib/mats.ts). Removing a mat never
 * removes a class: its classes fall to "no mat" and keep the mat's name as
 * their typed place, so one press puts them back if the mat is added again.
 * Another club's id answers exactly as a missing one.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseSupportSessionUnlessEdit } from "@/lib/support-session";
import { logAudit } from "@/lib/audit-log";
import { MAT_NAME_MAX, cleanMatName, lockClubMats, matNameKey } from "@/lib/mats";

export const runtime = "nodejs";

const renameSchema = z.object({ name: z.string().max(200) }).strict();
const NOT_FOUND = "That mat isn't one of your mats any more.";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSessionUnlessEdit(gate.session); if (support) return support; // view refused; an EDIT session may set up mats and the split (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  const { tenantId, userId } = gate;
  const { id } = await params;

  let body: unknown = null;
  try { body = await req.json(); } catch {}
  const parsed = renameSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Give the mat a name." }, { status: 400 });
  const name = cleanMatName(parsed.data.name);
  // Blank by its key: a name of nothing but invisible characters is no name (lib/mats.ts matNameKey).
  if (!matNameKey(name)) return NextResponse.json({ error: "Give the mat a name." }, { status: 400 });
  if (name.length > MAT_NAME_MAX) return NextResponse.json({ error: `A mat name can be up to ${MAT_NAME_MAX} characters.` }, { status: 400 });
  const nameKey = matNameKey(name);

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      await lockClubMats(tx, tenantId);
      const existing = await tx.mat.findFirst({ where: { id, tenantId }, select: { id: true, name: true } });
      if (!existing) return { ok: false as const, status: 404, error: NOT_FOUND };
      // The name already stored: nothing to write, nothing to record.
      if (existing.name === name) return { ok: true as const, row: existing, changed: false };
      const clash = await tx.mat.findFirst({ where: { tenantId, nameKey, id: { not: id } }, select: { name: true } });
      if (clash) return { ok: false as const, status: 409, error: `You already have a mat called ${clash.name}.` };
      // Scoped by club as well as id (TENANT-SCOPE-CONVENTION): never an update by bare id.
      const updated = await tx.mat.updateMany({ where: { id, tenantId }, data: { name, nameKey } });
      if (updated.count === 0) return { ok: false as const, status: 404, error: NOT_FOUND };
      const row = { id, name };
      // Write-through: a class on a mat always shows that mat's current name.
      const classes = await tx.class.updateMany({ where: { tenantId, matId: id }, data: { location: name } });
      await logAudit({
        tenantId, userId, action: "mat.update", entityType: "Mat", entityId: id,
        metadata: { before: { name: existing.name }, after: { name }, classesRenamed: classes.count }, req, tx,
      });
      return { ok: true as const, row, changed: true };
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ id: result.row.id, name: result.row.name, changed: result.changed });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: `You already have a mat called ${name}.` }, { status: 409 });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSessionUnlessEdit(gate.session); if (support) return support; // view refused; an EDIT session may set up mats and the split (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  const { tenantId, userId } = gate;
  const { id } = await params;

  const result = await withTenantContext(tenantId, async (tx) => {
    await lockClubMats(tx, tenantId);
    const existing = await tx.mat.findFirst({ where: { id, tenantId }, select: { id: true, name: true } });
    if (!existing) return { ok: false as const, status: 404, error: NOT_FOUND };
    // Every class on it, archived ones too: the record says exactly which rows lost the mat.
    const classes = await tx.class.findMany({ where: { tenantId, matId: id }, select: { id: true }, orderBy: { id: "asc" } });
    // The class link is ON DELETE SET NULL: the classes stay, with the mat's name as their typed place.
    const removed = await tx.mat.deleteMany({ where: { id, tenantId } });
    if (removed.count === 0) return { ok: false as const, status: 404, error: NOT_FOUND };
    await logAudit({
      tenantId, userId, action: "mat.delete", entityType: "Mat", entityId: id,
      metadata: { name: existing.name, classIds: classes.map((c) => c.id) }, req, tx,
    });
    return { ok: true as const, name: existing.name, classCount: classes.length };
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, name: result.name, classCount: result.classCount });
}
