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

    // One query per kid is fine — MAX_KIDS_PER_PARENT caps this at 10 round
    // trips, and Prisma + the connection pool handle that comfortably.
    const withTimetable = await withTenantContext(session.user.tenantId, async (tx) => {
      return Promise.all(
        base.map(async (kid) => {
          const subs = await tx.classSubscription.findMany({
            where: { memberId: kid.id },
            select: { classId: true },
          });
          if (subs.length === 0) {
            return { ...kid, timetable: [] as KidTimetableEntry[] };
          }
          const classIds = subs.map((s) => s.classId);
          const instances = await tx.classInstance.findMany({
            where: {
              classId: { in: classIds },
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
          // Defence-in-depth: the FK chain Class.tenantId → session.tenantId
          // should already gate this via withTenantContext, but filter again
          // to make sure no cross-tenant ClassInstance leaks if RLS is mid-rollout.
          const ours = instances.filter(
            (i) => i.class.tenantId === session.user.tenantId,
          );
          const timetable: KidTimetableEntry[] = ours.map((i) => ({
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
        }),
      );
    });

    return NextResponse.json(withTimetable);
  } catch (e) {
    return apiError("Failed to load children", 500, e, "[member/me/children]");
  }
}
