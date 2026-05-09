import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";

const demoteSchema = z.object({
  toRankId: z.string().min(1),
  reason: z.string().min(5).max(500).optional(),
  notify: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canDemote = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canDemote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = demoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { toRankId, reason, notify } = parsed.data;
  const tenantId = session.user.tenantId;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const member = await tx.member.findFirst({ where: { id: memberId, tenantId } });
      if (!member) return { kind: "no-member" as const };

      const newRank = await tx.rankSystem.findFirst({
        where: { id: toRankId, tenantId, deletedAt: null },
      });
      if (!newRank) return { kind: "no-rank" as const };

      const existingRank = await tx.memberRank.findFirst({
        where: {
          memberId,
          rankSystem: { discipline: newRank.discipline, tenantId },
        },
        include: { rankSystem: true },
      });

      const updated = existingRank
        ? await tx.memberRank.update({
            where: { id: existingRank.id },
            data: {
              rankSystemId: toRankId,
              stripes: 0,
              achievedAt: new Date(),
              promotedById: session.user.id,
              rankHistory: {
                create: {
                  fromRankId: existingRank.rankSystemId,
                  toRankId,
                  promotedById: session.user.id,
                  notes: reason ?? "demotion",
                },
              },
            },
            include: { rankSystem: true },
          })
        : await tx.memberRank.create({
            data: {
              memberId,
              rankSystemId: toRankId,
              stripes: 0,
              promotedById: session.user.id,
              rankHistory: {
                create: {
                  fromRankId: null,
                  toRankId,
                  promotedById: session.user.id,
                  notes: reason ?? "demotion",
                },
              },
            },
            include: { rankSystem: true },
          });

      // Cascade-cancel ClassSubscription for classes the member is no longer eligible for.
      // Eligibility lost when class.requiredRank is in the same discipline AND order > newRank.order
      // (or class.maxRank order < newRank.order — though demotion below max is rarely the trigger).
      const ineligibleClasses = await tx.class.findMany({
        where: {
          tenantId,
          OR: [
            {
              requiredRank: {
                discipline: newRank.discipline,
                order: { gt: newRank.order },
              },
            },
            {
              maxRank: {
                discipline: newRank.discipline,
                order: { lt: newRank.order },
              },
            },
          ],
        },
        select: { id: true },
      });

      const cancelled = ineligibleClasses.length
        ? await tx.classSubscription.deleteMany({
            where: { memberId, classId: { in: ineligibleClasses.map((c) => c.id) } },
          })
        : { count: 0 };

      return {
        kind: "ok" as const,
        value: updated,
        fromRankId: existingRank?.rankSystemId ?? null,
        cancelledSubscriptions: cancelled.count,
        memberEmail: member.email,
        memberName: member.name,
      };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (result.kind === "no-rank") return NextResponse.json({ error: "Rank not found" }, { status: 404 });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "member.rank.demote",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        fromRankId: result.fromRankId,
        toRankId,
        reason: reason ?? null,
        cancelledSubscriptions: result.cancelledSubscriptions,
      },
      req,
    });

    if (notify && result.memberEmail) {
      try {
        const { sendEmail } = await import("@/lib/email");
        await sendEmail({
          tenantId,
          templateId: "rank_demoted",
          to: result.memberEmail,
          vars: {
            memberName: result.memberName ?? "Member",
            newRankName: result.value.rankSystem?.name ?? "(unknown)",
            reason: reason ?? "",
          },
        });
      } catch (e) {
        console.error("[rank.demote] notify email failed", e);
      }
    }

    return NextResponse.json({
      ok: true,
      memberRank: result.value,
      cancelledSubscriptions: result.cancelledSubscriptions,
    });
  } catch {
    return NextResponse.json({ error: "Failed to demote" }, { status: 500 });
  }
}
