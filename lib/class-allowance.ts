/**
 * T7c (Sean note 5, "max 4 classes every 4 weeks allows for multiple classes
 * in 1 week"): a membership tier's class allowance, defined once.
 *
 * Owner decision (Noe, 17 Oct 2026; Sean may change it): each tier has an
 * optional allowance of N classes (`classLimit`, 1-60) every M weeks
 * (`classLimitWeeks`, 1-8). Blank = Unlimited. The window is ROLLING: the
 * M x 7 days ending at the start of the session being attended, so several
 * classes in one week are fine while the rolling total stays within N.
 *
 * This module is pure: configuration, the rolling-window arithmetic and the
 * wording. The check-in engine (lib/checkin.ts, T7) enforces the allowance
 * with these functions, under the Member row lock, from one database read
 * (lib/class-allowance-count.ts).
 *
 * ── Reader rule (why `maxClassesPerWeek` still matters) ──────────────────────
 * The previous build reads and edits only `maxClassesPerWeek`. The routes keep
 * the three columns in step on every write: a weekly allowance mirrors N into
 * `maxClassesPerWeek`; a multi-week allowance or Unlimited sets it NULL. So:
 *
 *   1. `maxClassesPerWeek` not null  -> N per 1 week. This is either a value
 *      from before T7c (all Total BJJ tiers were NULL on 15 Oct, so in
 *      practice the demo tier), the mirror of a weekly allowance, or a value
 *      the previous build wrote during a rollback. In every case it is the
 *      last word on the plan, so it wins.
 *   2. else `classLimit` and `classLimitWeeks` both set -> N every M weeks.
 *   3. else Unlimited.
 *
 * A weekly `classLimit` with a NULL `maxClassesPerWeek` can only exist when
 * the previous build cleared the limit during a rollback; rule 2 would then
 * resurrect it, so a weekly allowance is read from `maxClassesPerWeek` alone.
 *
 * The database keeps the pair together (`MembershipTier_classLimit_pair_check`,
 * migration 20261017052858_tier_class_allowance) and the ranges below.
 */
import { z } from "zod";
import { zoneOffsetMs } from "@/lib/class-time";

export const CLASS_LIMIT_MIN = 1;
export const CLASS_LIMIT_MAX = 60;
export const CLASS_LIMIT_WEEKS_MIN = 1;
export const CLASS_LIMIT_WEEKS_MAX = 8;

/** The "every" choices the plan editor offers, in order. */
export const CLASS_LIMIT_WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export type ClassAllowance = { limit: number; weeks: number };

export type TierAllowanceColumns = {
  classLimit?: number | null;
  classLimitWeeks?: number | null;
  maxClassesPerWeek?: number | null;
};

/** The allowance a tier carries under the reader rule above; null = Unlimited. */
export function tierAllowance(t: TierAllowanceColumns | null | undefined): ClassAllowance | null {
  if (!t) return null;
  if (t.maxClassesPerWeek != null) return { limit: t.maxClassesPerWeek, weeks: 1 };
  if (t.classLimit != null && t.classLimitWeeks != null && t.classLimitWeeks > 1) {
    return { limit: t.classLimit, weeks: t.classLimitWeeks };
  }
  return null;
}

/** "1 week", "4 weeks". */
export function weeksText(weeks: number): string {
  return weeks === 1 ? "1 week" : `${weeks} weeks`;
}

/**
 * How a plan's allowance reads wherever the plan is shown: "4 every 4 weeks",
 * "3 every week", or "Unlimited".
 */
export function classLimitText(a: ClassAllowance | null): string {
  if (!a) return "Unlimited";
  return a.weeks === 1 ? `${a.limit} every week` : `${a.limit} every ${a.weeks} weeks`;
}

/** The same with the noun, for running text: "4 classes every 4 weeks", "Unlimited classes". */
export function classLimitLongText(a: ClassAllowance | null): string {
  if (!a) return "Unlimited classes";
  const noun = a.limit === 1 ? "class" : "classes";
  return a.weeks === 1 ? `${a.limit} ${noun} every week` : `${a.limit} ${noun} every ${a.weeks} weeks`;
}

/** Sort key: classes per week on average; Unlimited is the largest. */
export function classLimitSortValue(a: ClassAllowance | null): number {
  return a ? a.limit / a.weeks : Number.MAX_SAFE_INTEGER;
}

/**
 * The member portal's line for the plan card and the schedule:
 * "2 of 4 classes used in the last 4 weeks", "1 of 1 class used in the last
 * week". Null for an Unlimited plan (nothing to count against). `used` is the
 * number the check-in engine counts (T7); this helper only words it.
 */
