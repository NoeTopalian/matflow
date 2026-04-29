import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

export async function GET() {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  try {
    const children = await prisma.member.findMany({
      where: { parentMemberId: memberId, tenantId: session.user.tenantId },
      select: {
        id: true,
        name: true,
        dateOfBirth: true,
        accountType: true,
        waiverAccepted: true,
        memberRanks: {
          orderBy: { achievedAt: "desc" },
          take: 1,
          select: {
            stripes: true,
            rankSystem: { select: { name: true, color: true } },
          },
        },
        _count: { select: { attendances: true } },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(
      children.map((c) => ({
        id: c.id,
        name: c.name,
        dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString() : null,
        accountType: c.accountType,
        waiverAccepted: c.waiverAccepted,
        belt: c.memberRanks[0]
          ? {
              name: c.memberRanks[0].rankSystem.name,
              color: c.memberRanks[0].rankSystem.color ?? "#e5e7eb",
              stripes: c.memberRanks[0].stripes,
            }
          : null,
        totalClasses: c._count.attendances,
      })),
    );
  } catch (e) {
    return apiError("Failed to load children", 500, e, "[member/me/children]");
  }
}
