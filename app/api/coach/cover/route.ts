/**
 * GET /api/coach/cover?from=YYYY-MM-DD&days=7 — session cover, staff side (Noe, 26 Nov 2026).
 *
 *  - sessions:     every session of the club's live classes in the days asked for (the club's dates), each with who
 *                  teaches it (lib/session-coach.ts, the one resolver) and what the signed-in person may do to it;
 *  - openRequests: every session still needing cover that has not started, whatever the dates asked for — past
 *                  sessions are never listed as open requests;
 *  - mine:         the sessions the signed-in person is covering that have not started;
 *  - staff:        for the owner or a manager, the people who may be assigned (the class form's coach list).
 *
 * Every staff role may read it (every staff role may be asked to cover). Members never reach it.
 */
import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { apiError } from "@/lib/api-error";
import { usableTimezone } from "@/lib/class-time";
import { liveClassWhere } from "@/lib/class-live";
import { clubDayKey, parseDayKey, shiftDayKey } from "@/lib/club-month";
import { clashLabel, resolveSessionTeacher, staffCoachLabel, type CoverSessionView, type CoverSnapshot, type TeacherClash } from "@/lib/session-coach";
import { clashesForShown } from "@/lib/session-clash";
import {
  COVER_SESSION_SELECT,
  COVER_STAFF_ROLES,
  loadCovers,
  sessionDayKey,
  sessionDayLabel,
  sessionHasStarted,
  sessionPlace,
  sessionWeekday,
  type CoverSession,
} from "@/lib/session-cover";

const HALF_DAY = 12 * 60 * 60 * 1000;
const keyMidnight = (key: string) => Date.parse(`${key}T00:00:00Z`);

function view(s: CoverSession, cover: CoverSnapshot | undefined, tz: string, now: Date, me: { userId: string; role: string }, clash?: TeacherClash): CoverSessionView {
  const started = sessionHasStarted(s, tz, now);
  const t = resolveSessionTeacher(s.class, cover, { started, clash });
  const om = me.role === "owner" || me.role === "manager";
  const live = !started && !s.isCancelled;
  const active = !started && (t.state === "cover_needed" || t.state === "covered");
  const regularIsMe = !!s.class.coachUserId && s.class.coachUserId === me.userId;
  const coverIsMe = t.state === "covered" && t.teacherUserId === me.userId;
  return {
    id: s.id,
    classId: s.class.id,
    className: s.class.name,
    dayKey: sessionDayKey(s.date),
    dayLabel: sessionDayLabel(s.date),
    weekday: sessionWeekday(s.date),
    startTime: s.startTime,
    endTime: s.endTime,
    place: sessionPlace(s),
    isCancelled: s.isCancelled,
    started,
    regularCoachName: t.regularName,
    regularIsMe,
    state: t.state,
    coverUserId: t.state === "covered" ? t.teacherUserId : null,
    coverUserName: t.state === "covered" ? t.teacherName : null,
    needsReconfirm: t.needsReconfirm,
    coachLabel: staffCoachLabel(t),
    clashLabel: clashLabel(t),
    can: {
      request: live && t.state === "regular" && (om || regularIsMe),
      claim: live && t.state === "cover_needed",
      assign: live && om && t.state !== "covered",
      replace: live && om && t.state === "covered",
      giveUp: live && coverIsMe,
      withdraw: live && om && active,
      returnToRegular: live && om && active && !!t.regularName,
      reconfirm: live && coverIsMe && t.needsReconfirm,
    },
  };
}

export async function GET(req: Request) {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId, role } = gate;
  const url = new URL(req.url);

  try {
    const data = await withTenantContext(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      const tz = usableTimezone(tenant?.timezone);
      const now = new Date();
      const today = clubDayKey(now, tz);
      const from = parseDayKey(url.searchParams.get("from")) ?? today;
      const daysRaw = Number(url.searchParams.get("days") ?? 7);
      const days = Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 14 ? daysRaw : 7;
      const start = new Date(keyMidnight(from) - HALF_DAY);
      const end = new Date(keyMidnight(shiftDayKey(from, days)) - HALF_DAY);
      const fromToday = new Date(keyMidnight(today) - HALF_DAY);

      const [ranged, open, mine] = await Promise.all([
        tx.classInstance.findMany({
          where: { class: liveClassWhere(tenantId), sourceImportJobId: null, date: { gte: start, lt: end } },
          select: COVER_SESSION_SELECT,
          orderBy: [{ date: "asc" }, { startTime: "asc" }, { id: "asc" }],
        }),
        tx.sessionCover.findMany({
          where: { tenantId, status: "open", classInstance: { is: { isCancelled: false, sourceImportJobId: null, date: { gte: fromToday }, class: liveClassWhere(tenantId) } } },
          select: { classInstance: { select: COVER_SESSION_SELECT } },
        }),
        tx.sessionCover.findMany({
          where: { tenantId, status: "covered", coverUserId: userId, classInstance: { is: { isCancelled: false, sourceImportJobId: null, date: { gte: fromToday }, class: liveClassWhere(tenantId) } } },
          select: { classInstance: { select: COVER_SESSION_SELECT } },
        }),
      ]);
      const extra = [...open, ...mine].map((r) => r.classInstance).filter((s): s is CoverSession => !!s);
      const shownIds = [...new Set([...ranged.map((s) => s.id), ...extra.map((s) => s.id)])];
      const covers = await loadCovers(tx, tenantId, shownIds);
      // One person shown on two overlapping sessions, one of them a cover: flagged on both (lib/session-clash.ts). One
      // query: the sessions and their covers are already read.
      const shown = [...new Map([...ranged, ...extra].map((s) => [s.id, s])).values()].map((s) => {
        const c = covers.get(s.id);
        return { ...s, cover: c ? { status: c.status, coverUserId: c.coverUserId, coverUser: c.coverUserName ? { name: c.coverUserName } : null } : null };
      });
      const clashes = await clashesForShown(tx, tenantId, shown, tz);
      const me = { userId, role };
      const v = (s: CoverSession) => view(s, covers.get(s.id), tz, now, me, clashes.get(s.id));
      const byTime = (a: CoverSessionView, b: CoverSessionView) => a.dayKey.localeCompare(b.dayKey) || a.startTime.localeCompare(b.startTime) || a.className.localeCompare(b.className);
      const openViews = open.flatMap((r) => (r.classInstance ? [v(r.classInstance)] : [])).filter((x) => x.state === "cover_needed").sort(byTime);
      const mineViews = mine.flatMap((r) => (r.classInstance ? [v(r.classInstance)] : [])).filter((x) => !x.started).sort(byTime);
      const staff =
        role === "owner" || role === "manager"
          ? await tx.user.findMany({
              where: { tenantId, deactivatedAt: null, role: { in: [...COVER_STAFF_ROLES] } },
              select: { id: true, name: true, role: true },
              orderBy: [{ role: "asc" }, { name: "asc" }],
            })
          : [];
      return {
        today,
        from,
        days,
        timeZone: tz,
        me: { id: userId, role },
        sessions: ranged.map(v),
        openRequests: openViews,
        mine: mineViews,
        staff,
      };
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return apiError("Couldn't load class cover", 500, e, "coach/cover/GET", { req, tenantId, userId });
  }
}
