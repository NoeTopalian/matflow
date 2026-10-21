/**
 * T7c (Sean note 5, "max 4 classes every 4 weeks allows for multiple classes
 * in 1 week"): a membership plan's class allowance, defined once.
 *
 * Product decisions (Noe, 20 Oct 2026):
 *  - Memberships recur; an attendance allowance is optional. The administrator
 *    picks Unlimited, or `N classes` on an EXPLICIT reset basis, and can clear
 *    it again. Billing frequency (`billingCycle`) is separate and never implied.
 *  - Reset bases: each calendar week (Monday to Sunday), each calendar month,
 *    or every N weeks (2–8) counted from a period start date the plan carries.
 *    A class is judged against the period that CONTAINS it; the period is
 *    half-open [start, end). There is no rolling window: a period starts and
 *    ends on dates the administrator and the member can both see.
 *  - Booking consumes nothing. Confirmed attendance consumes one session of
 *    the period containing that class. Cancelling a booking, or being absent
 *    (no attendance row), consumes nothing. Reversing attendance deletes the
 *    row, and because the count is always recomputed from rows by the class's
 *    own date, the session goes back to its own period.
 *  - Open decision, documented in docs/readiness/CLASS-ALLOWANCE-RESET-MODEL-
 *    2026-10-21.md: the every-N-weeks anchor is PER PLAN (every member on the
 *    plan shares the periods). If a per-member anchor is chosen later, only
 *    where the anchor is stored changes, not the maths below.
 *
 * This module is pure: configuration, period arithmetic and wording. The
 * check-in engine (lib/checkin.ts) enforces the allowance with these functions
 * under the Member row lock, from one database read (lib/class-allowance-count.ts).
 *
 * ── Reader rule (columns → allowance) ────────────────────────────────────────
 *   1. `classLimitBasis` set → that basis with `classLimit` (and, for "weeks",
 *      `classLimitWeeks` + `classLimitAnchor`).
 *   2. else `maxClassesPerWeek` set → N each calendar week. This is the
 *      previous build's "Classes per week" field (all Total BJJ plans were NULL
 *      on 15 Oct 2026; the demo seed has one). It was never a rolling window
 *      to the people who set it, so it is read as the calendar week.
 *   3. else Unlimited.
 * A weekly allowance still mirrors N into `maxClassesPerWeek`, so a rollback
 * to the previous build shows the right number; any other basis sets it NULL
 * (that build then shows Unlimited rather than a wrong "N/wk").
 */
import { z } from "zod";
import { zoneOffsetMs } from "@/lib/class-time";

export const CLASS_LIMIT_MIN = 1;
export const CLASS_LIMIT_MAX = 60;
export const CLASS_LIMIT_WEEKS_MIN = 2;
export const CLASS_LIMIT_WEEKS_MAX = 8;

export const ALLOWANCE_BASES = ["week", "month", "weeks"] as const;
export type AllowanceBasis = (typeof ALLOWANCE_BASES)[number];

/** The "every N weeks" choices the plan editor offers, in order. */
export const CLASS_LIMIT_WEEK_OPTIONS = [2, 3, 4, 5, 6, 7, 8] as const;

/** "YYYY-MM-DD" on the club's calendar. */
export type IsoDate = string;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ClassAllowance =
  | { limit: number; basis: "week" }
  | { limit: number; basis: "month" }
  | { limit: number; basis: "weeks"; weeks: number; anchor: IsoDate };

export type TierAllowanceColumns = {
  classLimit?: number | null;
  classLimitBasis?: string | null;
  classLimitWeeks?: number | null;
  /** Prisma gives a Date (UTC midnight) for a @db.Date column; the API gives "YYYY-MM-DD". */
  classLimitAnchor?: Date | string | null;
  maxClassesPerWeek?: number | null;
};

function isoDateOf(v: Date | string | null | undefined): IsoDate | null {
  if (v == null) return null;
  if (typeof v === "string") {
    if (ISO_DATE.test(v)) return v;
    // A Date run through JSON (the membership routes return the Prisma row):
    // "2026-10-20T00:00:00.000Z" is the same calendar day.
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(0, 10) : null;
  }
  return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
}

/** The allowance a tier carries under the reader rule above; null = Unlimited. */
export function tierAllowance(t: TierAllowanceColumns | null | undefined): ClassAllowance | null {
  if (!t) return null;
  if (t.classLimitBasis != null && t.classLimit != null) {
    const basis = t.classLimitBasis;
    if (basis === "week" || basis === "month") return { limit: t.classLimit, basis };
    if (basis === "weeks") {
      const anchor = isoDateOf(t.classLimitAnchor);
      if (t.classLimitWeeks != null && t.classLimitWeeks >= CLASS_LIMIT_WEEKS_MIN && anchor) {
        return { limit: t.classLimit, basis: "weeks", weeks: t.classLimitWeeks, anchor };
      }
    }
    return null;
  }
  if (t.maxClassesPerWeek != null) return { limit: t.maxClassesPerWeek, basis: "week" };
  return null;
}

