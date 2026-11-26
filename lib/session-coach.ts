/**
 * Who teaches ONE dated session — the one resolver every screen asks (session cover, Noe, 26 Nov 2026).
 *
 *  1. Cover accepted (a SessionCover row, status "covered"): the covering coach teaches it.
 *  2. Cover requested and not taken (status "open"), before the session starts: nobody is confirmed. Staff see
 *     "Cover needed" with the regular coach marked as away; members see "Coach to be confirmed" and nothing else
 *     (no names, no request).
 *  3. Otherwise — no row, a withdrawn or closed row, or an open request whose session has started — the class's
 *     regular coach (lib/class-coach.ts resolveCoachName: the linked staff member, else the typed name).
 *
 * A typed coach name is display text: it never proves who is signed in, so only `coachUserId` and the cover
 * row's `coverUserId` name the person who teaches (`teacherUserId`).
 *
 * Pure: no I/O, safe in client components.
 */
import { resolveCoachName, type CoachInput } from "@/lib/class-coach";

/** The cover row as a screen needs it; null when the session has none (or only an ended one). */
export type CoverSnapshot = {
  status: string;
  coverUserId: string | null;
  coverUserName: string | null;
  needsReconfirm: boolean;
} | null;

export type SessionTeacher = {
  state: "regular" | "cover_needed" | "covered";
  /** The signed-in person who teaches it: the covering coach, else the class's linked coach; null while cover is needed. */
  teacherUserId: string | null;
  /** The name to show for who teaches it; null while cover is needed or when the class has no coach. */
  teacherName: string | null;
  /** The class's regular coach (linked, else typed), whatever the cover says. */
  regularName: string | null;
  /** The covered session's time changed: its coach has to reconfirm. */
  needsReconfirm: boolean;
};

export const COVER_NEEDED = "Cover needed";
export const COACH_TO_BE_CONFIRMED = "Coach to be confirmed";
export const RECONFIRM_NEEDED = "Awaiting reconfirmation";

export function resolveSessionTeacher(
  cls: CoachInput & { coachUserId?: string | null; coachUser?: { id: string; name: string; deactivatedAt?: Date | string | null } | null },
  cover: CoverSnapshot | undefined,
  opts: { started?: boolean } = {},
): SessionTeacher {
  // A linked regular coach whose account is deactivated teaches nothing: the class falls back to its typed name, if
  // any, and otherwise has no coach ("No coach assigned" — never "Cover needed", which only a request makes).
  const deactivated = !!cls.coachUser?.deactivatedAt;
  const regular = deactivated ? { coachName: cls.coachName, coachUser: null } : cls;
  const regularName = resolveCoachName(regular);
  const regularId = deactivated ? null : (cls.coachUser?.id ?? cls.coachUserId ?? null);
  if (cover?.status === "covered" && cover.coverUserId) {
    return { state: "covered", teacherUserId: cover.coverUserId, teacherName: cover.coverUserName, regularName, needsReconfirm: cover.needsReconfirm };
  }
  if (cover?.status === "open" && !opts.started) {
    return { state: "cover_needed", teacherUserId: null, teacherName: null, regularName, needsReconfirm: false };
  }
  return { state: "regular", teacherUserId: regularId, teacherName: regularName, regularName, needsReconfirm: false };
}

/** What a member of staff reads for the session's coach; null when it has none. */
export function staffCoachLabel(t: SessionTeacher): string | null {
  if (t.state === "covered") {
    const by = `Covered by ${t.teacherName ?? "a former staff member"}`;
    return t.needsReconfirm ? `${by} · ${RECONFIRM_NEEDED}` : by;
  }
  if (t.state === "cover_needed") return t.regularName ? `${COVER_NEEDED} · ${t.regularName} away` : COVER_NEEDED;
  return t.teacherName;
}

/**
 * What a member reads for the session's coach: the confirmed coach, "Coach to be confirmed", or null. A cover whose
 * session's time changed is not confirmed for the new time until its coach reconfirms, so a member is not told it is.
 */
export function memberCoachLabel(t: SessionTeacher): string | null {
  if (t.state === "cover_needed" || (t.state === "covered" && t.needsReconfirm)) return COACH_TO_BE_CONFIRMED;
  return t.teacherName;
}

/** One session as the staff cover screens receive it (GET /api/coach/cover). */
export type CoverSessionView = {
  id: string;
  classId: string;
  className: string;
  dayKey: string;
  dayLabel: string;
  weekday: string;
  startTime: string;
  endTime: string | null;
  place: string | null;
  isCancelled: boolean;
  started: boolean;
  regularCoachName: string | null;
  /** True when the signed-in person is this class's linked regular coach. */
  regularIsMe: boolean;
  state: "regular" | "cover_needed" | "covered";
  coverUserId: string | null;
  coverUserName: string | null;
  needsReconfirm: boolean;
  /** What a member of staff reads for the coach (resolver). */
  coachLabel: string | null;
  can: {
    request: boolean;
    claim: boolean;
    assign: boolean;
    replace: boolean;
    giveUp: boolean;
    withdraw: boolean;
    returnToRegular: boolean;
    reconfirm: boolean;
  };
};

/**
 * Whether a session carries the "Yours" highlight on Mark attendance for this person. The confirmed covering coach's
 * session is theirs and no longer its regular coach's; a cover awaiting reconfirmation (its time changed) is nobody's
 * until the coach accepts the new time; otherwise the class's linked coach (or the legacy instructor column).
 */
export function isMySession(
  userId: string,
  cls: { coachUserId?: string | null; instructorId?: string | null },
  cover: CoverSnapshot | undefined,
): boolean {
  if (cover?.status === "covered") return !cover.needsReconfirm && cover.coverUserId === userId;
  return (!!cls.coachUserId && cls.coachUserId === userId) || (!!cls.instructorId && cls.instructorId === userId);
}
