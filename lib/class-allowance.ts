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
 * This module is configuration and wording only. Nothing here enforces the
 * allowance; the check-in engine does that in T7.
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