// ── Wording of the allowance itself ──────────────────────────────────────────

/** "each week", "each month", "every 4 weeks". */
export function basisText(a: ClassAllowance): string {
  if (a.basis === "week") return "each week";
  if (a.basis === "month") return "each month";
  return `every ${a.weeks} weeks`;
}

/** "week", "calendar month", "4-week period": the noun for one period. */
export function periodNoun(a: ClassAllowance): string {
  if (a.basis === "week") return "week";
  if (a.basis === "month") return "calendar month";
  return `${a.weeks}-week period`;
}

/** How a plan's allowance reads wherever the plan is listed: "4 each week", "4 every 4 weeks", or "Unlimited". */
export function classLimitText(a: ClassAllowance | null): string {
  if (!a) return "Unlimited";
  return `${a.limit} ${basisText(a)}`;
}

/** The same with the noun, for running text: "4 classes every 4 weeks", "Unlimited classes". */
export function classLimitLongText(a: ClassAllowance | null): string {
  if (!a) return "Unlimited classes";
  return `${a.limit} ${a.limit === 1 ? "class" : "classes"} ${basisText(a)}`;
}

/** Sort key: classes per week on average; Unlimited is the largest. */
export function classLimitSortValue(a: ClassAllowance | null): number {
  if (!a) return Number.MAX_SAFE_INTEGER;
  if (a.basis === "week") return a.limit;
  if (a.basis === "month") return a.limit / (365.25 / 12 / 7);
  return a.limit / a.weeks;
}

// ── The period (T7) ──────────────────────────────────────────────────────────
//
// Arithmetic is done on WALL-CLOCK minutes in the club's zone, not instants:
// a session is the minute count of its calendar date and start time as if that
// wall clock were UTC. Period boundaries are calendar dates at 00:00 on the
// same scale, so the clock changes in March and October never move them.

const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;

/** A session slot as stored: ClassInstance.date (a calendar-day marker) and "HH:mm". */
export type SessionSlot = { date: Date; startTime: string };

/** A wall-clock date and time in the club's zone, for copy: { date: "2026-11-03", time: "18:00" }. */
export type LocalSlot = { date: string; time: string };

function hhmmMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Wall-clock minute of a session. The calendar day is the UTC midnight
 * NEAREST the stored marker, the same rule lib/class-time.ts dayMarkerUtc uses
 * (writers spell one date as 00:00Z, 23:00Z the day before, or 16:00Z).
 */
export function slotMinute(s: SessionSlot): number {
  const day = Math.round(s.date.getTime() / DAY_MS);
  return day * MINUTES_PER_DAY + hhmmMinutes(s.startTime);
}

/** The same scale for "now", read in the club's zone. */
export function nowMinute(now: Date, timeZone: string): number {
  return Math.floor((now.getTime() + zoneOffsetMs(now, timeZone)) / 60_000);
}

