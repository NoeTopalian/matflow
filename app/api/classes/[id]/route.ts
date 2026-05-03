import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  coachName: z.string().max(100).optional().nullable(),
  coachUserId: z.string().optional().nullable(),
  location: z.string().max(100).optional().nullable(),
  duration: z.number().int().min(1).max(480).optional(),
  maxCapacity: z.number().int().min(1).max(1000).optional().nullable(),
  requiredRankId: z.string().optional().nullable(),
  maxRankId: z.string().optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const cls = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findFirst({
        where: { id, tenantId: session.user.tenantId },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
      }),
    );
    if (!cls) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(cls);
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

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
    const updated = await withTenantContext(session.user.tenantId, async (tx) => {
      const r = await tx.class.updateMany({
        where: { id, tenantId: session.user.tenantId },
        data: parsed.data,
      });
      if (r.count === 0) return null;
      return tx.class.findFirst({
        where: { id, tenantId: session.user.tenantId },
        include: { schedules: { where: { isActive: true } }, requiredRank: true, maxRank: true, coachUser: { select: { id: true, name: true } } },
      });
    });
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ error: "Failed to update class" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    // Soft-delete by setting isActive = false
    await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.updateMany({
        where: { id, tenantId: session.user.tenantId },
        data: { isActive: false },
      }),
    );
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete class" }, { status: 500 });
  }
}
