import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { logAudit } from "@/lib/audit-log";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: z.enum(["manager", "coach", "admin"]).optional(),
  newPassword: z.string().min(8).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can edit staff" }, { status: 403 });

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

  const { newPassword, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (newPassword) {
    data.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  try {
    const updated = await prisma.user.updateMany({
      where: { id, tenantId: session.user.tenantId, role: { not: "owner" } },
      data,
    });
    if (updated.count === 0) return NextResponse.json({ error: "Not found or cannot edit owner" }, { status: 404 });
    const user = await prisma.user.findFirst({ where: { id }, select: { id: true, name: true, email: true, role: true } });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.update",
      entityType: "User",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });
    return NextResponse.json(user);
  } catch {
    return NextResponse.json({ error: "Failed to update staff" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can remove staff" }, { status: 403 });

  const { id } = await params;

  // Cannot delete yourself
  if (id === session.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  try {
    const deleted = await prisma.user.deleteMany({
      where: { id, tenantId: session.user.tenantId, role: { not: "owner" } },
    });
    if (deleted.count === 0) return NextResponse.json({ error: "Not found or cannot delete owner" }, { status: 404 });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.delete",
      entityType: "User",
      entityId: id,
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove staff member" }, { status: 500 });
  }
}
