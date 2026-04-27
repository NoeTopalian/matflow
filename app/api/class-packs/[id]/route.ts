import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const updated = await prisma.classPack.updateMany({
    where: { id, tenantId },
    data: parsed.data as Record<string, unknown>,
  });
  if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    tenantId, userId,
    action: "class_pack.update",
    entityType: "ClassPack",
    entityId: id,
    metadata: { fields: Object.keys(parsed.data) },
    req,
  });

  const fresh = await prisma.classPack.findUnique({ where: { id } });
  return NextResponse.json(fresh);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id } = await params;

  // Soft-deactivate rather than hard-delete so existing MemberClassPack rows keep their FK
  const updated = await prisma.classPack.updateMany({
    where: { id, tenantId },
    data: { isActive: false },
  });
  if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await logAudit({
    tenantId, userId,
    action: "class_pack.deactivate",
    entityType: "ClassPack",
    entityId: id,
    req,
  });

  return NextResponse.json({ ok: true });
}
