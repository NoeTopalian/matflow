import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

const INITIATIVE_TYPES = ["marketing", "new_class", "price_change", "holiday", "coach_hired", "other"] as const;

const createSchema = z.object({
  type: z.enum(INITIATIVE_TYPES),
  startDate: z.string().min(1),
  endDate: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

export async function GET() {
  const { tenantId } = await requireOwnerOrManager();

  try {
    const rows = await prisma.initiative.findMany({
      where: { tenantId },
      include: { attachments: true },
      orderBy: { startDate: "desc" },
      take: 100,
    });
    return NextResponse.json(rows);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const { session, tenantId, userId } = await requireOwnerOrManager();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { type, startDate, endDate, notes } = parsed.data;

  try {
    const created = await prisma.initiative.create({
      data: {
        tenantId,
        type,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        notes: notes ?? null,
        createdById: userId,
      },
      include: { attachments: true },
    });
    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "initiative.create",
      entityType: "Initiative",
      entityId: created.id,
      metadata: { type, startDate },
      req,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create initiative" }, { status: 500 });
  }
}
