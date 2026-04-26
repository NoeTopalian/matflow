import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

const INITIATIVE_TYPES = ["marketing", "new_class", "price_change", "holiday", "coach_hired", "other"] as const;

const updateSchema = z.object({
  type: z.enum(INITIATIVE_TYPES).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { type, startDate, endDate, notes } = parsed.data;
  const data: Record<string, unknown> = {};
  if (type !== undefined) data.type = type;
  if (startDate !== undefined) data.startDate = new Date(startDate);
  if (endDate !== undefined) data.endDate = endDate ? new Date(endDate) : null;
  if (notes !== undefined) data.notes = notes;

  try {
    const updated = await prisma.initiative.updateMany({ where: { id, tenantId }, data });
    if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const fresh = await prisma.initiative.findUnique({ where: { id }, include: { attachments: true } });
    await logAudit({
      tenantId,
      userId,
      action: "initiative.update",
      entityType: "Initiative",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });
    return NextResponse.json(fresh);
  } catch {
    return NextResponse.json({ error: "Failed to update initiative" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId } = await requireOwnerOrManager();
  const { id } = await params;

  try {
    const deleted = await prisma.initiative.deleteMany({ where: { id, tenantId } });
    if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await logAudit({
      tenantId,
      userId,
      action: "initiative.delete",
      entityType: "Initiative",
      entityId: id,
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete initiative" }, { status: 500 });
  }
}