/** Back from a wall-clock minute to a date and time for copy. */
export function minuteToLocal(minute: number): LocalSlot {
  const d = new Date(minute * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** 00:00 of a "YYYY-MM-DD" on the wall-clock minute scale. */
export function dateMinute(iso: IsoDate): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 60_000;
}

/** A period on the wall-clock minute scale: half-open [start, end). */
export type Period = { start: number; end: number };

/**
 * The period that contains `minute` under allowance `a`.
 *  - week: Monday 00:00 to the next Monday 00:00;
 *  - month: the 1st 00:00 to the next 1st 00:00;
 *  - every N weeks: anchor + k × N × 7 days, for the k whose period holds the
 *    minute (k may be negative: a class before the anchor date still falls in
 *    some period, so nothing is ever unjudged).
 */
export function periodContaining(a: ClassAllowance, minute: number): Period {
  const day = Math.floor(minute / MINUTES_PER_DAY);
  if (a.basis === "week") {
    const dow = (new Date(day * DAY_MS).getUTCDay() + 6) % 7; // Monday = 0
    const start = (day - dow) * MINUTES_PER_DAY;
    return { start, end: start + 7 * MINUTES_PER_DAY };
  }
  if (a.basis === "month") {
    const d = new Date(day * DAY_MS);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    return { start: Date.UTC(y, m, 1) / 60_000, end: Date.UTC(y, m + 1, 1) / 60_000 };
  }
  const span = a.weeks * 7 * MINUTES_PER_DAY;
  const anchor = dateMinute(a.anchor);
  const k = Math.floor((minute - anchor) / span);
  const start = anchor + k * span;
  return { start, end: start + span };
}

/** Visits (wall-clock minutes) inside the period. */
export function countInPeriod(visits: readonly number[], p: Period): number {
  let n = 0;
  for (const v of visits) if (v >= p.start && v < p.end) n += 1;
  return n;
}

export type AllowanceVerdict = {
  used: number;
  limit: number;
  basis: AllowanceBasis;
  /** Set for the every-N-weeks basis. */
  weeks?: number;
  /** used >= limit: admitting this session would exceed the allowance. */
  exhausted: boolean;
  /** The period the judged session falls in, as calendar dates (end is exclusive). */
  period: { start: IsoDate; end: IsoDate };
  /** The calendar date the allowance resets (the period's end). */
  resetsOn: IsoDate;
  /**
   * Whether the judged period is the one containing now (club clock). Set
   * when the caller passes `now`; false makes the copy name the period
   * ("the week of Monday 13 October") instead of saying "this week".
   */
  current?: boolean;
};

/**
 * Whether one more class at `session` fits the allowance, given the member's
 * other counted visits (wall-clock minutes; the judged session must not be
 * among them). Order-independent: a visit recorded later for an earlier class
 * lands in that class's own period. `now` (the club's wall-clock minute)
 * only decides `current`, never the count.
 */
export function allowanceVerdict(a: ClassAllowance, session: number, visits: readonly number[], now?: number): AllowanceVerdict {
  const p = periodContaining(a, session);
  const used = countInPeriod(visits, p);
  return {
    used,
    limit: a.limit,
    basis: a.basis,
    ...(a.basis === "weeks" ? { weeks: a.weeks } : {}),
    exhausted: used >= a.limit,
    period: { start: minuteToLocal(p.start).date, end: minuteToLocal(p.end).date },
    resetsOn: minuteToLocal(p.end).date,
    ...(now !== undefined ? { current: now >= p.start && now < p.end } : {}),
  };
}

/**
 * What the member portal shows: the period containing now. `visits` are the
 * member's counted rows; a class later today that is already recorded counts,
 * exactly as the next check-in will count it.
 */
export function currentPeriodUsage(a: ClassAllowance, now: number, visits: readonly number[]): AllowanceVerdict {
  return allowanceVerdict(a, now, visits);
}

// ── Wording of counts, dates and refusals ────────────────────────────────────

type VerdictCopy = Pick<AllowanceVerdict, "used" | "limit" | "basis" | "resetsOn"> & {
  weeks?: number;
  period?: AllowanceVerdict["period"];
  current?: boolean;
};

function asAllowance(v: VerdictCopy): ClassAllowance {
  if (v.basis === "weeks") return { limit: v.limit, basis: "weeks", weeks: v.weeks ?? 2, anchor: "1970-01-05" };
  return { limit: v.limit, basis: v.basis };
}

/** "Monday 3 November", or with the year "Monday 3 November 2026". */
export function dateText(iso: IsoDate, withYear = false): string {
  const [y, m, d] = iso.split("-").map(Number);
  const text = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  // en-GB puts a comma before a year ("Tuesday, 17 November 2026"); the year is appended plainly instead.
  return withYear ? `${text} ${y}` : text;
}

/** The last calendar day of a half-open period, for "Monday 20 October to Sunday 16 November". */
export function lastDayText(endExclusive: IsoDate, withYear = false): string {
  return dateText(minuteToLocal(dateMinute(endExclusive) - MINUTES_PER_DAY).date, withYear);
}

/**
 * "this week", "this month", "this 4-week period" — or, when the judged
 * period is known NOT to contain now (a mark for a past or future session),
 * the period by name: "the week of Monday 13 October", "October",
 * "the 4-week period from Monday 28 September". A member reads their
 * entitlement from this, so a period must never be called "this" when it
 * is not (review gap 5, 21 Oct 2026).
 */
export function thisPeriodText(v: VerdictCopy): string {
  const a = asAllowance(v);
  if (v.current === false && v.period) {
    if (a.basis === "week") return `the week of ${dateText(v.period.start)}`;
    if (a.basis === "month") {
      const [y, m] = v.period.start.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
    }
    return `the ${periodNoun(a)} from ${dateText(v.period.start)}`;
  }
  return a.basis === "month" ? "this month" : `this ${periodNoun(a)}`;
}

/**
 * The count, worded once for the portal, the doors and the questions:
 *  - "2 of 4 classes used this week"
 *  - "4 of 4 classes used this 4-week period (6 recorded)" when more than the
 *    allowance has been recorded (a lowered limit, or desk overrides) — it
 *    never reads "6 of 4".
 */
export function allowanceCountPhrase(v: VerdictCopy): string {
  const n = Math.max(0, Math.floor(v.used));
  const noun = v.limit === 1 ? "class" : "classes";
  const where = thisPeriodText(v);
  if (n > v.limit) return `${v.limit} of ${v.limit} ${noun} used ${where} (${n} recorded)`;
  return `${n} of ${v.limit} ${noun} used ${where}`;
}

/**
 * The member portal's line for the plan card and the schedule:
 * "2 of 4 classes used this 4-week period — resets Monday 17 November".
 */
export function allowanceUsageText(v: VerdictCopy): string {
  return `${allowanceCountPhrase(v)} — resets ${dateText(v.resetsOn)}`;
}

/**
 * What the member app, the kiosk and the parent's check-in say: "4 of 4
 * classes used this 4-week period; it resets on Monday 17 November. Ask staff
 * if you need to train before then." A parent checking in a child passes the
 * child's name: "Sam: 4 of 4 classes ... Ask staff if Sam needs to train
 * before then."
 */
export function allowanceRefusalSentence(v: VerdictCopy, who?: string | null): string {
  const usage = allowanceCountPhrase(v);
  const lead = who ? `${who}: ${usage}` : usage;
  const subject = who ? `${who} needs` : "you need";
  return `${lead}; it resets on ${dateText(v.resetsOn)}. Ask staff if ${subject} to train before then.`;
}

/**
 * What booking adds when the session's period is already used up. Booking
 * consumes nothing and is never refused for the allowance, but the member
 * should know what will happen at the door.
 */
export function allowanceBookingNotice(v: VerdictCopy): string {
  return `${allowanceCountPhrase(v)}. Booking doesn't use a class, but checking in before ${dateText(v.resetsOn)} will need a class-pack credit or staff to admit you.`;
}

/** The question the register, the card scanner and the coach tick put to staff. */
export function allowanceAskSentence(memberName: string, v: VerdictCopy): string {
  const n = Math.max(0, Math.floor(v.used));
  const noun = v.limit === 1 ? "class" : "classes";
  const where = thisPeriodText(v);
  const over = n > v.limit;
  const count = over
    ? `${v.limit === 1 ? "their 1 class" : `all ${v.limit} classes`} ${where}`
    : `${n} of ${v.limit} ${noun} ${where}`;
  const extras = [over ? `${n} recorded` : null, `resets on ${dateText(v.resetsOn)}`].filter((x): x is string => x !== null);
  return `${memberName} has used ${count} (${extras.join("; ")}). Admit anyway?`;
}

/**
 * The plain-language summary the plan editor shows before saving, and the
 * actual dates: "Attend up to 4 classes during each 4-week period. The current
 * period runs Monday 20 October to Sunday 16 November 2026; the next reset is
 * Monday 17 November 2026." `now` is a wall-clock minute in the club's zone.
 */
export function allowanceSummary(a: ClassAllowance | null, now: number): { sentence: string; period: string | null; nextReset: IsoDate | null } {
  if (!a) return { sentence: "Unlimited classes. Members on this plan can attend any class their membership includes.", period: null, nextReset: null };
  const p = periodContaining(a, now);
  const start = minuteToLocal(p.start).date;
  const end = minuteToLocal(p.end).date;
  const noun = a.limit === 1 ? "class" : "classes";
  const during = a.basis === "month" ? "each calendar month" : `each ${periodNoun(a)}`;
  return {
    sentence: `Attend up to ${a.limit} ${noun} during ${during}. The next reset is ${dateText(end, true)}.`,
    period: `The current period runs ${dateText(start)} to ${lastDayText(end, true)}.`,
    nextReset: end,
  };
}

/**
 * How a door treats a member whose allowance is used up, as T6a's tier gate:
 *  - "refuse": member-decided doors (member app, parent, kiosk);
 *  - "ask": staff doors (register, card scanner, coach tick) — refused with an
 *    askable answer unless staff confirmed, then admitted and recorded;
 *  - "off": not checked (system paths, tests).
 * Unlike class eligibility, an allowance can be overridden by staff: it is a
 * usage count the club may choose to waive, not a rule about who may attend.
 */
export type AllowanceGateMode = "refuse" | "ask" | "off";

/** The override reason recorded when staff admit someone past their allowance. */
export const ALLOWANCE_OVERRIDE_REASON = "allowance_reached" as const;

// ── Write side (both membership routes) ──────────────────────────────────────

export const classLimitSchema = z.number().int().min(CLASS_LIMIT_MIN).max(CLASS_LIMIT_MAX);
export const classLimitBasisSchema = z.enum(ALLOWANCE_BASES);
export const classLimitWeeksSchema = z.number().int().min(CLASS_LIMIT_WEEKS_MIN).max(CLASS_LIMIT_WEEKS_MAX);
export const classLimitAnchorSchema = z.string().regex(ISO_DATE, "Period start must be a date (YYYY-MM-DD)").refine(
  (s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s,
  "Period start must be a real calendar date",
);

export const PAIR_MESSAGE =
  "Set the number of classes together with how often it resets (each week, each month, or every N weeks from a start date), or clear all of them for Unlimited";
export const WEEKS_MESSAGE = "Every N weeks needs the number of weeks (2 to 8) and the date the periods count from";
export const LEGACY_MIX_MESSAGE =
  "Send the class allowance as classes and a reset basis only, not together with the old classes-per-week field";

export type AllowanceInput = {
  classLimit?: number | null;
  classLimitBasis?: AllowanceBasis | null;
  classLimitWeeks?: number | null;
  classLimitAnchor?: string | null;
  maxClassesPerWeek?: number | null;
};

/**
 * zod superRefine for a create or PATCH body: the allowance travels as a set
 * (limit + basis, plus weeks + anchor for "weeks"); clearing sends nulls; the
 * legacy `maxClassesPerWeek` (still accepted, from a page loaded before this
 * release) is never mixed with it.
 */
export function refineAllowance(data: AllowanceInput, ctx: z.RefinementCtx): void {
  const keys = ["classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor"] as const;
  const sent = keys.filter((k) => data[k] !== undefined);
  const hasLegacy = data.maxClassesPerWeek !== undefined;
  if (hasLegacy && sent.length > 0) {
    ctx.addIssue({ code: "custom", path: ["classLimit"], message: LEGACY_MIX_MESSAGE });
    return;
  }
  if (sent.length === 0) return;
  const limit = data.classLimit ?? null;
  const basis = data.classLimitBasis ?? null;
  if (data.classLimit === undefined || data.classLimitBasis === undefined || (limit === null) !== (basis === null)) {
    ctx.addIssue({ code: "custom", path: ["classLimitBasis"], message: PAIR_MESSAGE });
    return;
  }
  if (basis === "weeks") {
    if (data.classLimitWeeks == null || data.classLimitAnchor == null) {
      ctx.addIssue({ code: "custom", path: ["classLimitWeeks"], message: WEEKS_MESSAGE });
    }
  } else if ((data.classLimitWeeks ?? null) !== null || (data.classLimitAnchor ?? null) !== null) {
    ctx.addIssue({ code: "custom", path: ["classLimitWeeks"], message: PAIR_MESSAGE });
  }
}

export type AllowanceColumns = {
  classLimit: number | null;
  classLimitBasis: AllowanceBasis | null;
  classLimitWeeks: number | null;
  /** A Date for Prisma's @db.Date column (UTC midnight of the calendar date). */
  classLimitAnchor: Date | null;
  maxClassesPerWeek: number | null;
};

const CLEARED: AllowanceColumns = { classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null };

/**
 * The columns to write for a body that passed `refineAllowance`, or null when
 * the body did not touch the allowance (leave every column alone). A weekly
 * allowance mirrors N into `maxClassesPerWeek`; any other basis sets it NULL.
 */
export function allowanceColumns(data: AllowanceInput): AllowanceColumns | null {
  if (data.classLimit !== undefined) {
    const limit = data.classLimit;
    const basis = data.classLimitBasis ?? null;
    if (limit === null || basis === null) return { ...CLEARED };
    if (basis === "weeks") {
      return {
        classLimit: limit,
        classLimitBasis: "weeks",
        classLimitWeeks: data.classLimitWeeks ?? null,
        classLimitAnchor: data.classLimitAnchor ? new Date(`${data.classLimitAnchor}T00:00:00.000Z`) : null,
        maxClassesPerWeek: null,
      };
    }
    return { classLimit: limit, classLimitBasis: basis, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: basis === "week" ? limit : null };
  }
  if (data.maxClassesPerWeek !== undefined) {
    const m = data.maxClassesPerWeek;
    return m === null ? { ...CLEARED } : { classLimit: m, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: m };
  }
  return null;
}

/** Audit / undo field names for the allowance. */
export const ALLOWANCE_FIELDS = ["maxClassesPerWeek", "classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor"] as const;
