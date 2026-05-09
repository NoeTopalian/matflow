/**
 * GET /api/member/schedule
 * Returns all active classes + schedules for the logged-in member's tenant.
 * Used by the member Schedule and Home pages.
 *
 * Each entry has an `eligibility` flag:
 *   - "ok": rank-eligible or no rank gate
 *   - "rank_below": class.requiredRank set and member's rank order < threshold
 *   - "rank_above": class.maxRank set and member's rank order > threshold
 *   - "roster_ok": member is on the class's roster (overrides rank for display)
 *
 * Roster-only classes the member is NOT on are filtered server-side
 * (security, not just UI).
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { resolveCoachName } from "@/lib/class-coach";

const DEMO_CLASSES = [
  { id: "m1",  name: "Fundamentals BJJ", startTime: "09:30", endTime: "10:30", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1, color: "#3b82f6" },
  { id: "m2",  name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 1, color: "#8b5cf6" },
  { id: "m3",  name: "Open Mat",         startTime: "20:00", endTime: "21:30", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 1, color: "#10b981" },
  { id: "t1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 2, color: "#3b82f6" },
  { id: "t2",  name: "Open Mat",         startTime: "12:00", endTime: "14:00", coach: "Coach Sarah", location: "Main Mat", capacity: null, dayOfWeek: 2, color: "#10b981" },
  { id: "w1",  name: "Kids BJJ",         startTime: "17:00", endTime: "17:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 3, color: "#f97316" },
  { id: "w2",  name: "Advanced BJJ",     startTime: "19:00", endTime: "20:15", coach: "Coach Mike",  location: "Mat 1",    capacity: 18, dayOfWeek: 3, color: "#ef4444" },
  { id: "th1", name: "No-Gi",            startTime: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    capacity: 20, dayOfWeek: 4, color: "#8b5cf6" },
  { id: "th2", name: "Beginners",        startTime: "19:15", endTime: "20:15", coach: "Coach Sarah", location: "Mat 2",    capacity: 14, dayOfWeek: 4, color: "#3b82f6" },
  { id: "f1",  name: "Beginner BJJ",     startTime: "10:00", endTime: "11:00", coach: "Coach Sarah", location: "Mat 1",    capacity: 16, dayOfWeek: 5, color: "#3b82f6" },
  { id: "f2",  name: "Open Mat",         startTime: "18:00", endTime: "20:00", coach: "Open",        location: "Main Mat", capacity: null, dayOfWeek: 5, color: "#10b981" },
  { id: "s1",  name: "Saturday Session", startTime: "10:00", endTime: "12:00", coach: "Coach Mike",  location: "Main Mat", capacity: 30, dayOfWeek: 6, color: "#0ea5e9" },
  { id: "s2",  name: "Kids BJJ",         startTime: "09:00", endTime: "09:45", coach: "Coach Emma",  location: "Mat 2",    capacity: 12, dayOfWeek: 6, color: "#f97316" },
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date"); // YYYY-MM-DD, optional

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json(DEMO_CLASSES);
  }

  const memberId = session.user.memberId;

  try {
    const { classes, instanceMap, memberRanks, rosterClassIds, rosterCounts } = await withTenantContext(
      session.user.tenantId,
      async (tx) => {
        const cls = await tx.class.findMany({
          where: { tenantId: session.user.tenantId, isActive: true },
          select: {
            id: true,
            name: true,
            color: true,
            coachName: true,
            coachUser: { select: { id: true, name: true } },
            location: true,
            maxCapacity: true,
            requiredRank: { select: { id: true, name: true, discipline: true, order: true } },
            maxRank: { select: { id: true, name: true, discipline: true, order: true } },
            schedules: {
              where: { isActive: true },
              select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
            },
          },
        });

        const map = new Map<string, string>();
        if (dateParam) {
          const startOfDay = new Date(`${dateParam}T00:00:00.000Z`);
          const endOfDay   = new Date(`${dateParam}T23:59:59.999Z`);
          const instances  = await tx.classInstance.findMany({
            where: {
              class: { tenantId: session.user.tenantId },
              date: { gte: startOfDay, lte: endOfDay },
              isCancelled: false,
            },
            select: { id: true, classId: true, startTime: true },
          });
          for (const inst of instances) {
            map.set(`${inst.classId}-${inst.startTime}`, inst.id);
          }
        }

        // Member's ranks (for eligibility computation) and roster memberships.
        const ranks = memberId
          ? await tx.memberRank.findMany({
              where: { memberId },
              include: { rankSystem: { select: { id: true, discipline: true, order: true } } },
            })
          : [];
        const rosterMembershipsRaw = memberId
          ? await tx.classRoster.findMany({
              where: { memberId },
              select: { classId: true },
            })
          : [];
        const rosterIds = new Set(rosterMembershipsRaw.map((r) => r.classId));

        // For each class, count whether it has ANY roster (i.e., is roster-only mode).
        const counts = await tx.classRoster.groupBy({
          by: ["classId"],
          where: { tenantId: session.user.tenantId, classId: { in: cls.map((c) => c.id) } },
          _count: { _all: true },
        });
        const countMap = new Map<string, number>(counts.map((c) => [c.classId, c._count._all]));

        return {
          classes: cls,
          instanceMap: map,
          memberRanks: ranks,
          rosterClassIds: rosterIds,
          rosterCounts: countMap,
        };
      },
    );

    type Cls = typeof classes[number];
    type Sched = Cls["schedules"][number];

    const result = classes
      .flatMap((cls: Cls) => {
        const isRosterMode = (rosterCounts.get(cls.id) ?? 0) > 0;
        const memberOnRoster = rosterClassIds.has(cls.id);

        // Roster-only class member is NOT on → server-side hide entirely.
        if (isRosterMode && !memberOnRoster) return [];

        // Compute eligibility per class (constant across schedule entries).
        let eligibility: "ok" | "rank_below" | "rank_above" | "roster_ok" = "ok";
        if (memberOnRoster) {
          eligibility = "roster_ok";
        } else if (cls.requiredRank) {
          const r = memberRanks.find((mr) => mr.rankSystem.discipline === cls.requiredRank!.discipline);
          if (!r || r.rankSystem.order < cls.requiredRank.order) eligibility = "rank_below";
        }
        if (eligibility === "ok" && cls.maxRank) {
          const r = memberRanks.find((mr) => mr.rankSystem.discipline === cls.maxRank!.discipline);
          if (r && r.rankSystem.order > cls.maxRank.order) eligibility = "rank_above";
        }

        return cls.schedules.map((sched: Sched) => ({
          id: `${cls.id}-${sched.id}`,
          classId: cls.id,
          scheduleId: sched.id,
          name: cls.name,
          color: cls.color,
          startTime: sched.startTime,
          endTime: sched.endTime,
          coach: resolveCoachName(cls) ?? "TBC",
          location: cls.location ?? "",
          capacity: cls.maxCapacity,
          dayOfWeek: sched.dayOfWeek,
          classInstanceId: instanceMap.get(`${cls.id}-${sched.startTime}`) ?? null,
          eligibility,
          requiredRankName: cls.requiredRank?.name ?? null,
          maxRankName: cls.maxRank?.name ?? null,
        }));
      });

    return NextResponse.json(result);
  } catch {
    if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);
    return NextResponse.json([]);
  }
}
