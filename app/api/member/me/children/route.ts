import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

// F4 — parent-mode timetable.
//
// GET /api/member/me/children
//   Returns the logged-in parent's kids with name/belt/totalClasses (existing
//   shape — keep so the lightweight SignInSheet picker doesn't pay the extra
//   query cost on every refresh).
//
// GET /api/member/me/children?include=timetable
//   Same as above PLUS each kid carries a `timetable: ClassOccurrence[]`
//   field holding the next 7 days of ClassInstance rows for classes the kid
//   has subscribed to via ClassSubscription. Empty array means the kid has
//   no subscribed classes yet — the UI surfaces a "Sign up for a class"
//   nudge instead of pretending the schedule is genuinely empty.
//
// Time window: from start of TODAY (local-clock midnight) through end of
// (today + 6 days). Inclusive on both ends so a 7-day strip always shows.

export type KidTimetableEntry = {
  classInstanceId: string;
  classId: string;
  className: string;
  date: string; // ISO date (YYYY-MM-DD)
  startTime: string;
  endTime: string;
  coach: string | null;
  location: string | null;
  isCancelled: boolean;
};

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function plusDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  const includeTimetable = new URL(req.url).searchParams.get("include") === "timetable";

  try {
    const children = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findMany({
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
      }),
    );

    // Build the base payload first; bolt the timetable on per kid afterwards
    // if requested. Keeps the no-include path identical to the historical
    // response so existing SignInSheet/parent-feed callers don't shift.
    const base = children.map((c) => ({
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
    }));

    if (!includeTimetable || base.length === 0) {
      return NextResponse.json(base);
    }

    const windowStart = startOfTodayUTC();
    const windowEnd = plusDays(windowStart, 7); // exclusive — covers today + next 6 days

    // Audit iter-1-member-surface A5H-7: was N+1 (1+2K trips per K kids).
    // Now 2 bulk queries regardless of K: one classSubscription.findMany
    // for all kids at once, one classInstance.findMany for the union of
    // their classIds. Group in JS by memberId to assemble the per-kid
    // timetable. At the 10-kid cap this drops from 21 trips to 3.
    const withTimetable = await withTenantContext(session.user.tenantId, async (tx) => {
      const kidIds = base.map((k) => k.id);
      const subs = await tx.classSubscription.findMany({
        where: { memberId: { in: kidIds } },
        select: { memberId: true, classId: true },
      });

      // Group subscriptions by memberId so we can attach the timetable per-kid.
      const subsByMember = new Map<string, string[]>();
      const allClassIds = new Set<string>();
      for (const s of subs) {
        const arr = subsByMember.get(s.memberId) ?? [];
        arr.push(s.classId);
        subsByMember.set(s.memberId, arr);
        allClassIds.add(s.classId);
      }

      // Empty short-circuit: no subscriptions across all kids → skip the
      // second query entirely.
      if (allClassIds.size === 0) {
        return base.map((kid) => ({ ...kid, timetable: [] as KidTimetableEntry[] }));
      }

      const instances = await tx.classInstance.findMany({
        where: {
          classId: { in: Array.from(allClassIds) },
          date: { gte: windowStart, lt: windowEnd },
        },
        select: {
          id: true,
          classId: true,
          date: true,
          startTime: true,
          endTime: true,
          isCancelled: true,
          class: {
            select: {
              name: true,
              coachName: true,
              location: true,
              tenantId: true,
            },
          },
        },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      });

      // Index instances by classId for O(1) lookup per kid below.
      const ourInstances = instances.filter(
        (i) => i.class.tenantId === session.user.tenantId,
      );
      const byClassId = new Map<string, typeof ourInstances>();
      for (const inst of ourInstances) {
        const arr = byClassId.get(inst.classId) ?? [];
        arr.push(inst);
        byClassId.set(inst.classId, arr);
      }

      return base.map((kid) => {
        const myClassIds = subsByMember.get(kid.id) ?? [];
        const myInstances = myClassIds.flatMap((cid) => byClassId.get(cid) ?? []);
        // Re-sort the union (per-classId arrays were sorted but unioning
        // them needs a re-sort).
        myInstances.sort((a, b) => {
          const d = a.date.getTime() - b.date.getTime();
          return d !== 0 ? d : a.startTime.localeCompare(b.startTime);
        });
        const timetable: KidTimetableEntry[] = myInstances.map((i) => ({
          classInstanceId: i.id,
          classId: i.classId,
          className: i.class.name,
          date: i.date.toISOString().slice(0, 10),
          startTime: i.startTime,
          endTime: i.endTime,
          coach: i.class.coachName,
          location: i.class.location,
          isCancelled: i.isCancelled,
        }));
        return { ...kid, timetable };
      });
    });

    return NextResponse.json(withTimetable);
  } catch (e) {
    return apiError("Failed to load children", 500, e, "[member/me/children]");
  }
}