export function allowanceUsageText(used: number, a: ClassAllowance | null): string | null {
  if (!a) return null;
  const n = Math.max(0, Math.floor(used));
  const noun = a.limit === 1 ? "class" : "classes";
  const span = a.weeks === 1 ? "week" : `${a.weeks} weeks`;
  return `${n} of ${a.limit} ${noun} used in the last ${span}`;
}

// ── The rolling window (T7) ──────────────────────────────────────────────────
//
// Owner decision (17 Oct 2026): the window is the M x 7 days ending at the
// start of the session being attended, in the club's own clock (Europe/London
// for Total BJJ). Arithmetic is done on WALL-CLOCK minutes, not instants: a
// session is the minute count of its calendar date and start time as if that
// wall clock were UTC. So "4 weeks before Monday 18:00" is Monday 18:00 four
// weeks earlier, whether or not the clocks changed in between. With instants,
// a weekly class across the March change sits 28 days minus an hour apart and
// the class four weeks back would wrongly still count.
//
// The window is half-open, (S - span, S]: a session exactly M weeks earlier at
// the same time has dropped out, so a member on "4 every 4 weeks" who trains
// every Monday at 18:00 is admitted every Monday. A session starting at the
// same minute as S counts (two classes at once cannot both be admitted on the
// last place).
//
// Exact rolling rule. Check-ins are normally in time order, and then the only
// window that matters is the one ending at S. But a later session can be
// recorded first (a staff mark for this evening, then a check-in to this
// morning's class), and judging the morning class only by the window ending
// at its own start would let the pair exceed N inside one window. So an
// admission at S must keep EVERY window of length M weeks that contains S
// within N: `windowUsed` takes the busiest window containing S. In the usual
// case (nothing recorded after S) that is exactly the window ending at S.

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

function spanMinutes(weeks: number): number {
  return weeks * 7 * MINUTES_PER_DAY;
}

/** Visits in (end - span, end]. */
function countInWindow(visits: readonly number[], end: number, span: number): number {
  let n = 0;
  for (const v of visits) if (v > end - span && v <= end) n += 1;
  return n;
}

/**
 * The busiest window of length M weeks that contains S, counting only the
 * other visits (the session being judged is not among them). Windows ending
 * at S and at each recorded visit in [S, S + span) are enough: the count only
 * rises at a visit.
 */
export function windowUsed(a: ClassAllowance, session: number, visits: readonly number[]): number {
  const span = spanMinutes(a.weeks);
  let used = countInWindow(visits, session, span);
  for (const v of visits) {
    if (v >= session && v < session + span) used = Math.max(used, countInWindow(visits, v, span));
  }
  return used;
}

export type AllowanceVerdict = {
  used: number;
  limit: number;
  weeks: number;
  /** used >= limit: admitting this session would exceed the allowance. */
  exhausted: boolean;
  /** When exhausted: the first session time from which a class is free again. */
  nextFree: LocalSlot | null;
};

/**
 * Whether one more class at `session` fits the allowance, given the member's
 * other counted visits (wall-clock minutes). `nextFree` is the earliest time
 * at which the oldest visit holding the window has dropped out and the
 * busiest window is below N again, assuming nothing else is recorded.
 */
export function allowanceVerdict(a: ClassAllowance, session: number, visits: readonly number[]): AllowanceVerdict {
  const used = windowUsed(a, session, visits);
  const exhausted = used >= a.limit;
  let nextFree: LocalSlot | null = null;
  if (exhausted) {
    const span = spanMinutes(a.weeks);
    const candidates = [...new Set(visits.map((v) => v + span))].filter((x) => x > session).sort((x, y) => x - y);
    for (const x of candidates) {
      if (windowUsed(a, x, visits) < a.limit) {
        nextFree = minuteToLocal(x);
        break;
      }
    }
  }
  return { used, limit: a.limit, weeks: a.weeks, exhausted, nextFree };
}

/** What the member portal shows: classes counted in the window ending now. */
export function usedInLastWeeks(a: ClassAllowance, now: number, visits: readonly number[]): number {
  return countInWindow(visits, now, spanMinutes(a.weeks));
}

/**
 * How a door treats a member whose allowance is used up, as T6a's tier gate:
 *  - "refuse": member-decided doors (member app, parent, kiosk, booking);
 *  - "ask": staff doors (register, card scanner, coach tick) - refused with an
 *    askable answer unless staff confirmed, then admitted and recorded;
 *  - "off": not checked (system paths, tests).
 */
export type AllowanceGateMode = "refuse" | "ask" | "off";

