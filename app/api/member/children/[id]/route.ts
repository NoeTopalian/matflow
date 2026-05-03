import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return apiError("Not found", 404);

  const { id } = await params;

  try {
    const child = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findFirst({
        where: {
          id,
          parentMemberId: memberId,
          tenantId: session.user.tenantId,
        },
        select: {
          id: true,
          name: true,
          dateOfBirth: true,
          accountType: true,
          waiverAccepted: true,
          joinedAt: true,
          memberRanks: {
            orderBy: { achievedAt: "desc" },
            take: 1,
            include: { rankSystem: true },
          },
          attendances: {
            orderBy: { checkInTime: "desc" },
            take: 20,
            include: {
              classInstance: {
                include: { class: { select: { name: true } } },
              },
            },
          },
          _count: { select: { attendances: true } },
        },
      }),
    );

    if (!child) return apiError("Not found", 404);

    const currentRank = child.memberRanks[0];
    return NextResponse.json({
      id: child.id,
      name: child.name,
      dateOfBirth: child.dateOfBirth ? child.dateOfBirth.toISOString() : null,
      accountType: child.accountType,
      waiverAccepted: child.waiverAccepted,
      joinedAt: child.joinedAt.toISOString(),
      belt: currentRank
        ? {
            name: currentRank.rankSystem.name,
            color: currentRank.rankSystem.color ?? "#e5e7eb",
            stripes: currentRank.stripes,
            achievedAt: currentRank.achievedAt.toISOString(),
          }
        : null,
      totalClasses: child._count.attendances,
      recentAttendance: child.attendances.map((a) => ({
        id: a.id,
        className: a.classInstance.class.name,
        date: a.classInstance.date.toISOString(),
        checkInTime: a.checkInTime.toISOString(),
      })),
    });
  } catch (e) {
    return apiError("Failed to load child", 500, e, "[member/children/[id]]");
  }
}
