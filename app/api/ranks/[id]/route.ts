import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
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
    const updated = await prisma.rankSystem.updateMany({
      where: { id, tenantId: session.user.tenantId },
      data: parsed.data,
    });
    if (updated.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const rank = await prisma.rankSystem.findFirst({ where: { id } });
    return NextResponse.json(rank);
  } catch {
    return NextResponse.json({ error: "Failed to update rank" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const deleted = await prisma.rankSystem.deleteMany({
      where: { id, tenantId: session.user.tenantId },
    });
    if (deleted.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Cannot delete rank — it may be in use" }, { status: 409 });
  }
}