/** The override reason recorded when staff admit someone past their allowance. */
export const ALLOWANCE_OVERRIDE_REASON = "allowance_reached" as const;

/** "Monday 3 November from 18:00". */
export function nextFreeText(slot: LocalSlot): string {
  const [y, m, d] = slot.date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  return `${day} from ${slot.time}`;
}

type VerdictCopy = Pick<AllowanceVerdict, "used" | "limit" | "weeks" | "nextFree">;

/**
 * What the member app, the kiosk and booking say: "4 of 4 classes used in the
 * last 4 weeks; next free on Monday 3 November from 18:00. Ask staff if you
 * need to train before then."
 */
export function allowanceRefusalSentence(v: VerdictCopy): string {
  const usage = allowanceUsageText(v.used, { limit: v.limit, weeks: v.weeks }) ?? "";
  return v.nextFree
    ? `${usage}; next free on ${nextFreeText(v.nextFree)}. Ask staff if you need to train before then.`
    : `${usage}. Ask staff if you need to train.`;
}

/** The question the register, the card scanner and the coach tick put to staff. */
export function allowanceAskSentence(memberName: string, v: VerdictCopy): string {
  const noun = v.limit === 1 ? "class" : "classes";
  const span = v.weeks === 1 ? "week" : `${v.weeks} weeks`;
  const next = v.nextFree ? ` (next free on ${nextFreeText(v.nextFree)})` : "";
  return `${memberName} has used ${v.used} of ${v.limit} ${noun} in the last ${span}${next}. Admit anyway?`;
}

// ── Write side (both membership routes) ──────────────────────────────────────

export const classLimitSchema = z.number().int().min(CLASS_LIMIT_MIN).max(CLASS_LIMIT_MAX);
export const classLimitWeeksSchema = z.number().int().min(CLASS_LIMIT_WEEKS_MIN).max(CLASS_LIMIT_WEEKS_MAX);

export const PAIR_MESSAGE =
  "Set both the number of classes and how many weeks, or leave both blank for Unlimited";
export const LEGACY_MIX_MESSAGE =
  "Send the class allowance as classes and weeks only, not together with the old classes-per-week field";

type AllowanceInput = {
  classLimit?: number | null;
  classLimitWeeks?: number | null;
  maxClassesPerWeek?: number | null;
};

/**
 * zod superRefine for a create or PATCH body: the pair travels together, and
 * the legacy `maxClassesPerWeek` (still accepted, from a page loaded before
 * this release) is never mixed with it.
 */
export function refineAllowance(data: AllowanceInput, ctx: z.RefinementCtx): void {
  const hasLimit = data.classLimit !== undefined;
  const hasWeeks = data.classLimitWeeks !== undefined;
  const hasLegacy = data.maxClassesPerWeek !== undefined;
  if (hasLegacy && (hasLimit || hasWeeks)) {
    ctx.addIssue({ code: "custom", path: ["classLimit"], message: LEGACY_MIX_MESSAGE });
    return;
  }
  if (hasLimit !== hasWeeks || (hasLimit && (data.classLimit === null) !== (data.classLimitWeeks === null))) {
    ctx.addIssue({ code: "custom", path: ["classLimitWeeks"], message: PAIR_MESSAGE });
  }
}

export type AllowanceColumns = {
  classLimit: number | null;
  classLimitWeeks: number | null;
  maxClassesPerWeek: number | null;
};

/**
 * The three columns to write for a body that passed `refineAllowance`, or
 * null when the body did not touch the allowance (leave all three alone).
 * A weekly allowance mirrors N into `maxClassesPerWeek`; anything else sets it
 * NULL, so the previous build shows a multi-week plan as Unlimited rather than
 * as a wrong "N/wk".
 */
export function allowanceColumns(data: AllowanceInput): AllowanceColumns | null {
  if (data.classLimit !== undefined) {
    const limit = data.classLimit;
    const weeks = data.classLimitWeeks ?? null;
    if (limit === null || weeks === null) return { classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null };
    return { classLimit: limit, classLimitWeeks: weeks, maxClassesPerWeek: weeks === 1 ? limit : null };
  }
  if (data.maxClassesPerWeek !== undefined) {
    const m = data.maxClassesPerWeek;
    return m === null
      ? { classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null }
      : { classLimit: m, classLimitWeeks: 1, maxClassesPerWeek: m };
  }
  return null;
}

/** Audit / undo field names for the allowance. */
export const ALLOWANCE_FIELDS = ["maxClassesPerWeek", "classLimit", "classLimitWeeks"] as const;
