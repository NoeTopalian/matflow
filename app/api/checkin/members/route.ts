/**
 * GET /api/checkin/members?instanceId=xxx&take=200&cursor=<id>
 * Returns active members with their check-in status for a specific class instance.
 * Paginated: default take=200, max take=500, cursor-paginated by id ordered by name asc.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Staff-only — without this, a member could enumerate every active member
  // and their check-in status for any class. (Security audit 2026-05-07,
  // severity LOW.)
  const canRead = ["owner", "manager", "coach", "admin"].includes(session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const instanceId = searchParams.get("instanceId");
  if (!instanceId) return NextResponse.json({ error: "instanceId required" }, { status: 400 });

  const rawTake = parseInt(searchParams.get("take") ?? "200", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 200 : rawTake, 500);
  const cursor = searchParams.get("cursor") ?? undefined;

  const data = await withTenantContext(session.user.tenantId, async (tx) => {
    const instance = await tx.classInstance.findFirst({
      where: { id: instanceId, class: { tenantId: session.user.tenantId } },
    });
    if (!instance) return null;
    const [members, attendances] = await Promise.all([
      tx.member.findMany({
        where: { tenantId: session.user.tenantId, status: { in: ["active", "taster"] } },
        select: { id: true, name: true, membershipType: true },
        orderBy: { name: "asc" },
        take,
        cursor: cursor ? { id: cursor } : undefined,
        skip: cursor ? 1 : 0,
      }),
      tx.attendanceRecord.findMany({
        where: { classInstanceId: instanceId },
        select: { memberId: true },
      }),
    ]);
    const memberIds = members.map((m) => m.id);
    const rankRows = memberIds.length > 0
      ? await tx.memberRank.findMany({
          where: { memberId: { in: memberIds } },
          orderBy: { achievedAt: "desc" },
          include: { rankSystem: true },
        })
      : [];
    return { members, attendances, rankRows };
  });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { members, attendances, rankRows } = data;
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

  const nextCursor = members.length === take ? members[members.length - 1].id : null;
  return NextResponse.json({ members: result, nextCursor });
}
