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
 *   - "tier_not_included": the class's memberships (ClassMembershipTier) do
 *     not include the member's plan (T6a) — shown locked, not bookable
 *
 * `kidsClassForAdult` is true on a kids class when the viewer is an adult or
 * parent: check-in refuses them, so the timetable never badges it "Next" for
 * them (the Home card's pickNextClass rule). The "Kids" tag still shows.
 *
 * Roster-only classes the member is NOT on are filtered server-side
 * (security, not just UI).
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { ensureClassHorizon } from "@/lib/class-horizon";
import { NextResponse } from "next/server";
import { resolveCoachName } from "@/lib/class-coach";
import { memberCoachLabel, resolveSessionTeacher } from "@/lib/session-coach";
import { loadCovers, sessionHasStarted } from "@/lib/session-cover";
import { isAdultAccount } from "@/lib/account-type";
import { classTierCovers } from "@/lib/class-tier-gate";
import type { ScheduleEligibility } from "@/lib/member-home";
import { liveClassWhere } from "@/lib/class-live";
import { accessRefusals, accessRefusalSentence, highestRankOrder } from "@/lib/booking-eligibility";
import { clubWallClock, usableTimezone } from "@/lib/class-time";

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
  // YYYY-MM-DD, or "today" for the club's date in its own zone (the member's day view sends that, so a phone
  // in another time zone gets the club's today). Optional: without it no session is mapped.
  const dateParam = searchParams.get("date");

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json(DEMO_CLASSES);
  }

  const memberId = session.user.memberId;

  // Sessions must exist before they are listed: without the nightly cron the horizon lapses and no class carries a
  // classInstanceId, so nothing can be booked or checked into (lib/class-horizon.ts). Never throws.
  await ensureClassHorizon(session.user.tenantId);

  try {
    const { classes, instanceMap, coverCoach, coverDay, cancelledSlots, memberRanks, rosterClassIds, rosterCounts, viewerIsAdult, viewerTierId, viewerTierName, bookedClassIds, clubZone } = await withTenantContext(
      session.user.tenantId,
      async (tx) => {
        const cls = await tx.class.findMany({
          // RULES §5: `deletedAt` is a soft-delete column, so every reader has
          // to filter it. `isActive: false` is "paused"; `deletedAt` is
          // "removed" — a removed class reappearing on the member timetable is
          // the failure mode a soft-delete exists to prevent.
          // T6b: live classes only (liveClassWhere) — a paused or archived
          // class, or imported history, is not on the member timetable.
          where: liveClassWhere(session.user.tenantId),
          select: {
            id: true,
            name: true,
            color: true,
            coachName: true,
            coachUser: { select: { id: true, name: true } },
            location: true,
            // The mat the class runs on (null = none); the member's day draws a column per mat.
            matId: true,
            maxCapacity: true,
            isKids: true,
            // The legacy key, still returned for a member app holding an older page.
            category: true,
            // The club's category, shown by name on the member timetable.
            categoryRef: { select: { name: true } },
            requiredRank: { select: { id: true, name: true, discipline: true, order: true } },
            maxRank: { select: { id: true, name: true, discipline: true, order: true } },
            schedules: {
              where: { isActive: true },
              select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
            },
            // T6a: memberships that include the class ([] = everyone).
            allowedTiers: { select: { tierId: true } },
          },
        });

        const map = new Map<string, string>();
        // The coach a session's cover gives it, by `${classId}-${startTime}` on the requested day.
        const coverCoach = new Map<string, string | null>();
        let coverDay = -1;
        // A cancelled session on the requested day is reported as such so the
        // timetable can say "Cancelled" instead of drawing it like any other
        // class. It still carries NO classInstanceId: nothing may book or
        // check in against a cancelled instance (lf-1 J49, ld-1 J33).
        const cancelledSlots = new Set<string>();
        // The club's zone: the day view reads "today", live and next on the club's clock (X-Club-Zone below).
        const tenantRow = await tx.tenant.findUnique({ where: { id: session.user.tenantId }, select: { timezone: true } });
        const zone = usableTimezone(tenantRow?.timezone);
        let day = dateParam;
        if (day === "today") {
          const c = clubWallClock(new Date(), zone);
          day = `${c.year}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
        }
        if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
          const startOfDay = new Date(`${day}T00:00:00.000Z`);
          const endOfDay   = new Date(`${day}T23:59:59.999Z`);
          const instances  = await tx.classInstance.findMany({
            where: {
              class: { tenantId: session.user.tenantId },
              date: { gte: startOfDay, lte: endOfDay },
            },
            select: { id: true, classId: true, date: true, startTime: true, endTime: true, isCancelled: true },
          });
          for (const inst of instances) {
            const key = `${inst.classId}-${inst.startTime}`;
            if (inst.isCancelled) cancelledSlots.add(key);
            else map.set(key, inst.id);
          }
          // Session cover on this day's sessions: the confirmed covering coach, or "Coach to be confirmed" while
          // cover is open (lib/session-coach.ts). Only a display string reaches the member: no ids, no request.
          coverDay = startOfDay.getUTCDay();
          const live = instances.filter((i) => !i.isCancelled);
          const covers = await loadCovers(tx, session.user.tenantId, live.map((i) => i.id));
          const byId = new Map(cls.map((c) => [c.id, c]));
          const now = new Date();
          for (const inst of live) {
            const cover = covers.get(inst.id);
            const c = byId.get(inst.classId);
            if (!cover || !c) continue;
            coverCoach.set(`${inst.classId}-${inst.startTime}`, memberCoachLabel(resolveSessionTeacher(c, cover, { started: sessionHasStarted(inst, zone, now) })));
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
        const me = memberId
          ? await tx.member.findFirst({
              where: { id: memberId, tenantId: session.user.tenantId },
              select: { accountType: true, membershipTierId: true, membershipTier: { select: { name: true } } },
            })
          : null;
        // D2: the member's own bookings, so a booked class whose rules now
        // turn them away is shown — marked "not eligible" with the door's
        // sentence — rather than hidden or silently kept.
        const booked = memberId
          ? await tx.classSubscription.findMany({
              where: { memberId, class: { tenantId: session.user.tenantId } },
              select: { classId: true },
            })
          : [];

        // For each class, count whether it has ANY roster (i.e., is roster-only mode).
        const counts = await tx.classRoster.groupBy({
          by: ["classId"],
          where: { tenantId: session.user.tenantId, classId: { in: cls.map((c) => c.id) }, member: { archivedAt: null } },
          _count: { _all: true },
        });
        const countMap = new Map<string, number>(counts.map((c) => [c.classId, c._count._all]));

        return {
          classes: cls,
          instanceMap: map,
          coverCoach,
          coverDay,
          cancelledSlots,
          memberRanks: ranks,
          rosterClassIds: rosterIds,
          rosterCounts: countMap,
          viewerIsAdult: isAdultAccount(me?.accountType),
          viewerTierId: me?.membershipTierId ?? null,
          viewerTierName: me?.membershipTier?.name ?? null,
          bookedClassIds: new Set(booked.map((b) => b.classId)),
          clubZone: zone,
        };
      },
    );

    type Cls = typeof classes[number];
    type Sched = Cls["schedules"][number];

    const result = classes
      .flatMap((cls: Cls) => {
        const isRosterMode = (rosterCounts.get(cls.id) ?? 0) > 0;
        const memberOnRoster = rosterClassIds.has(cls.id);
        const isBooked = bookedClassIds.has(cls.id);

        // Roster-only class member is NOT on → server-side hide entirely —
        // unless they are booked on it (D2: a booking is kept when the squad
        // list drops them, and the member sees it marked "not eligible").
        if (isRosterMode && !memberOnRoster && !isBooked) return [];

        // D2: a booked class the door would now refuse this member, with the
        // door's own sentence (lib/booking-eligibility.ts: the door's rules —
        // rank on the highest rank of any discipline, the squad list, the
        // membership list). Null when admitted or not booked.
        const refusals = isBooked
          ? accessRefusals(
              {
                // Only this member's place on the list matters here: a list
                // that exists without them is spelled as one other entry.
                rosterMemberIds: !isRosterMode ? [] : memberOnRoster ? [memberId ?? ""] : ["(someone else)"],
                allowedTierIds: cls.allowedTiers.map((t) => t.tierId),
                requiredRankOrder: cls.requiredRank?.order ?? null,
                maxRankOrder: cls.maxRank?.order ?? null,
              },
              {
                memberId: memberId ?? "",
                membershipTierId: viewerTierId,
                tierName: viewerTierName,
                rankOrder: highestRankOrder(memberRanks.map((mr) => mr.rankSystem)),
              },
            )
          : [];
        const bookedIneligible = refusals.length > 0
          ? { reason: refusals[0], sentence: accessRefusalSentence(refusals[0], cls.name, viewerTierName) }
          : null;

        // Compute eligibility per class (constant across schedule entries).
        let eligibility: ScheduleEligibility = "ok";
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
        // T6a: the same rule the check-in engine and booking apply. Locked,
        // not hidden: the member sees the class and what to ask about. Being
        // on the roster does not lift it (both must hold, 20 Oct 2026).
        if (
          (eligibility === "ok" || eligibility === "roster_ok") &&
          !classTierCovers({
            allowedTierIds: cls.allowedTiers.map((t) => t.tierId),
            memberTierId: viewerTierId,
          })
        ) {
          eligibility = "tier_not_included";
        }

        return cls.schedules.map((sched: Sched) => ({
          id: `${cls.id}-${sched.id}`,
          classId: cls.id,
          scheduleId: sched.id,
          name: cls.name,
          color: cls.color,
          startTime: sched.startTime,
          endTime: sched.endTime,
          // The requested day's own session only (its weekday): another day's row of the same class keeps its coach.
          coach: (sched.dayOfWeek === coverDay && coverCoach.has(`${cls.id}-${sched.startTime}`) ? coverCoach.get(`${cls.id}-${sched.startTime}`) : resolveCoachName(cls)) ?? "TBC",
          location: cls.location ?? "",
          matId: cls.matId ?? null,
          capacity: cls.maxCapacity,
          // Shown as a small "Kids" tag on the member's timetable.
          isKids: cls.isKids,
          kidsClassForAdult: viewerIsAdult && cls.isKids === true,
          // The legacy key (an older page labels from it), and the name the club gives the category today.
          category: cls.category ?? null,
          categoryName: cls.categoryRef?.name ?? null,
          dayOfWeek: sched.dayOfWeek,
          classInstanceId: instanceMap.get(`${cls.id}-${sched.startTime}`) ?? null,
          cancelled: cancelledSlots.has(`${cls.id}-${sched.startTime}`),
          eligibility,
          requiredRankName: cls.requiredRank?.name ?? null,
          maxRankName: cls.maxRank?.name ?? null,
          // D2: set only on a booked class the door now refuses; the booking is kept.
          bookedIneligible,
        }));
      });

    return NextResponse.json(result, { headers: { "X-Club-Zone": clubZone } });
  } catch {
    if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);
    return NextResponse.json([]);
  }
}
