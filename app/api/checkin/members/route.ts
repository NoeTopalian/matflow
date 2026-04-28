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
      select: { id: true, name: true, membershipType: true },
      orderBy: { name: "asc" },
    }),
    prisma.attendanceRecord.findMany({
      where: { classInstanceId: instanceId },
      select: { memberId: true },
    }),
  ]);

  const memberIds = members.map((m) => m.id);
  const rankRows = memberIds.length > 0
    ? await prisma.memberRank.findMany({
        where: { memberId: { in: memberIds } },
        orderBy: { achievedAt: "desc" },
        include: { rankSystem: true },
      })
    : [];
  const ranksByMember = new Map<string, typeof rankRows[number]>();
  for (const r of rankRows) {
    if (!ranksByMember.has(r.memberId)) ranksByMember.set(r.memberId, r);
  }

  const checkedInIds = new Set(attendances.map((a) => a.memberId));

  const result = members.map((m) => {
    const rank = ranksByMember.get(m.id) ?? null;
    return {
      id: m.id,
      name: m.name,
      membershipType: m.membershipType,
      rankName: rank?.rankSystem.name ?? null,
      rankColor: rank?.rankSystem.color ?? null,
      checkedIn: checkedInIds.has(m.id),
    };
  });

  return NextResponse.json(result);
}
