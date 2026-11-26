/**
 * Session cover (Noe, 26 Nov 2026): asking for cover on ONE dated session, taking it, assigning it, and what
 * happens to it when the session is cancelled, re-timed or removed.
 *
 * The cover lives on SessionCover, one row per ClassInstance. It never touches the class's regular coach
 * (Class.coachUserId / coachName): the weekly class keeps its coach, and next week is untouched.
 *
 * Eligible to cover (claim, or be assigned): exactly the rule the class form already applies to a class's coach
 * (lib/class-refs.ts) — a user of the same club who is not deactivated — narrowed to the staff roles the form lists
 * (owner, manager, coach, admin). There is no belt, rank, category, location or qualification rule for coaches in
 * MatFlow, and none is invented here.
 *
 * Two rules the server enforces under concurrency:
 *  1. First valid claim wins: the claim is a conditional update of the row WHERE status = 'open'; of two
 *     simultaneous claims Postgres lets exactly one match (count 1), and the other reads who has it.
 *  2. Nobody teaches two sessions at once: before a claim, an assignment, a replacement or a reconfirmation, the
 *     coach's other sessions that day are read under a per-club-per-coach advisory lock (lockCoachCover, the FIRST
 *     statement of the transaction — docs/design/LOCK-ORDER-2026-10-24.md level 1), so two overlapping claims by the
 *     same coach are serial and the second sees the first. Who teaches a session (Noe's correction, 26 Nov 2026):
 *     its accepted cover coach, otherwise its linked regular coach — an open request does not release the regular
 *     coach. Sessions that only meet end to start do not overlap. Giving up, withdrawing or returning a cover that
 *     would put the regular coach back on two overlapping sessions is refused by name (under that coach's lock).
 *
 * Attendance is not touched: every staff role still marks any register (Noe, 17 Sep 2026). Cover only changes who
 * is shown as teaching and whose "Yours" highlight the session carries.
 */
import { Prisma } from "@prisma/client";
import { dayMarkerUtc, formatTimeRange, sessionBounds, usableTimezone } from "@/lib/class-time";
import { logAuditStrict } from "@/lib/audit-log";
import { memberCoachLabel, resolveSessionTeacher, type CoverSnapshot } from "@/lib/session-coach";

type Tx = Prisma.TransactionClient;

/** Advisory-lock namespace for cover: "COVR". */
export const COVER_LOCK_NS = 0x434f5652;

/** The staff roles (lib/authz.ts STAFF_ROLES), the roles the class form offers as a class's coach. */
export const COVER_STAFF_ROLES = ["owner", "manager", "coach", "admin"] as const;

export const COVER_ACTIONS = ["request", "claim", "assign", "replace", "give_up", "withdraw", "return", "reconfirm"] as const;
export type CoverActionName = (typeof COVER_ACTIONS)[number];

/** A cover row that still decides who teaches. */
const ACTIVE = ["open", "covered"];

/**
 * Serialises every cover write that puts ONE coach on a session (claim, assign, replace, reconfirm) for that coach
 * in that club, so the overlap check below cannot interleave with another of the same coach's. Held until the
 * transaction ends. The first statement of the transaction; both keys are bind parameters
 * (tests/unit/sec-c-static-guards.test.ts).
 */
