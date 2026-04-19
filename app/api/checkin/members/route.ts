/**
 * GET /api/checkin/members?instanceId=xxx
 * Returns all active members with their check-in status for a specific class instance.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const instanceId = searchParams.get("instanceId");
  if (!instanceId) return NextResponse.json({ error: "instanceId required" }, { status: 400 });

  // Verify instance belongs to this tenant
  const instance = await prisma.classInstance.findFirst({
    where: { id: instanceId, class: { tenantId: session.user.tenantId } },
  });
  if (!instance) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [members, attendances] = await Promise.all([
    prisma.member.findMany({
      where: { tenantId: session.user.tenantId, status: { in: ["active", "taster"] } },
      include: {
        memberRanks: {
          include: { rankSystem: true },
          orderBy: { achievedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.attendanceRecord.findMany({
      where: { classInstanceId: instanceId },
      select: { memberId: true },
    }),
  ]);

  const checkedInIds = new Set(attendances.map((a: typeof attendances[number]) => a.memberId));

  const result = members.map((m) => ({
    id: m.id,
    name: m.name,
    membershipType: m.membershipType,
    rankName: m.memberRanks[0]?.rankSystem.name ?? null,
    rankColor: m.memberRanks[0]?.rankSystem.color ?? null,
    checkedIn: checkedInIds.has(m.id),
  }));

  return NextResponse.json(result);
}
