import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
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

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
      });
      if (!member) return { kind: "no-member" as const };

      const rankSystem = await tx.rankSystem.findFirst({
        where: { id: rankSystemId, tenantId: session.user.tenantId },
      });
      if (!rankSystem) return { kind: "no-rank" as const };

      const existingRank = await tx.memberRank.findFirst({
        where: {
          memberId,
          rankSystem: { discipline: rankSystem.discipline, tenantId: session.user.tenantId },
        },
        include: { rankSystem: true },
      });

      if (existingRank) {
        const updated = await tx.memberRank.update({
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
        return { kind: "updated" as const, value: updated, fromRankId: existingRank.rankSystemId };
      }

      const created = await tx.memberRank.create({
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
      return { kind: "created" as const, value: created };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (result.kind === "no-rank") return NextResponse.json({ error: "Rank not found" }, { status: 404 });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.rank.promote",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        fromRankId: result.kind === "updated" ? result.fromRankId : null,
        toRankId: rankSystemId,
        stripes,
      },
      req,
    });

    return NextResponse.json(result.value, { status: result.kind === "updated" ? 200 : 201 });
  } catch {
    return NextResponse.json({ error: "Failed to assign rank" }, { status: 500 });
  }
}
