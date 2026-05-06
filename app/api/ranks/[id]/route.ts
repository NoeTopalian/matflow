import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  order: z.number().int().min(0).max(999).optional(),
  color: z.string().max(20).optional().nullable(),
  stripes: z.number().int().min(0).max(10).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const rank = await withTenantContext(session.user.tenantId, async (tx) => {
      const r = await tx.rankSystem.updateMany({
        where: { id, tenantId: session.user.tenantId },
        data: parsed.data,
      });
      if (r.count === 0) return null;
      return tx.rankSystem.findFirst({ where: { id, tenantId: session.user.tenantId } });
    });
    if (!rank) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "rank.updated",
      entityType: "RankSystem",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });

    return NextResponse.json(rank);
  } catch {
    return NextResponse.json({ error: "Failed to update rank" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const deleted = await withTenantContext(session.user.tenantId, (tx) =>
      tx.rankSystem.deleteMany({
        where: { id, tenantId: session.user.tenantId },
      }),
    );
    if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "rank.deleted",
      entityType: "RankSystem",
      entityId: id,
      metadata: null,
      req,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Cannot delete rank — it may be in use" }, { status: 409 });
  }
}
