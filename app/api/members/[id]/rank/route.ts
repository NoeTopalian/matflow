import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";

const assignSchema = z.object({
  rankSystemId: z.string().min(1),
  stripes: z.number().int().min(0).max(10).default(0),
  notes: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canPromote = ["owner", "manager", "coach"].includes(session.user.role);
  if (!canPromote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { rankSystemId, stripes, notes } = parsed.data;

  // Verify member belongs to this tenant
  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId: session.user.tenantId },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  // Verify rank belongs to this tenant
  const rankSystem = await prisma.rankSystem.findFirst({
    where: { id: rankSystemId, tenantId: session.user.tenantId },
  });
  if (!rankSystem) return NextResponse.json({ error: "Rank not found" }, { status: 404 });

  try {
    // Find existing rank for this discipline (same discipline as rankSystem)
    const existingRank = await prisma.memberRank.findFirst({
      where: {
        memberId,
        rankSystem: { discipline: rankSystem.discipline, tenantId: session.user.tenantId },
      },
      include: { rankSystem: true },
    });

    if (existingRank) {
      // Update existing rank for this discipline
      const updated = await prisma.memberRank.update({
        where: { id: existingRank.id },
        data: {
          rankSystemId,
          stripes,
          achievedAt: new Date(),
          promotedById: session.user.id,
          rankHistory: {
            create: {
              fromRankId: existingRank.rankSystemId,
              toRankId: rankSystemId,
              promotedById: session.user.id,
              notes,
            },
          },
        },
        include: { rankSystem: true },
      });
      await logAudit({
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: "member.rank.promote",
        entityType: "Member",
        entityId: memberId,
        metadata: { fromRankId: existingRank.rankSystemId, toRankId: rankSystemId, stripes },
        req,
      });
      return NextResponse.json(updated);
    } else {
      // Create new rank entry
      const created = await prisma.memberRank.create({
        data: {
          memberId,
          rankSystemId,
          stripes,
          promotedById: session.user.id,
          rankHistory: {
            create: {
              fromRankId: null,
              toRankId: rankSystemId,
              promotedById: session.user.id,
              notes,
            },
          },
        },
        include: { rankSystem: true },
      });
      await logAudit({
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: "member.rank.promote",
        entityType: "Member",
        entityId: memberId,
        metadata: { fromRankId: null, toRankId: rankSystemId, stripes },
        req,
      });
      return NextResponse.json(created, { status: 201 });
    }
  } catch {
    return NextResponse.json({ error: "Failed to assign rank" }, { status: 500 });
  }
}
