/**
 * One person shown teaching two overlapping sessions (session cover, round 4: review of 121529e4, should-fix 1 and 2).
 *
 * Noe's rule: nobody is shown teaching two overlapping sessions without a visible flag, where at least one of the two
 * is a cover. An overlap like that can arise in many ways — a deactivation reopens a cover and the session then starts
 * with its regular coach covering elsewhere, a weekly-slot move or end-time change, restoring a cancelled session, a
 * resume, an undo, a new class — so instead of one write-time check per way, every screen that names who teaches a
 * dated session asks this ONE read-time question for all the sessions it shows, in two queries.
 *
 * Who teaches a session here: its accepted cover coach (a covered row, awaiting reconfirmation or not); otherwise its
 * linked regular coach unless deactivated — an open request does not release them (Noe, 26 Nov 2026). A clash is two
 * sessions of the same club, not cancelled, of classes on the timetable, with the same teacher, whose times overlap
 * (one ending exactly as the other starts does not), at least one of them covered by that teacher. Two classes of the
 * same regular coach at once are not flagged: the class form allows that.
 *
 * Also the pure helpers that name a session and give its time range (moved here from lib/session-cover.ts, which
 * re-exports them). No server-only imports: lib/member-stats.ts, whose helpers client components import, uses it.
 */
import type { Prisma } from "@prisma/client";
import { dayMarkerUtc, formatTimeRange, sessionBounds, usableTimezone } from "@/lib/class-time";
import type { TeacherClash } from "@/lib/session-coach";

type Tx = Prisma.TransactionClient;

/** What naming a session and its time range read from it. */
type Timed = {
  date: Date;
  startTime: string;
  endTime: string | null;
  class: { duration?: number | null; location?: string | null; mat?: { name: string } | null };
};

/** "Thursday 3 December" — a session's club date (its `date` is a calendar-day marker, read in UTC). */
export function sessionDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(dayMarkerUtc(date));
}

/** The session's place: its mat, else the typed place. */
export function sessionPlace(s: Pick<Timed, "class">): string | null {
  return s.class.mat?.name ?? (s.class.location?.trim() || null);
}

/** "Thursday 3 December, 19:00–20:30, Mat 2" — how every cover message names a session. */
export function describeSession(s: Timed): string {
  const place = sessionPlace(s);
  return `${sessionDayLabel(s.date)}, ${formatTimeRange(s.startTime, s.endTime)}${place ? `, ${place}` : ""}`;
}

/** Start and end instants; a session with no recorded end lasts its class's duration (a moment when that is unknown too). */
export function boundsOf(s: Timed, tz: string): { start: number; end: number } {
  const b = sessionBounds(s, tz);
  const start = b.start.getTime();
  const end = b.end?.getTime() ?? start + (s.class.duration ?? 0) * 60_000;
  return { start, end: Math.max(end, start + 1) };
}

const CLASH_SELECT = {
  id: true,
  date: true,
  startTime: true,
  endTime: true,
  isCancelled: true,
  class: {
    select: {
      name: true,
      location: true,
      duration: true,
      isActive: true,
      deletedAt: true,
      coachUser: { select: { id: true, name: true, deactivatedAt: true } },
      mat: { select: { name: true } },
    },
  },
  cover: { select: { status: true, coverUserId: true, coverUser: { select: { name: true } } } },
} satisfies Prisma.ClassInstanceSelect;

/** A session as the clash check reads it. */
export type ClashSession = Timed & {
  id: string;
  isCancelled: boolean;
  class: Timed["class"] & {
    name: string;
    isActive: boolean;
    deletedAt: Date | null;
    coachUser: { id: string; name: string; deactivatedAt: Date | null } | null;
  };
  cover: { status: string; coverUserId: string | null; coverUser: { name: string } | null } | null;
};

/** Who teaches the session for this check, and whether as its accepted cover; null when nobody does. */
export function teacherOf(s: ClashSession): { userId: string; name: string; isCover: boolean } | null {
  if (s.cover?.status === "covered" && s.cover.coverUserId) {
    return { userId: s.cover.coverUserId, name: s.cover.coverUser?.name ?? "A former staff member", isCover: true };
  }
  const u = s.class.coachUser;
  return u && !u.deactivatedAt ? { userId: u.id, name: u.name, isCover: false } : null;
}

const onTimetable = (s: ClashSession) => !s.isCancelled && s.class.isActive && !s.class.deletedAt;

/**
 * For each of `shown`, the first session of `pool` (by start) that clashes with it, by session id. Pure: the caller
 * passes every session that could clash (loadTeacherClashes reads them).
 */
export function clashesAmong(shown: ClashSession[], pool: ClashSession[], tz: string): Map<string, TeacherClash> {
  const out = new Map<string, TeacherClash>();
  const others = pool.filter(onTimetable).map((o) => ({ o, t: teacherOf(o), b: boundsOf(o, tz) })).sort((x, y) => x.b.start - y.b.start);
  for (const s of shown) {
    if (!onTimetable(s)) continue;
    const me = teacherOf(s);
    if (!me) continue;
    const mine = boundsOf(s, tz);
    const hit = others.find(({ o, t, b }) =>
      o.id !== s.id && !!t && t.userId === me.userId && (me.isCover || t.isCover) && b.start < mine.end && mine.start < b.end);
    if (!hit) continue;
    out.set(s.id, {
      side: me.isCover ? "cover" : "regular",
      teacherName: me.name,
      otherIsCover: hit.t!.isCover,
      instanceId: hit.o.id,
      className: hit.o.class.name,
      label: describeSession(hit.o),
    });
  }
  return out;
}

/**
 * The clashes of these sessions (this club's; cancelled ones and other clubs' are ignored), by session id. Two
 * queries: the sessions themselves, then — only when one of them has a teacher — the club's other sessions within a
 * day and a half that could clash: those covered by one of their teachers, and those whose regular coach is the cover
 * coach of one of them. The club's zone is read only when it is not given and something could clash.
 */
export async function loadTeacherClashes(tx: Tx, tenantId: string, instanceIds: string[], tz?: string | null): Promise<Map<string, TeacherClash>> {
  if (instanceIds.length === 0) return new Map();
  const live = { tenantId, isActive: true, deletedAt: null };
  const shown = await tx.classInstance.findMany({
    where: { id: { in: [...new Set(instanceIds)] }, isCancelled: false, class: live },
    select: CLASH_SELECT,
  });
  const teachers = new Set<string>();
  const coverCoaches = new Set<string>();
  for (const s of shown) {
    const t = teacherOf(s);
    if (!t) continue;
    teachers.add(t.userId);
    if (t.isCover) coverCoaches.add(t.userId);
  }
  if (teachers.size === 0) return new Map();
  const markers = shown.map((s) => dayMarkerUtc(s.date).getTime());
  const DAY = 86_400_000;
  const pool = await tx.classInstance.findMany({
    where: {
      isCancelled: false,
      // The day before to the day after: an overnight session can reach into the next day.
      date: { gte: new Date(Math.min(...markers) - DAY - DAY / 2), lt: new Date(Math.max(...markers) + DAY + DAY / 2) },
      class: live,
      OR: [
        { cover: { is: { tenantId, status: "covered", coverUserId: { in: [...teachers] } } } },
        ...(coverCoaches.size > 0 ? [{ class: { coachUserId: { in: [...coverCoaches] } } }] : []),
      ],
    },
    select: CLASH_SELECT,
  });
  if (pool.length === 0) return new Map();
  const zone = tz ?? usableTimezone((await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }))?.timezone);
  return clashesAmong(shown, pool, zone);
}