export async function lockCoachCover(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${COVER_LOCK_NS}::int4, hashtext(${`${tenantId}:${userId}`}))`;
}

const SESSION_SELECT = {
  id: true,
  date: true,
  startTime: true,
  endTime: true,
  isCancelled: true,
  class: {
    select: {
      id: true,
      name: true,
      coachUserId: true,
      coachName: true,
      location: true,
      duration: true,
      isActive: true,
      deletedAt: true,
      sourceImportJobId: true,
      coachUser: { select: { id: true, name: true } },
      mat: { select: { name: true } },
    },
  },
} satisfies Prisma.ClassInstanceSelect;

export type CoverSession = Prisma.ClassInstanceGetPayload<{ select: typeof SESSION_SELECT }>;
export const COVER_SESSION_SELECT = SESSION_SELECT;

/** "Thursday 3 December" — a session's club date (its `date` is a calendar-day marker, read in UTC). */
export function sessionDayLabel(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(dayMarkerUtc(date));
}

/** "Thursday" — the weekday of a session's club date. */
export function sessionWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(dayMarkerUtc(date));
}

/** "2026-12-03" — a session's club date as a key. */
export function sessionDayKey(date: Date): string {
  return dayMarkerUtc(date).toISOString().slice(0, 10);
}

/** The session's place: its mat, else the typed place. */
export function sessionPlace(s: Pick<CoverSession, "class">): string | null {
  return s.class.mat?.name ?? (s.class.location?.trim() || null);
}

/** "Thursday 3 December, 19:00–20:30, Mat 2" — how every cover message names a session. */
export function describeSession(s: Pick<CoverSession, "date" | "startTime" | "endTime" | "class">): string {
  const place = sessionPlace(s);
  return `${sessionDayLabel(s.date)}, ${formatTimeRange(s.startTime, s.endTime)}${place ? `, ${place}` : ""}`;
}

/** Start and end instants; a session with no recorded end lasts its class's duration (a moment when that is unknown too). */
function boundsOf(s: Pick<CoverSession, "date" | "startTime" | "endTime" | "class">, tz: string): { start: number; end: number } {
  const b = sessionBounds(s, tz);
  const start = b.start.getTime();
  const end = b.end?.getTime() ?? start + (s.class.duration ?? 0) * 60_000;
  return { start, end: Math.max(end, start + 1) };
}

export function sessionHasStarted(s: Pick<CoverSession, "date" | "startTime" | "endTime">, tz: string, now: Date = new Date()): boolean {
  return sessionBounds(s, tz).start.getTime() <= now.getTime();
}

export type CoverConflict = { instanceId: string; className: string; label: string };

/**
 * The first other session the coach is already teaching whose time overlaps `target`: one of their own classes
 * (Class.coachUserId) or a session they cover, not cancelled, of a class on the timetable. Their own class's
 * session that someone else has accepted cover for does not count — they are not teaching it. Club-day arithmetic
 * is sessionBounds' (the club's wall clock; an end at or before the start runs into the next day).
 */
export async function findCoverOverlap(
  tx: Tx,
  tenantId: string,
  tz: string,
  coachUserId: string,
  target: CoverSession,
): Promise<CoverConflict | null> {
  const mine = boundsOf(target, tz);
  const marker = dayMarkerUtc(target.date).getTime();
  const DAY = 86_400_000;
  const candidates = await tx.classInstance.findMany({
    where: {
      id: { not: target.id },
      isCancelled: false,
      // The day before to the day after: an overnight session can reach into the target's day.
      date: { gte: new Date(marker - DAY - DAY / 2), lt: new Date(marker + DAY + DAY / 2) },
      class: { tenantId, isActive: true, deletedAt: null },
      OR: [{ class: { coachUserId } }, { cover: { is: { tenantId, status: "covered", coverUserId: coachUserId } } }],
    },
    select: { ...SESSION_SELECT, cover: { select: { status: true, coverUserId: true } } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  for (const c of candidates) {
    if (c.cover?.status === "covered" && c.cover.coverUserId !== coachUserId) continue;
    const theirs = boundsOf(c, tz);
    if (theirs.start < mine.end && mine.start < theirs.end) {
      return { instanceId: c.id, className: c.class.name, label: describeSession(c) };
    }
  }
  return null;
}

/** The active cover rows (open or covered) of these sessions, by session id, as the resolver takes them. */
export async function loadCovers(tx: Tx, tenantId: string, instanceIds: string[]): Promise<Map<string, CoverSnapshot>> {
  const out = new Map<string, CoverSnapshot>();
  if (instanceIds.length === 0) return out;
  const rows = await tx.sessionCover.findMany({
    where: { tenantId, classInstanceId: { in: instanceIds }, status: { in: ACTIVE } },
    select: { classInstanceId: true, status: true, coverUserId: true, needsReconfirm: true, coverUser: { select: { name: true } } },
  });
  for (const r of rows) {
    if (!r.classInstanceId) continue;
    out.set(r.classInstanceId, { status: r.status, coverUserId: r.coverUserId, coverUserName: r.coverUser?.name ?? null, needsReconfirm: r.needsReconfirm });
  }
  return out;
}

/**
 * For member screens that list dated sessions: the coach label a session's ACTIVE cover gives it ("Coach to be
 * confirmed", or the confirmed covering coach), by session id. A session with no active cover is not in the map,
 * so the screen keeps the coach it already showed.
 */
export async function memberCoverLabels(
  tx: Tx,
  tenantId: string,
  sessions: Array<{ id: string; date: Date; startTime: string; endTime: string | null; isCancelled?: boolean; class: { coachName: string | null; coachUser?: { id: string; name: string } | null; coachUserId?: string | null } }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const live = sessions.filter((s) => !s.isCancelled);
  const covers = await loadCovers(tx, tenantId, live.map((s) => s.id));
  if (covers.size === 0) return out;
  const club = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const tz = usableTimezone(club?.timezone);
  const now = new Date();
  for (const s of live) {
    const cover = covers.get(s.id);
    if (!cover) continue;
    out.set(s.id, memberCoachLabel(resolveSessionTeacher(s.class, cover, { started: sessionHasStarted(s, tz, now) })));
  }
  return out;
}

/** What every audit row of a cover action records about the session: enough to name it after it is gone. */
function sessionMeta(s: Pick<CoverSession, "date" | "startTime" | "endTime" | "class">) {
  return { classId: s.class.id, date: s.date.toISOString(), startTime: s.startTime, endTime: s.endTime };
}

export type CoverActor = { tenantId: string; userId: string; role: string };
export type CoverInput =
  | { action: "request" | "claim" | "give_up" | "withdraw" | "return" | "reconfirm" }
  | { action: "assign" | "replace"; coachUserId: string };

export type CoverView = { status: string; coverUserId: string | null; coverUserName: string | null; needsReconfirm: boolean } | null;

export type CoverOutcome =
  | { ok: true; changed: boolean; cover: CoverView; session: string }
  | { ok: false; status: 400 | 403 | 404 | 409; code: string; error: string; conflict?: CoverConflict };

const refuse = (status: 400 | 403 | 404 | 409, code: string, error: string, conflict?: CoverConflict): CoverOutcome => ({ ok: false, status, code, error, ...(conflict ? { conflict } : {}) });

const isOwnerOrManager = (role: string) => role === "owner" || role === "manager";

/** A member of staff of this club who may cover: the class form's coach rule (same club, not deactivated, a staff role). */
async function eligibleStaff(tx: Tx, tenantId: string, userId: string): Promise<{ id: string; name: string } | null> {
  return tx.user.findFirst({
    where: { id: userId, tenantId, deactivatedAt: null, role: { in: [...COVER_STAFF_ROLES] } },
    select: { id: true, name: true },
  });
}

/**
 * One cover action on one dated session, inside the caller's tenant transaction. Proves the session is this
 * club's before anything else is read or written; every write is a conditional update on the state that was read,
 * so a concurrent change answers "changed" instead of being overwritten; every change writes its Activity row in
 * the same transaction (logAuditStrict).
 */
export async function applyCoverAction(tx: Tx, actor: CoverActor, instanceId: string, input: CoverInput, now: Date = new Date()): Promise<CoverOutcome> {
  const { tenantId, userId, role } = actor;
  const om = isOwnerOrManager(role);

  // Level 1 first: the advisory lock of the coach this action would put on the session.
  const lockFor =
    input.action === "claim" || input.action === "reconfirm" ? userId : input.action === "assign" || input.action === "replace" ? input.coachUserId : null;
  if (lockFor) await lockCoachCover(tx, tenantId, lockFor);

  // Ownership before disclosure: a session of another club is a bare 404.
  const session = await tx.classInstance.findFirst({ where: { id: instanceId, class: { tenantId } }, select: SESSION_SELECT });
  if (!session) return refuse(404, "NOT_FOUND", "Not found");
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const tz = usableTimezone(tenant?.timezone);
  const label = describeSession(session);

  if (!session.class.isActive || session.class.deletedAt || session.class.sourceImportJobId) {
    return refuse(409, "CLASS_NOT_LIVE", "This class is not on the timetable, so its cover cannot change.");
  }
  if (session.isCancelled) return refuse(409, "SESSION_CANCELLED", "This session is cancelled, so its cover cannot change.");
  if (sessionHasStarted(session, tz, now)) return refuse(409, "SESSION_STARTED", "This session has already started, so its cover can no longer change.");

  const row = await tx.sessionCover.findFirst({
    where: { tenantId, classInstanceId: instanceId },
    select: { id: true, status: true, coverUserId: true, needsReconfirm: true, coverUser: { select: { name: true } } },
  });
  const coveredBy = () => `Already covered by ${row?.coverUser?.name ?? "another coach"}.`;
  const changedNow = () => refuse(409, "CHANGED", "This session's cover has just changed. Reload to see it.");
  const audit = (action: string, extra: Record<string, unknown> = {}) =>
    logAuditStrict(tx, { tenantId, userId, action, entityType: "ClassInstance", entityId: instanceId, metadata: { ...sessionMeta(session), ...extra } });
  const done = async (changed: boolean): Promise<CoverOutcome> => {
    const after = await tx.sessionCover.findFirst({
      where: { tenantId, classInstanceId: instanceId },
      select: { status: true, coverUserId: true, needsReconfirm: true, coverUser: { select: { name: true } } },
    });
    const cover = after && ACTIVE.includes(after.status)
      ? { status: after.status, coverUserId: after.coverUserId, coverUserName: after.coverUser?.name ?? null, needsReconfirm: after.needsReconfirm }
      : null;
    return { ok: true, changed, cover, session: label };
  };
  /** Refuses with the session the coach is already teaching, if there is one. */
  const overlap = async (coach: { id: string; name: string }): Promise<CoverOutcome | null> => {
    const clash = await findCoverOverlap(tx, tenantId, tz, coach.id, session);
    if (!clash) return null;
    const who = coach.id === userId ? "You're" : `${coach.name} is`;
    return refuse(409, "OVERLAP", `${who} already teaching ${clash.className} on ${clash.label}.`, clash);
  };

  /**
   * Taking a covered session off its covering coach (give up, withdraw, return) makes the class's linked regular
   * coach its teacher again — an open request does not release them. If that coach is meanwhile teaching an
   * overlapping session (their own, or one they now cover), it is refused by name rather than leaving one person on
   * two sessions at once. Under the regular coach's advisory lock, so it cannot interleave with their own claim.
   */
  const regularBusy = async (what: string): Promise<CoverOutcome | null> => {
    const regularId = session.class.coachUserId;
    if (row?.status !== "covered" || !regularId || regularId === row.coverUserId) return null;
    await lockCoachCover(tx, tenantId, regularId);
    const clash = await findCoverOverlap(tx, tenantId, tz, regularId, session);
    if (!clash) return null;
    const regularName = session.class.coachUser?.name ?? "The regular coach";
    return refuse(409, "REGULAR_COACH_BUSY", `${what} would put ${regularName} back on this class while they teach ${clash.className} on ${clash.label}. Choose another coach with Replace, or change that session first.`, clash);
  };

  switch (input.action) {
    case "request": {
      if (!om && !(session.class.coachUserId && session.class.coachUserId === userId)) {
        return refuse(403, "FORBIDDEN", "Only the owner, a manager or this class's own coach can ask for cover.");
      }
      if (row?.status === "open") return refuse(409, "ALREADY_REQUESTED", "Cover has already been requested for this session.");
      if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy());
      if (row) {
        const n = await tx.sessionCover.updateMany({
          where: { id: row.id, tenantId, status: row.status },
          data: { status: "open", coverUserId: null, requestedById: userId, needsReconfirm: false, closedReason: null },
        });
        if (n.count !== 1) return changedNow();
      } else {
        try {
          await tx.sessionCover.create({ data: { tenantId, classInstanceId: instanceId, status: "open", requestedById: userId } });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return refuse(409, "ALREADY_REQUESTED", "Cover has already been requested for this session.");
          throw e;
        }
      }
      await audit("class.cover_requested");
      return done(true);
    }

    case "claim": {
      const me = await eligibleStaff(tx, tenantId, userId);
      if (!me) return refuse(403, "NOT_ELIGIBLE", "Only a member of this club's staff can cover a class.");
      if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy());
      if (row?.status !== "open") return refuse(409, "NOT_OPEN", "This class no longer needs cover.");
      const clash = await overlap(me);
      if (clash) return clash;
      const n = await tx.sessionCover.updateMany({
        where: { id: row.id, tenantId, status: "open" },
        data: { status: "covered", coverUserId: userId, needsReconfirm: false },
      });
      if (n.count !== 1) {
        // Someone else's claim committed first: say who has it.
        const now2 = await tx.sessionCover.findFirst({ where: { id: row.id, tenantId }, select: { status: true, coverUser: { select: { name: true } } } });
        if (now2?.status === "covered") return refuse(409, "ALREADY_COVERED", `Already covered by ${now2.coverUser?.name ?? "another coach"}.`);
        return refuse(409, "NOT_OPEN", "This class no longer needs cover.");
      }
      await audit("class.cover_claimed", { coverUserId: userId });
      return done(true);
    }

    case "assign":
    case "replace": {
      if (!om) return refuse(403, "FORBIDDEN", "Only the owner or a manager can choose who covers a class.");
      const coach = await eligibleStaff(tx, tenantId, input.coachUserId);
      if (!coach) return refuse(400, "NOT_ELIGIBLE", "Choose a member of staff from the list.");
      if (input.action === "assign") {
        if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy());
      } else {
        if (row?.status !== "covered") return refuse(409, "NOT_COVERED", "This session is not covered at the moment.");
        if (row.coverUserId === coach.id) return done(false);
      }
      const clash = await overlap(coach);
      if (clash) return clash;
      if (input.action === "replace" && row) {
        const n = await tx.sessionCover.updateMany({
          where: { id: row.id, tenantId, status: "covered", coverUserId: row.coverUserId },
          data: { coverUserId: coach.id, needsReconfirm: false },
        });
        if (n.count !== 1) return changedNow();
        await audit("class.cover_replaced", { coverUserId: coach.id, previousCoverUserId: row.coverUserId });
        return done(true);
      }
      if (row) {
        const n = await tx.sessionCover.updateMany({
          where: { id: row.id, tenantId, status: row.status },
          data: {
            status: "covered",
            coverUserId: coach.id,
            needsReconfirm: false,
            closedReason: null,
            // An open request keeps who asked for it; an ended one is asked for again by whoever assigns it now.
            ...(row.status === "open" ? {} : { requestedById: userId }),
          },
        });
        if (n.count !== 1) return changedNow();
      } else {
        try {
          await tx.sessionCover.create({ data: { tenantId, classInstanceId: instanceId, status: "covered", coverUserId: coach.id, requestedById: userId } });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return changedNow();
          throw e;
        }
      }
      await audit("class.cover_assigned", { coverUserId: coach.id });
      return done(true);
    }

    case "give_up": {
      if (row?.status !== "covered") return refuse(409, "NOT_COVERED", "This session is not covered at the moment.");
      if (row.coverUserId !== userId && !om) return refuse(403, "FORBIDDEN", "Only the coach covering this class, the owner or a manager can give it up.");
      const busy = await regularBusy("Giving up this cover");
      if (busy) return busy;
      const n = await tx.sessionCover.updateMany({
        where: { id: row.id, tenantId, status: "covered", coverUserId: row.coverUserId },
        data: { status: "open", coverUserId: null, needsReconfirm: false },
      });
      if (n.count !== 1) return changedNow();
      await audit("class.cover_given_up", { previousCoverUserId: row.coverUserId });
      return done(true);
    }

    case "withdraw":
    case "return": {
      if (!om) return refuse(403, "FORBIDDEN", "Only the owner or a manager can change this.");
      if (!row || !ACTIVE.includes(row.status)) return refuse(409, "NOT_ACTIVE", "This session has no cover request.");
      const returning = input.action === "return";
      if (returning && !session.class.coachUserId && !session.class.coachName?.trim()) {
        return refuse(409, "NO_REGULAR_COACH", "This class has no regular coach. Withdraw the request instead.");
      }
      const busy = await regularBusy(returning ? "Returning this session to its regular coach" : "Withdrawing this cover");
      if (busy) return busy;
      const n = await tx.sessionCover.updateMany({
        where: { id: row.id, tenantId, status: row.status, coverUserId: row.coverUserId },
        data: returning
          ? { status: "closed", closedReason: "returned_to_regular", coverUserId: null, needsReconfirm: false }
          : { status: "withdrawn", closedReason: null, coverUserId: null, needsReconfirm: false },
      });
      if (n.count !== 1) return changedNow();
      await audit(returning ? "class.cover_returned_to_regular" : "class.cover_withdrawn", row.coverUserId ? { previousCoverUserId: row.coverUserId } : {});
      return done(true);
    }

    case "reconfirm": {
      if (row?.status !== "covered" || !row.needsReconfirm) return refuse(409, "NOTHING_TO_RECONFIRM", "There is nothing to reconfirm for this session.");
      if (row.coverUserId !== userId) return refuse(403, "FORBIDDEN", "Only the coach covering this class can reconfirm it.");
      const clash = await overlap({ id: userId, name: row.coverUser?.name ?? "" });
      if (clash) return clash;
      const n = await tx.sessionCover.updateMany({
        where: { id: row.id, tenantId, status: "covered", coverUserId: userId, needsReconfirm: true },
        data: { needsReconfirm: false },
      });
      if (n.count !== 1) return changedNow();
      await audit("class.cover_reconfirmed", { coverUserId: userId });
      return done(true);
    }
  }
}

// ── What the writers that cancel, re-time or remove sessions do to their cover ────────────────────────────────────

/**
 * Cancelling a session closes its cover (reason session_cancelled) in the cancel's own transaction. Restoring the
 * session does NOT reopen it: no coach is silently recommitted; the owner may ask for cover again.
 */
export async function closeCoverOnCancel(tx: Tx, tenantId: string, actorId: string, session: Pick<CoverSession, "date" | "startTime" | "endTime"> & { id: string; classId: string }): Promise<void> {
  const row = await tx.sessionCover.findFirst({
    where: { tenantId, classInstanceId: session.id, status: { in: ACTIVE } },
    select: { id: true, status: true, coverUserId: true },
  });
  if (!row) return;
  await tx.sessionCover.updateMany({
    where: { id: row.id, tenantId, status: row.status },
    data: { status: "closed", closedReason: "session_cancelled", coverUserId: null, needsReconfirm: false },
  });
  await logAuditStrict(tx, {
    tenantId,
    userId: actorId,
    action: "class.cover_closed",
    entityType: "ClassInstance",
    entityId: session.id,
    metadata: {
      classId: session.classId, date: session.date.toISOString(), startTime: session.startTime, endTime: session.endTime,
      closedReason: "session_cancelled", ...(row.coverUserId ? { previousCoverUserId: row.coverUserId } : {}),
    },
  });
}

/**
 * How a weekly-slot edit changed one weekday of a class: the one old start time that became one new start time
 * (`moves`), or a weekday whose slots changed in a way that does not pair one old slot with one new one
 * (`ambiguousDays`) — Noe's correction of 26 Nov 2026: same date is not same session.
 */
export type SlotMoves = { moves: Map<number, { from: string; to: string }>; ambiguousDays: Set<number> };

/** Pairs the removed and added slots of a weekly-slot edit, weekday by weekday (0 = Sunday, as ClassSchedule). */
export function slotMovesOf(removed: Array<{ dayOfWeek: number; startTime: string }>, added: Array<{ dayOfWeek: number; startTime: string }>): SlotMoves {
  const moves = new Map<number, { from: string; to: string }>();
  const ambiguousDays = new Set<number>();
  for (let d = 0; d < 7; d++) {
    const r = removed.filter((x) => x.dayOfWeek === d);
    const a = added.filter((x) => x.dayOfWeek === d);
    if (r.length === 1 && a.length === 1) moves.set(d, { from: r[0].startTime, to: a[0].startTime });
    else if (r.length > 0 && a.length > 0) ambiguousDays.add(d);
  }
  return { moves, ambiguousDays };
}

export type CoverMoveReport = { moved: number; closed: Array<{ date: string; startTime: string; closedReason: string }> };

/**
 * The weekly-slot edit (the only way a session's time changes) is about to delete these upcoming sessions and has
 * already minted their replacements. For each cover row on them:
 *  - an ACTIVE row moves only to its UNAMBIGUOUS replacement: the edit turned exactly one slot of that weekday into
 *    exactly one new slot, the row's session was on the old slot, and the class has the new slot's session on the
 *    same club date. A class that runs twice that day never has its morning cover land on the evening session. A
 *    moved covered row is flagged "Awaiting reconfirmation" with an Activity row;
 *  - any other active row is closed with an Activity row saying why: replacement_ambiguous (the day's slots changed
 *    with no one-to-one match — staff are told to request cover on the intended session) or session_removed;
 *  - an ended row (withdrawn or closed) lets go of the session it was on.
 * So the session delete that follows never meets a cover row, and no cover row is dropped silently.
 */
export async function moveCoversBeforeDelete(
  tx: Tx,
  tenantId: string,
  actorId: string | null,
  classId: string,
  doomedIds: string[],
  slotMoves: SlotMoves = { moves: new Map(), ambiguousDays: new Set() },
): Promise<CoverMoveReport> {
  const report: CoverMoveReport = { moved: 0, closed: [] };
  if (doomedIds.length === 0) return report;
  const rows = await tx.sessionCover.findMany({
    where: { tenantId, classInstanceId: { in: doomedIds } },
    select: { id: true, status: true, coverUserId: true, classInstance: { select: { id: true, date: true, startTime: true, endTime: true } } },
  });
  if (rows.length === 0) return report;
  const doomed = new Set(doomedIds);
  // The class's sessions that stay on those dates: the only possible replacements.
  const dates = [...new Set(rows.map((r) => r.classInstance && dayMarkerUtc(r.classInstance.date).getTime()).filter((d): d is number => typeof d === "number"))];
  const half = 12 * 3_600_000;
  const staying = dates.length
    ? await tx.classInstance.findMany({
        where: {
          classId,
          class: { tenantId },
          isCancelled: false,
          id: { notIn: doomedIds },
          OR: dates.map((d) => ({ date: { gte: new Date(d - half), lt: new Date(d + half) } })),
        },
        select: { id: true, date: true, startTime: true, endTime: true, cover: { select: { id: true } } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      })
    : [];
  const taken = new Set<string>();

  for (const r of rows) {
    const from = r.classInstance;
    if (!from || !doomed.has(from.id)) continue;
    const meta = { classId, date: from.date.toISOString(), startTime: from.startTime, endTime: from.endTime };
    if (!ACTIVE.includes(r.status)) {
      await tx.sessionCover.updateMany({ where: { id: r.id, tenantId, status: r.status }, data: { classInstanceId: null } });
      continue;
    }
    const marker = dayMarkerUtc(from.date);
    const weekday = marker.getUTCDay();
    const move = slotMoves.moves.get(weekday);
    const to =
      move && move.from === from.startTime
        ? staying.find((s) => dayMarkerUtc(s.date).getTime() === marker.getTime() && s.startTime === move.to && !s.cover && !taken.has(s.id))
        : undefined;
    if (to) {
      taken.add(to.id);
      const covered = r.status === "covered";
      await tx.sessionCover.updateMany({
        where: { id: r.id, tenantId, status: r.status },
        data: { classInstanceId: to.id, ...(covered ? { needsReconfirm: true } : {}) },
      });
      report.moved += 1;
      if (covered) {
        await logAuditStrict(tx, {
          tenantId, userId: actorId, action: "class.cover_reconfirm_flagged", entityType: "ClassInstance", entityId: to.id,
          metadata: { classId, date: to.date.toISOString(), startTime: to.startTime, endTime: to.endTime, previousStartTime: from.startTime, previousEndTime: from.endTime, coverUserId: r.coverUserId },
        });
      }
      continue;
    }
    const closedReason = slotMoves.ambiguousDays.has(weekday) || (move && move.from === from.startTime) ? "replacement_ambiguous" : "session_removed";
    await tx.sessionCover.updateMany({
      where: { id: r.id, tenantId, status: r.status },
      data: { status: "closed", closedReason, classInstanceId: null, coverUserId: null, needsReconfirm: false },
    });
    report.closed.push({ date: from.date.toISOString(), startTime: from.startTime, closedReason });
    await logAuditStrict(tx, {
      tenantId, userId: actorId, action: "class.cover_closed", entityType: "ClassInstance", entityId: from.id,
      metadata: { ...meta, closedReason, ...(r.coverUserId ? { previousCoverUserId: r.coverUserId } : {}) },
    });
  }
  return report;
}

/**
 * The weekly-slot edit gave these kept sessions a new end time. A covered one is flagged for reconfirmation: its
 * coach agreed to the old time.
 */
export async function flagCoversForRetime(tx: Tx, tenantId: string, actorId: string | null, classId: string, sessionIds: string[], endTime: string): Promise<void> {
  if (sessionIds.length === 0) return;
  const rows = await tx.sessionCover.findMany({
    where: { tenantId, classInstanceId: { in: sessionIds }, status: "covered", needsReconfirm: false },
    select: { id: true, coverUserId: true, classInstance: { select: { id: true, date: true, startTime: true, endTime: true } } },
  });
  for (const r of rows) {
    if (!r.classInstance) continue;
    const n = await tx.sessionCover.updateMany({ where: { id: r.id, tenantId, status: "covered", needsReconfirm: false }, data: { needsReconfirm: true } });
    if (n.count !== 1) continue;
    await logAuditStrict(tx, {
      tenantId, userId: actorId, action: "class.cover_reconfirm_flagged", entityType: "ClassInstance", entityId: r.classInstance.id,
      metadata: { classId, date: r.classInstance.date.toISOString(), startTime: r.classInstance.startTime, endTime, previousEndTime: r.classInstance.endTime, coverUserId: r.coverUserId },
    });
  }
}
