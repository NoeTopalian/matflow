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
  cover: { select: { status: true, coverUserId: true, needsReconfirm: true, coverUser: { select: { name: true } } } },
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

const DAY = 86_400_000;

/**
 * Every session of the club that could be one side of a clash in a date window: those an accepted cover is on, and
 * the regular sessions of the people covering them. A clash needs a cover, so a window with no covered session (the
 * usual case) costs ONE query and needs nothing else. Kept for the rest of the transaction (keyed by the transaction
 * object), so a page that asks for several lists of sessions near today — member home: the day, the children's
 * timetable, the next class — reads it once.
 */
const poolCache = new WeakMap<object, { tenantId: string; from: number; to: number; rows: ClashSession[] }>();

async function clubPool(tx: Tx, tenantId: string, dates: Date[]): Promise<ClashSession[]> {
  const markers = dates.map((d) => dayMarkerUtc(d).getTime());
  // The day before to the day after: an overnight session can reach into the next day.
  let from = Math.min(...markers) - DAY - DAY / 2;
  let to = Math.max(...markers) + DAY + DAY / 2;
  // Near today, one window serves every list the page shows.
  const today = dayMarkerUtc(new Date()).getTime();
  if (from >= today - 4 * DAY && to <= today + 18 * DAY) {
    from = today - 4 * DAY;
    to = today + 18 * DAY;
  }
  const hit = poolCache.get(tx);
  if (hit && hit.tenantId === tenantId && hit.from <= from && hit.to >= to) return hit.rows;
  const window = { isCancelled: false, date: { gte: new Date(from), lt: new Date(to) } };
  // One query: the covered sessions in the window, and the sessions whose regular coach covers a session in it.
  const rows = await tx.classInstance.findMany({
    where: {
      ...window,
      class: { tenantId, isActive: true, deletedAt: null },
      OR: [
        { cover: { is: { tenantId, status: "covered" } } },
        { class: { coachUser: { sessionCovers: { some: { tenantId, status: "covered", classInstance: { is: window } } } } } },
      ],
    },
    select: CLASH_SELECT,
  });
  poolCache.set(tx, { tenantId, from, to, rows });
  return rows;
}

/**
 * The clashes of these sessions (this club's; cancelled ones and other clubs' are ignored), by session id. One query
 * (clubPool, shared by the transaction) when no session near them is covered; otherwise one more for the sessions'
 * own rows. The club's zone is read only when it is not given and something could clash.
 */
export async function loadTeacherClashes(tx: Tx, tenantId: string, sessions: Array<{ id: string; date: Date }>, tz?: string | null): Promise<Map<string, TeacherClash>> {
  if (sessions.length === 0) return new Map();
  const pool = await clubPool(tx, tenantId, sessions.map((s) => s.date));
  if (pool.length === 0) return new Map();
  return clashesForShown(tx, tenantId, await loadClashSessions(tx, tenantId, sessions.map((s) => s.id)), tz);
}

/** These sessions of this club, not cancelled, of classes on the timetable, with class and cover row (one query). */
export async function loadClashSessions(tx: Tx, tenantId: string, instanceIds: string[]) {
  if (instanceIds.length === 0) return [];
  return tx.classInstance.findMany({
    where: { id: { in: [...new Set(instanceIds)] }, isCancelled: false, class: { tenantId, isActive: true, deletedAt: null } },
    select: CLASH_SELECT,
  });
}

/**
 * The same, for a page that has already read its sessions (this club's, as ClashSession: class and cover included):
 * only clubPool's query (two when a session near them is covered), and none when nobody teaches them.
 */
export async function clashesForShown(tx: Tx, tenantId: string, shown: ClashSession[], tz?: string | null): Promise<Map<string, TeacherClash>> {
  const live = shown.filter(onTimetable);
  if (!live.some((s) => teacherOf(s))) return new Map();
  const pool = await clubPool(tx, tenantId, live.map((s) => s.date));
  if (pool.length === 0) return new Map();
  const zone = tz ?? usableTimezone((await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }))?.timezone);
  return clashesAmong(shown, pool, zone);
}
