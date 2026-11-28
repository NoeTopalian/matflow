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
import { dayMarkerUtc, sessionBounds, usableTimezone } from "@/lib/class-time";
import { logAuditStrict } from "@/lib/audit-log";
import { memberCoachLabel, resolveSessionTeacher, type CoverSnapshot } from "@/lib/session-coach";
import { boundsOf, describeSession, loadTeacherClashes, sessionDayLabel, sessionPlace } from "@/lib/session-clash";

export { describeSession, sessionDayLabel, sessionPlace };

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
      coachUser: { select: { id: true, name: true, deactivatedAt: true } },
      mat: { select: { name: true } },
    },
  },
} satisfies Prisma.ClassInstanceSelect;

export type CoverSession = Prisma.ClassInstanceGetPayload<{ select: typeof SESSION_SELECT }>;
export const COVER_SESSION_SELECT = SESSION_SELECT;

/** "Thursday" — the weekday of a session's club date. */
export function sessionWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(dayMarkerUtc(date));
}

/** "2026-12-03" — a session's club date as a key. */
export function sessionDayKey(date: Date): string {
  return dayMarkerUtc(date).toISOString().slice(0, 10);
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
 * `coverOnly`: count only sessions the coach covers, not their own classes (Withdraw or Return of an open request).
 */
export async function findCoverOverlap(
  tx: Tx,
  tenantId: string,
  tz: string,
  coachUserId: string,
  target: CoverSession,
  opts: { coverOnly?: boolean } = {},
): Promise<CoverConflict | null> {
  const mine = boundsOf(target, tz);
  const marker = dayMarkerUtc(target.date).getTime();
  const DAY = 86_400_000;
  const covering = { cover: { is: { tenantId, status: "covered", coverUserId: coachUserId } } };
  const candidates = await tx.classInstance.findMany({
    where: {
      id: { not: target.id },
      isCancelled: false,
      // The day before to the day after: an overnight session can reach into the target's day.
      date: { gte: new Date(marker - DAY - DAY / 2), lt: new Date(marker + DAY + DAY / 2) },
      class: { tenantId, isActive: true, deletedAt: null },
      OR: opts.coverOnly ? [covering] : [{ class: { coachUserId } }, covering],
    },
    select: { ...SESSION_SELECT, cover: { select: { status: true, coverUserId: true } } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  for (const c of candidates) {
    if (c.cover?.status === "covered" && c.cover.coverUserId !== coachUserId) continue;
    if (opts.coverOnly && !(c.cover?.status === "covered" && c.cover.coverUserId === coachUserId)) continue;
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
 * confirmed", or the confirmed covering coach), or that a clash gives it (lib/session-clash.ts: "Coach to be
 * confirmed" on the regular coach's side), by session id. A session with neither is not in the map, so the screen
 * keeps the coach it already showed.
 */
export async function memberCoverLabels(
  tx: Tx,
  tenantId: string,
  sessions: Array<{ id: string; date: Date; startTime: string; endTime: string | null; isCancelled?: boolean; class: { coachName: string | null; coachUser?: { id: string; name: string } | null; coachUserId?: string | null } }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const live = sessions.filter((s) => !s.isCancelled);
  const covers = await loadCovers(tx, tenantId, live.map((s) => s.id));
  const clashes = await loadTeacherClashes(tx, tenantId, live);
  if (covers.size === 0 && clashes.size === 0) return out;
  const club = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const tz = usableTimezone(club?.timezone);
  const now = new Date();
  for (const s of live) {
    const cover = covers.get(s.id);
    const clash = clashes.get(s.id);
    if (!cover && !clash) continue;
    out.set(s.id, memberCoachLabel(resolveSessionTeacher(s.class, cover, { started: sessionHasStarted(s, tz, now), clash })));
  }
  return out;
}

/** What every audit row of a cover action records about the session: enough to name it after it is gone. */
function sessionMeta(s: Pick<CoverSession, "date" | "startTime" | "endTime" | "class">) {
  return { classId: s.class.id, date: s.date.toISOString(), startTime: s.startTime, endTime: s.endTime };
}

// ── Session row locks (docs/design/LOCK-ORDER-2026-10-24.md: advisory, then ClassInstance, then SessionCover) ──────

/**
 * Locks ONE session row of this club for a cover change: FOR NO KEY UPDATE, which every other cover change of the
 * same session, a cancel or restore (an UPDATE of the row), a weekly-slot edit (FOR UPDATE before it deletes) and
 * an archive, pause or deactivation (FOR NO KEY UPDATE) wait for, and a check-in (KEY SHARE, from its attendance
 * insert) does not. So a cover change and a cancel never interleave, and two cover changes of one session are
 * serial. Returns false when the session is not (or no longer) this club's. The tenant id and session id are bind
 * parameters (tests/unit/sec-c-static-guards.test.ts).
 */
export async function lockSessionForCover(tx: Tx, tenantId: string, instanceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT ci.id FROM "ClassInstance" ci
     WHERE ci.id = ${instanceId}
       AND EXISTS (SELECT 1 FROM "Class" c WHERE c.id = ci."classId" AND c."tenantId" = ${tenantId})
       FOR NO KEY UPDATE OF ci`;
  return rows.length === 1;
}

/** Several session rows of this club, FOR NO KEY UPDATE, in id order (archive, pause, deactivation). */
export async function lockSessionsForCover(tx: Tx, tenantId: string, instanceIds: string[]): Promise<void> {
  if (instanceIds.length === 0) return;
  await tx.$queryRaw`
    SELECT ci.id FROM "ClassInstance" ci
     WHERE ci.id = ANY(${instanceIds}::text[])
       AND EXISTS (SELECT 1 FROM "Class" c WHERE c.id = ci."classId" AND c."tenantId" = ${tenantId})
     ORDER BY ci.id
       FOR NO KEY UPDATE OF ci`;
}

/** How far back the class-wide session lock reaches: every "upcoming" read in this file starts later than this. */
const CLASS_LOCK_FROM_MS = 3 * 86_400_000;

/**
 * EVERY session of one class from three days ago on, FOR NO KEY UPDATE, in id order: the class-wide lock that an
 * archive, a pause, an undo of a resume or restore, a weekly-slot edit and a change of regular coach take (after the
 * Class row) before they read any cover. A Request or Assign on any session of the class either committed before this
 * (and is seen) or waits for it and then reads the class as it now is. A check-in (KEY SHARE from its attendance
 * insert) does not wait for it. One statement in id order, like every other multi-session lock here
 * (docs/design/LOCK-ORDER-2026-10-24.md §8). The class id and tenant id are bind parameters.
 */
export async function lockClassSessions(tx: Tx, tenantId: string, classId: string, now: Date = new Date()): Promise<void> {
  const from = new Date(now.getTime() - CLASS_LOCK_FROM_MS);
  await tx.$queryRaw`
    SELECT ci.id FROM "ClassInstance" ci
     WHERE ci."classId" = ${classId}
       AND ci.date >= ${from}
       AND EXISTS (SELECT 1 FROM "Class" c WHERE c.id = ci."classId" AND c."tenantId" = ${tenantId})
     ORDER BY ci.id
       FOR NO KEY UPDATE OF ci`;
}

/** Session rows a weekly-slot edit is about to delete, FOR UPDATE, in id order, before their cover rows are moved. */
export async function lockSessionsForDelete(tx: Tx, tenantId: string, instanceIds: string[]): Promise<void> {
  if (instanceIds.length === 0) return;
  await tx.$queryRaw`
    SELECT ci.id FROM "ClassInstance" ci
     WHERE ci.id = ANY(${instanceIds}::text[])
       AND EXISTS (SELECT 1 FROM "Class" c WHERE c.id = ci."classId" AND c."tenantId" = ${tenantId})
     ORDER BY ci.id
       FOR UPDATE OF ci`;
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
 * One cover action on one dated session, inside the caller's tenant transaction.
 *
 * Lock order (docs/design/LOCK-ORDER-2026-10-24.md): at most ONE cover advisory lock — the coach this action puts on
 * the session (claim, assign, replace, reconfirm) or the regular coach it puts back (give up, withdraw, return) —
 * then this session's row (lockSessionForCover), then its cover row. Everything the action decides on is read after
 * the session lock, so a cancel, a weekly-slot edit, an archive or another cover change of the same session has
 * either fully happened or not started. Every write is still a conditional update pinned to this session and to the
 * state that was read, and an Activity row is written only when its update changed exactly one row.
 */
export async function applyCoverAction(tx: Tx, actor: CoverActor, instanceId: string, input: CoverInput, now: Date = new Date()): Promise<CoverOutcome> {
  const { tenantId, userId, role } = actor;
  const om = isOwnerOrManager(role);

  // Ownership before disclosure: a session of another club is a bare 404. A plain read (no lock): it names the
  // regular coach whose advisory lock give up, withdraw and return take.
  const pre = await tx.classInstance.findFirst({ where: { id: instanceId, class: { tenantId } }, select: { class: { select: { coachUserId: true } } } });
  if (!pre) return refuse(404, "NOT_FOUND", "Not found");

  // Level 1: one advisory lock.
  const lockFor =
    input.action === "claim" || input.action === "reconfirm"
      ? userId
      : input.action === "assign" || input.action === "replace"
        ? input.coachUserId
        : input.action === "give_up" || input.action === "withdraw" || input.action === "return"
          ? pre.class.coachUserId
          : null;
  if (lockFor) await lockCoachCover(tx, tenantId, lockFor);
  // Level 2: this session's row.
  if (!(await lockSessionForCover(tx, tenantId, instanceId))) {
    return refuse(409, "SESSION_GONE", "This session is no longer on the timetable. Reload to see the current sessions.");
  }

  const session = await tx.classInstance.findFirst({ where: { id: instanceId, class: { tenantId } }, select: SESSION_SELECT });
  if (!session) return refuse(409, "SESSION_GONE", "This session is no longer on the timetable. Reload to see the current sessions.");
  // Give up, withdraw and return hold the advisory lock of the regular coach read BEFORE the session lock. A change of
  // regular coach that committed in between (it locks every session of the class, so it is now fully done) would
  // leave the regular-coach check below running for someone whose lock this transaction does not hold: refuse.
  const putsRegularBack = input.action === "give_up" || input.action === "withdraw" || input.action === "return";
  if (putsRegularBack && session.class.coachUserId !== pre.class.coachUserId) {
    return refuse(409, "CHANGED", "This class's regular coach has just changed. Reload to see it.");
  }
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const tz = usableTimezone(tenant?.timezone);
  const label = describeSession(session);

  if (!session.class.isActive || session.class.deletedAt || session.class.sourceImportJobId) {
    return refuse(409, "CLASS_NOT_LIVE", "This class is not on the timetable, so its cover cannot change.");
  }
  if (session.isCancelled) return refuse(409, "SESSION_CANCELLED", "This session is cancelled, so its cover cannot change.");
  if (sessionHasStarted(session, tz, now)) return refuse(409, "SESSION_STARTED", "This session has already started, so its cover can no longer change.");

  const readRow = () =>
    tx.sessionCover.findFirst({
      where: { tenantId, classInstanceId: instanceId },
      select: { id: true, status: true, coverUserId: true, needsReconfirm: true, coverUser: { select: { name: true } } },
    });
  const row = await readRow();
  const regularId = session.class.coachUserId;
  const coveredBy = (name: string | null | undefined) => `Already covered by ${name ?? "another coach"}.`;
  const changedNow = () => refuse(409, "CHANGED", "This session's cover has just changed. Reload to see it.");
  /** The accurate answer when an insert or update found the row in another state than the one read. */
  const stateNow = async (): Promise<CoverOutcome> => {
    const now2 = await readRow();
    if (now2?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy(now2.coverUser?.name));
    if (now2?.status === "open") return refuse(409, "ALREADY_REQUESTED", "Cover has already been requested for this session.");
    return changedNow();
  };
  const audit = (action: string, extra: Record<string, unknown> = {}) =>
    logAuditStrict(tx, { tenantId, userId, action, entityType: "ClassInstance", entityId: instanceId, metadata: { ...sessionMeta(session), ...extra } });
  const done = async (changed: boolean): Promise<CoverOutcome> => {
    const after = await readRow();
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
  /** The class's own regular coach is not its cover: withdraw the request or return the session to them instead. */
  const isRegular = (coach: { id: string; name: string }): CoverOutcome | null =>
    regularId && coach.id === regularId
      ? refuse(409, "REGULAR_COACH", `${coach.id === userId ? "You're" : `${coach.name} is`} this class's regular coach. Withdraw the request or return the session to its regular coach instead.`)
      : null;
  /**
   * Taking a session off its cover (give up, withdraw, return) makes the class's linked regular coach its teacher
   * again, and nothing else says so. If that coach is meanwhile teaching an overlapping session (their own, or one
   * they now cover), it is refused by name rather than leaving one person on two sessions at once. Checked whatever
   * the row's status: an OPEN row can be one a deactivation reopened (reopenCoversOfDeactivatedCoach) after the regular
   * coach, free while someone else covered, claimed an overlapping session; withdrawing or returning it would then
   * double-book them silently (review of 7d7b17df, blocker 1). The regular coach's advisory lock was taken at level 1.
   * For an OPEN row only the sessions the regular coach covers count (review of 121529e4, nit 1): with the request
   * open they were already its teacher, so another class they head at the same time is the regular-versus-regular
   * overlap the class form allows, and Withdraw or Return changes nothing about it.
   */
  const regularBusy = async (what: string): Promise<CoverOutcome | null> => {
    if (!regularId || regularId === row?.coverUserId) return null;
    const clash = await findCoverOverlap(tx, tenantId, tz, regularId, session, { coverOnly: row?.status === "open" });
    if (!clash) return null;
    const regularName = session.class.coachUser?.name ?? "The regular coach";
    return refuse(409, "REGULAR_COACH_BUSY", `${what} would put ${regularName} back on this class while they teach ${clash.className} on ${clash.label}. Choose another coach with Replace, or change that session first.`, clash);
  };
  /** Insert this session's cover row unless one appeared meanwhile (ON CONFLICT DO NOTHING: no aborted transaction). */
  const insert = async (data: { status: string; coverUserId?: string }): Promise<boolean> => {
    const n = await tx.sessionCover.createMany({
      data: [{ tenantId, classInstanceId: instanceId, requestedById: userId, ...data }],
      skipDuplicates: true,
    });
    return n.count === 1;
  };
  const pinned = (extra: Prisma.SessionCoverWhereInput) => ({ id: row!.id, tenantId, classInstanceId: instanceId, ...extra });

  switch (input.action) {
    case "request": {
      if (!om && !(regularId && regularId === userId)) {
        return refuse(403, "FORBIDDEN", "Only the owner, a manager or this class's own coach can ask for cover.");
      }
      if (row?.status === "open") return refuse(409, "ALREADY_REQUESTED", "Cover has already been requested for this session.");
      if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy(row.coverUser?.name));
      if (row) {
        const n = await tx.sessionCover.updateMany({
          where: pinned({ status: row.status }),
          data: { status: "open", coverUserId: null, requestedById: userId, needsReconfirm: false, closedReason: null },
        });
        if (n.count !== 1) return stateNow();
      } else if (!(await insert({ status: "open" }))) {
        return stateNow();
      }
      await audit("class.cover_requested");
      return done(true);
    }

    case "claim": {
      const me = await eligibleStaff(tx, tenantId, userId);
      if (!me) return refuse(403, "NOT_ELIGIBLE", "Only a member of this club's staff can cover a class.");
      if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy(row.coverUser?.name));
      if (row?.status !== "open") return refuse(409, "NOT_OPEN", "This class no longer needs cover.");
      const own = isRegular(me);
      if (own) return own;
      const clash = await overlap(me);
      if (clash) return clash;
      const n = await tx.sessionCover.updateMany({
        where: pinned({ status: "open" }),
        data: { status: "covered", coverUserId: userId, needsReconfirm: false },
      });
      if (n.count !== 1) {
        const now2 = await readRow();
        if (now2?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy(now2.coverUser?.name));
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
        if (row?.status === "covered") return refuse(409, "ALREADY_COVERED", coveredBy(row.coverUser?.name));
      } else {
        if (row?.status !== "covered") return refuse(409, "NOT_COVERED", "This session is not covered at the moment.");
        if (row.coverUserId === coach.id) return done(false);
      }
      const own = isRegular(coach);
      if (own) return own;
      const clash = await overlap(coach);
      if (clash) return clash;
      if (input.action === "replace" && row) {
        const n = await tx.sessionCover.updateMany({
          where: pinned({ status: "covered", coverUserId: row.coverUserId }),
          data: { coverUserId: coach.id, needsReconfirm: false },
        });
        if (n.count !== 1) return stateNow();
        await audit("class.cover_replaced", { coverUserId: coach.id, previousCoverUserId: row.coverUserId });
        return done(true);
      }
      if (row) {
        const n = await tx.sessionCover.updateMany({
          where: pinned({ status: row.status }),
          data: {
            status: "covered",
            coverUserId: coach.id,
            needsReconfirm: false,
            closedReason: null,
            // An open request keeps who asked for it; an ended one is asked for again by whoever assigns it now.
            ...(row.status === "open" ? {} : { requestedById: userId }),
          },
        });
        if (n.count !== 1) return stateNow();
      } else if (!(await insert({ status: "covered", coverUserId: coach.id }))) {
        return stateNow();
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
        where: pinned({ status: "covered", coverUserId: row.coverUserId }),
        data: { status: "open", coverUserId: null, needsReconfirm: false },
      });
      if (n.count !== 1) return stateNow();
      await audit("class.cover_given_up", { previousCoverUserId: row.coverUserId });
      return done(true);
    }

    case "withdraw":
    case "return": {
      if (!om) return refuse(403, "FORBIDDEN", "Only the owner or a manager can change this.");
      if (!row || !ACTIVE.includes(row.status)) return refuse(409, "NOT_ACTIVE", "This session has no cover request.");
      const returning = input.action === "return";
      if (returning && !regularId && !session.class.coachName?.trim()) {
        return refuse(409, "NO_REGULAR_COACH", "This class has no regular coach. Withdraw the request instead.");
      }
      const busy = await regularBusy(returning ? "Returning this session to its regular coach" : "Withdrawing this cover");
      if (busy) return busy;
      const n = await tx.sessionCover.updateMany({
        where: pinned({ status: row.status, coverUserId: row.coverUserId }),
        data: returning
          ? { status: "closed", closedReason: "returned_to_regular", coverUserId: null, needsReconfirm: false }
          : { status: "withdrawn", closedReason: null, coverUserId: null, needsReconfirm: false },
      });
      if (n.count !== 1) return stateNow();
      await audit(returning ? "class.cover_returned_to_regular" : "class.cover_withdrawn", row.coverUserId ? { previousCoverUserId: row.coverUserId } : {});
      return done(true);
    }

    case "reconfirm": {
      if (row?.status !== "covered" || !row.needsReconfirm) return refuse(409, "NOTHING_TO_RECONFIRM", "There is nothing to reconfirm for this session.");
      if (row.coverUserId !== userId) return refuse(403, "FORBIDDEN", "Only the coach covering this class can reconfirm it.");
      // A fresh overlap check at the NEW time: accepting one time is not accepting another.
      const clash = await overlap({ id: userId, name: row.coverUser?.name ?? "" });
      if (clash) return clash;
      const n = await tx.sessionCover.updateMany({
        where: pinned({ status: "covered", coverUserId: userId, needsReconfirm: true }),
        data: { needsReconfirm: false },
      });
      if (n.count !== 1) return stateNow();
      await audit("class.cover_reconfirmed", { coverUserId: userId });
      return done(true);
    }
  }
}

// ── What the writers that cancel, re-time, remove, archive or pause sessions, or deactivate a coach, do ──────────

type SessionRef = Pick<CoverSession, "date" | "startTime" | "endTime"> & { id: string; classId: string };
const refMeta = (s: SessionRef) => ({ classId: s.classId, date: s.date.toISOString(), startTime: s.startTime, endTime: s.endTime });

/**
 * Cancelling a session closes its cover (reason session_cancelled) in the cancel's own transaction, under the
 * session's row lock (the cancel's UPDATE already holds it; taking it again here is a no-op), so a claim or an
 * assignment either finished before the cancel (and is closed now) or waits and then sees the session cancelled.
 * The Activity row is written only when a row was actually closed. Restoring the session does NOT reopen it: no
 * coach is silently recommitted; the owner may ask for cover again.
 */
export async function closeCoverOnCancel(tx: Tx, tenantId: string, actorId: string, session: SessionRef): Promise<boolean> {
  await lockSessionForCover(tx, tenantId, session.id);
  const row = await tx.sessionCover.findFirst({
    where: { tenantId, classInstanceId: session.id, status: { in: ACTIVE } },
    select: { id: true, status: true, coverUserId: true },
  });
  if (!row) return false;
  const n = await tx.sessionCover.updateMany({
    where: { id: row.id, tenantId, classInstanceId: session.id, status: { in: ACTIVE } },
    data: { status: "closed", closedReason: "session_cancelled", coverUserId: null, needsReconfirm: false },
  });
  if (n.count !== 1) return false;
  await logAuditStrict(tx, {
    tenantId,
    userId: actorId,
    action: "class.cover_closed",
    entityType: "ClassInstance",
    entityId: session.id,
    metadata: { ...refMeta(session), closedReason: "session_cancelled", ...(row.coverUserId ? { previousCoverUserId: row.coverUserId } : {}) },
  });
  return true;
}

/**
 * How a weekly-slot edit changed one weekday of a class: the one old start time that became one new start time
 * (`moves`), or a weekday whose slots changed in a way that does not pair one old slot with one new one
 * (`ambiguousDays`) — Noe's correction of 26 Nov 2026: same date is not same session. A slot whose START is in both
 * lists only changed its end: its sessions are kept and re-timed (flagCoversForRetime), so it is neither.
 */
export type SlotMoves = { moves: Map<number, { from: string; to: string }>; ambiguousDays: Set<number> };

/** Pairs the removed and added slots of a weekly-slot edit, weekday by weekday (0 = Sunday, as ClassSchedule). */
export function slotMovesOf(removed: Array<{ dayOfWeek: number; startTime: string }>, added: Array<{ dayOfWeek: number; startTime: string }>): SlotMoves {
  const moves = new Map<number, { from: string; to: string }>();
  const ambiguousDays = new Set<number>();
  const key = (x: { dayOfWeek: number; startTime: string }) => `${x.dayOfWeek}|${x.startTime}`;
  const removedStarts = new Set(removed.map(key));
  const addedStarts = new Set(added.map(key));
  const realRemoved = removed.filter((x) => !addedStarts.has(key(x)));
  const realAdded = added.filter((x) => !removedStarts.has(key(x)));
  for (let d = 0; d < 7; d++) {
    const r = realRemoved.filter((x) => x.dayOfWeek === d);
    const a = realAdded.filter((x) => x.dayOfWeek === d);
    if (r.length === 1 && a.length === 1) moves.set(d, { from: r[0].startTime, to: a[0].startTime });
    else if (r.length > 0 && a.length > 0) ambiguousDays.add(d);
  }
  return { moves, ambiguousDays };
}

export type CoverMoveReport = { moved: number; closed: Array<{ date: string; startTime: string; closedReason: string }> };

/** Close one active cover row with a reason and its Activity row; false when it was no longer active. */
async function closeActive(
  tx: Tx,
  tenantId: string,
  actorId: string | null,
  r: { id: string; status: string; coverUserId: string | null },
  from: SessionRef,
  closedReason: string,
  detach: boolean,
): Promise<boolean> {
  const n = await tx.sessionCover.updateMany({
    where: { id: r.id, tenantId, classInstanceId: from.id, status: r.status },
    data: { status: "closed", closedReason, coverUserId: null, needsReconfirm: false, ...(detach ? { classInstanceId: null } : {}) },
  });
  if (n.count !== 1) return false;
  await logAuditStrict(tx, {
    tenantId, userId: actorId, action: "class.cover_closed", entityType: "ClassInstance", entityId: from.id,
    metadata: { ...refMeta(from), closedReason, ...(r.coverUserId ? { previousCoverUserId: r.coverUserId } : {}) },
  });
  return true;
}

/**
 * The weekly-slot edit (the only way a session's time changes) is about to delete these upcoming sessions and has
 * already minted their replacements. It first locks the doomed sessions FOR UPDATE (id order), so no cover change
 * of theirs is half-way through, and none can start, until it commits. For each cover row on them:
 *  - an ACTIVE row moves only to its UNAMBIGUOUS replacement: the edit turned exactly one slot of that weekday into
 *    exactly one new slot, the row's session was on the old slot, and the class has the new slot's session on the
 *    same club date, not cancelled and not yet started. A class that runs twice that day never has its morning cover
 *    land on the evening session. A replacement holding only an ended cover row (withdrawn or closed) takes the move:
 *    the ended row lets go of it first. A moved covered row is flagged "Awaiting reconfirmation" (its coach accepted
 *    the old time, not this one) and a moved open request is said too, each with its Activity row;
 *  - any other active row is closed with an Activity row saying why: replacement_ambiguous (the day's slots changed
 *    with no one-to-one match — staff are told to request cover on the intended session), replacement_started (the
 *    new time that day has already begun) or session_removed;
 *  - an ended row lets go of the session it was on.
 * Every update is pinned to the doomed session and its state, and is checked: under the lock a row cannot change, so
 * a mismatch is an error that rolls the edit back rather than a foreign-key failure at the delete.
 */
export async function moveCoversBeforeDelete(
  tx: Tx,
  tenantId: string,
  actorId: string | null,
  classId: string,
  doomedIds: string[],
  slotMoves: SlotMoves = { moves: new Map(), ambiguousDays: new Set() },
  tz: string = "Europe/London",
  now: Date = new Date(),
): Promise<CoverMoveReport> {
  const report: CoverMoveReport = { moved: 0, closed: [] };
  if (doomedIds.length === 0) return report;
  await lockSessionsForDelete(tx, tenantId, doomedIds);
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
        select: { id: true, date: true, startTime: true, endTime: true, cover: { select: { id: true, status: true } } },
        orderBy: [{ date: "asc" }, { startTime: "asc" }],
      })
    : [];
  const taken = new Set<string>();
  const mustChange = (n: { count: number }) => {
    if (n.count !== 1) throw new Error("session cover row changed under the session lock during a weekly-slot edit");
  };

  for (const r of rows) {
    const fromRow = r.classInstance;
    if (!fromRow || !doomed.has(fromRow.id)) continue;
    const from: SessionRef = { ...fromRow, classId };
    if (!ACTIVE.includes(r.status)) {
      mustChange(await tx.sessionCover.updateMany({ where: { id: r.id, tenantId, classInstanceId: from.id, status: r.status }, data: { classInstanceId: null } }));
      continue;
    }
    const marker = dayMarkerUtc(from.date);
    const weekday = marker.getUTCDay();
    const move = slotMoves.moves.get(weekday);
    const paired = !!move && move.from === from.startTime;
    const to = paired
      ? staying.find((s) => dayMarkerUtc(s.date).getTime() === marker.getTime() && s.startTime === move!.to && !taken.has(s.id) && (!s.cover || !ACTIVE.includes(s.cover.status)))
      : undefined;
    if (to && !sessionHasStarted(to, tz, now)) {
      taken.add(to.id);
      if (to.cover) {
        // The replacement holds only an ended row: it lets go, so the move is not mistaken for an ambiguous one.
        mustChange(await tx.sessionCover.updateMany({ where: { id: to.cover.id, tenantId, classInstanceId: to.id, status: to.cover.status }, data: { classInstanceId: null } }));
      }
      const covered = r.status === "covered";
      mustChange(await tx.sessionCover.updateMany({
        where: { id: r.id, tenantId, classInstanceId: from.id, status: r.status },
        data: { classInstanceId: to.id, ...(covered ? { needsReconfirm: true } : {}) },
      }));
      report.moved += 1;
      await logAuditStrict(tx, {
        tenantId, userId: actorId, action: covered ? "class.cover_reconfirm_flagged" : "class.cover_moved", entityType: "ClassInstance", entityId: to.id,
        metadata: { classId, date: to.date.toISOString(), startTime: to.startTime, endTime: to.endTime, previousStartTime: from.startTime, previousEndTime: from.endTime, ...(covered ? { coverUserId: r.coverUserId } : {}) },
      });
      continue;
    }
    const closedReason = to ? "replacement_started" : slotMoves.ambiguousDays.has(weekday) || paired ? "replacement_ambiguous" : "session_removed";
    if (!(await closeActive(tx, tenantId, actorId, r, from, closedReason, true))) mustChange({ count: 0 });
    report.closed.push({ date: from.date.toISOString(), startTime: from.startTime, closedReason });
  }
  return report;
}

/**
 * The weekly-slot edit gave these kept sessions a new end time (their UPDATE holds their row locks). A covered one is
 * flagged for reconfirmation: its coach agreed to the old time, not this one, and reconfirming re-runs the overlap
 * check at the new time.
 */
export async function flagCoversForRetime(
  tx: Tx,
  tenantId: string,
  actorId: string | null,
  classId: string,
  sessionIds: string[],
  endTime: string,
  tz: string = "Europe/London",
  now: Date = new Date(),
): Promise<void> {
  if (sessionIds.length === 0) return;
  const rows = await tx.sessionCover.findMany({
    where: { tenantId, classInstanceId: { in: sessionIds }, status: "covered", needsReconfirm: false },
    select: { id: true, coverUserId: true, classInstance: { select: { id: true, date: true, startTime: true, endTime: true } } },
  });
  for (const r of rows) {
    if (!r.classInstance) continue;
    // A session already under way keeps its confirmed coach: it can no longer be reconfirmed (cover actions refuse a
    // started session), and members would see "Coach to be confirmed" in the middle of the class (review nit 3).
    if (sessionHasStarted(r.classInstance, tz, now)) continue;
    const n = await tx.sessionCover.updateMany({
      where: { id: r.id, tenantId, classInstanceId: r.classInstance.id, status: "covered", needsReconfirm: false },
      data: { needsReconfirm: true },
    });
    if (n.count !== 1) continue;
    await logAuditStrict(tx, {
      tenantId, userId: actorId, action: "class.cover_reconfirm_flagged", entityType: "ClassInstance", entityId: r.classInstance.id,
      // `previousEndTime` is what the session had: the row's `endTime` has already been rewritten by the caller.
      metadata: { classId, date: r.classInstance.date.toISOString(), startTime: r.classInstance.startTime, endTime, previousEndTime: r.classInstance.endTime === endTime ? null : r.classInstance.endTime, coverUserId: r.coverUserId },
    });
  }
}

/** The first day an "upcoming" read below looks at: from a day and a half before today's UTC day marker. */
const upcomingSince = (now: Date) => new Date(dayMarkerUtc(now).getTime() - 36 * 3_600_000);
const UPCOMING_COVER_SELECT = { id: true, status: true, coverUserId: true, classInstance: { select: { id: true, classId: true, date: true, startTime: true, endTime: true, isCancelled: true } } } as const;

/** Active cover rows on the upcoming, not cancelled sessions matching `where` (plain read; the caller holds the locks). */
async function upcomingActiveCovers(tx: Tx, tenantId: string, where: Prisma.SessionCoverWhereInput, now: Date) {
  const scope: Prisma.SessionCoverWhereInput = { AND: [{ tenantId, status: { in: ACTIVE }, classInstance: { is: { isCancelled: false, date: { gte: upcomingSince(now) } } } }, where] };
  return tx.sessionCover.findMany({ where: scope, select: UPCOMING_COVER_SELECT });
}

/** Active cover rows on the upcoming, not yet started, not cancelled sessions matching `where`, after locking them. */
async function lockedUpcomingCovers(tx: Tx, tenantId: string, where: Prisma.SessionCoverWhereInput, tz: string, now: Date) {
  const first = await upcomingActiveCovers(tx, tenantId, where, now);
  const ids = first.flatMap((r) => (r.classInstance ? [r.classInstance.id] : []));
  if (ids.length === 0) return [];
  await lockSessionsForCover(tx, tenantId, ids);
  // Re-read under the locks: a claim or assignment that was mid-way has now committed (or not).
  const rows = await upcomingActiveCovers(tx, tenantId, { AND: [where, { classInstanceId: { in: ids } }] }, now);
  return rows.filter((r) => r.classInstance && !sessionHasStarted(r.classInstance, tz, now));
}

/**
 * Archiving or pausing a class ends the active cover on its upcoming sessions (reason class_archived or class_paused,
 * an Activity row each), in the same transaction, so restoring or resuming the class never brings a previous cover
 * back and no one keeps a hidden booking on a session that is off the timetable. Past sessions keep theirs.
 *
 * EVERY session of the class is locked first (lockClassSessions), not only those already seen with a cover: a Request
 * or Assign on any of them either committed before (and is closed here) or waits, then reads the class as archived or
 * paused and is refused (review of 7d7b17df, should-fix 1).
 */
export async function closeCoversForClass(tx: Tx, tenantId: string, actorId: string | null, classId: string, reason: "class_archived" | "class_paused", tz: string, now: Date = new Date()): Promise<number> {
  await lockClassSessions(tx, tenantId, classId, now);
  const rows = (await upcomingActiveCovers(tx, tenantId, { classInstance: { is: { classId } } }, now))
    .filter((r) => r.classInstance && !sessionHasStarted(r.classInstance, tz, now));
  let closed = 0;
  for (const r of rows) {
    const s = r.classInstance!;
    if (await closeActive(tx, tenantId, actorId, r, { id: s.id, classId: s.classId, date: s.date, startTime: s.startTime, endTime: s.endTime }, reason, false)) closed += 1;
  }
  return closed;
}

/**
 * Deactivating a member of staff reopens the upcoming sessions they had accepted to cover (status open, so staff see
 * "Cover needed" again and members "Coach to be confirmed"), in the deactivation's transaction, with an Activity row
 * each. The caller takes this coach's cover advisory lock first, so a claim or assignment of theirs cannot slip in.
 * Reactivating them does not put them back.
 */
export async function reopenCoversOfDeactivatedCoach(tx: Tx, tenantId: string, actorId: string, coachUserId: string, tz: string, now: Date = new Date()): Promise<number> {
  const rows = await lockedUpcomingCovers(tx, tenantId, { status: "covered", coverUserId: coachUserId }, tz, now);
  let reopened = 0;
  for (const r of rows) {
    const s = r.classInstance!;
    const n = await tx.sessionCover.updateMany({
      where: { id: r.id, tenantId, classInstanceId: s.id, status: "covered", coverUserId: coachUserId },
      data: { status: "open", coverUserId: null, needsReconfirm: false },
    });
    if (n.count !== 1) continue;
    reopened += 1;
    await logAuditStrict(tx, {
      tenantId, userId: actorId, action: "class.cover_given_up", entityType: "ClassInstance", entityId: s.id,
      metadata: { classId: s.classId, date: s.date.toISOString(), startTime: s.startTime, endTime: s.endTime, previousCoverUserId: coachUserId, reason: "coach_deactivated" },
    });
  }
  return reopened;
}

export type RegularCoachClash = { message: string; instanceId: string; session: string; conflict: CoverConflict };

/**
 * Making `coachUserId` the regular coach of this class (class PATCH): the first upcoming session of the class they
 * would then teach while they have accepted to cover an overlapping session of another class, or null. A session of
 * this class that someone else has accepted to cover is not one they would teach, and back-to-back is not an overlap.
 * Only accepted cover counts: two classes with the same regular coach at the same time are not refused, because the
 * class form has never refused that.
 *
 * The caller holds `coachUserId`'s cover advisory lock (taken before the Class row), so a claim or an assignment of
 * that coach is either committed (and seen) or waits for this transaction; every session of the class is locked here
 * (lockClassSessions), so a give up, withdraw or return on one of them is either committed or waits too, and then
 * finds the regular coach changed (applyCoverAction refuses it as CHANGED).
 */
export async function regularCoachCoverClash(tx: Tx, tenantId: string, classId: string, coachUserId: string, tz: string, now: Date = new Date()): Promise<RegularCoachClash | null> {
  await lockClassSessions(tx, tenantId, classId, now);
  const ours = (await tx.classInstance.findMany({
    where: { classId, class: { tenantId }, isCancelled: false, date: { gte: upcomingSince(now) } },
    select: { ...SESSION_SELECT, cover: { select: { status: true, coverUserId: true } } },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  })).filter((s) => !(s.cover?.status === "covered" && s.cover.coverUserId !== coachUserId) && !sessionHasStarted(s, tz, now));
  if (ours.length === 0) return null;
  const DAY = 86_400_000;
  const first = dayMarkerUtc(ours[0].date).getTime();
  const last = dayMarkerUtc(ours[ours.length - 1].date).getTime();
  const covering = await tx.classInstance.findMany({
    where: {
      classId: { not: classId },
      isCancelled: false,
      date: { gte: new Date(first - DAY - DAY / 2), lt: new Date(last + DAY + DAY / 2) },
      class: { tenantId, isActive: true, deletedAt: null },
      cover: { is: { tenantId, status: "covered", coverUserId: coachUserId } },
    },
    select: SESSION_SELECT,
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });
  for (const s of ours) {
    const mine = boundsOf(s, tz);
    for (const c of covering) {
      const theirs = boundsOf(c, tz);
      if (!(theirs.start < mine.end && mine.start < theirs.end)) continue;
      const coach = await tx.user.findFirst({ where: { id: coachUserId, tenantId }, select: { name: true } });
      const conflict = { instanceId: c.id, className: c.class.name, label: describeSession(c) };
      return {
        message: `${coach?.name ?? "This coach"} is covering ${c.class.name} on ${conflict.label}, which overlaps this class on ${describeSession(s)}. Choose another regular coach, or give up or replace that cover first.`,
        instanceId: s.id,
        session: describeSession(s),
        conflict,
      };
    }
  }
  return null;
}

/** Active cover rows on these sessions (the weekly-slot edit's kept orphans). */
export async function countActiveCovers(tx: Tx, tenantId: string, instanceIds: string[]): Promise<number> {
  if (instanceIds.length === 0) return 0;
  return tx.sessionCover.count({ where: { tenantId, classInstanceId: { in: instanceIds }, status: { in: ACTIVE } } });
}
