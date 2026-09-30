/**
 * One place that turns a check-in refusal into an HTTP answer, so every door
 * (member sheet, kiosk, register) reads the same sentence AND the same machine
 * `reason`. The customer simulation of 26 Sep 2026 (F-6) found the member
 * sheet treating any 409 as success because only some refusals carried a
 * `reason`; the sheet had nothing better than the status code to go on.
 *
 * Pure: no I/O, no Next imports, unit-tested in tests/unit/checkin-refusal.test.ts.
 */
import type { PerformCheckinResult as CheckinResult } from "@/lib/checkin";

export type CheckinRefusalReason =
  | "class_not_found"
  | "class_cancelled"
  | "rank_below"
  | "rank_above"
  | "outside_window"
  | "no_coverage"
  | "class_full"
  | "already_checked_in"
  | "roster_not_listed"
  | "waiver_unsigned"
  | "on_hold"
  | "kids_class"
  | "venue_not_covered"
  | "member_not_found";

export type CheckinRefusal = {
  status: 402 | 403 | 404 | 409;
  body: { error: string; reason: CheckinRefusalReason };
};

function ukDate(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * What an adult (or a parent signing themselves in) reads at a kids class:
 * the rule and the next step, not only "This is a kids class." (end-user
 * check, 30 Sep 2026). The kiosk route sends the same sentence.
 */
export const KIDS_CLASS_REFUSAL = "This is a kids class — adults can't check in to it. Choose an adult class.";

/**
 * Returns the refusal for a non-success result, or null for `success` and
 * `error` (the route handles those itself). Sentences are the customer-facing
 * copy; do not shorten them — the numbers and dates are what a member argues
 * with at the desk.
 */
export function checkinRefusal(
  result: CheckinResult,
  club: { paymentRail?: string | null } = {},
): CheckinRefusal | null {
  switch (result.kind) {
    case "class_not_found":
      return { status: 404, body: { error: "Class not found", reason: "class_not_found" } };
    case "class_cancelled":
      return { status: 409, body: { error: "Class has been cancelled", reason: "class_cancelled" } };
    case "rank_below":
      return { status: 403, body: { error: "Your current rank is below this class's required rank.", reason: "rank_below" } };
    case "rank_above":
      return { status: 403, body: { error: "Your current rank is above this class's maximum rank.", reason: "rank_above" } };
    case "outside_window":
      return {
        status: 409,
        // The club's own window (Settings → "Check-in opens / closes"), not a
        // hardcoded 30: a club that set 180 was told "until 30 min after class"
        // (end-user simulation, 30 Sep 2026).
        body: {
          error: `Check-in is only available from ${result.beforeMin ?? 30} min before until ${result.afterMin ?? 30} min after class.`,
          reason: "outside_window",
        },
      };
    case "no_coverage":
      return {
        status: 402,
        body: {
          // A pay-at-desk club sells nothing online, so "Buy a pack" sent a
          // parent looking for a shop that does not exist (end-user round 2,
          // 3.8 / 6.4). There the only way to a plan is the desk.
          error:
            club.paymentRail === "pay_at_desk"
              ? "No plan yet — ask the desk to add one."
              : "No active membership or class pack credits. Buy a pack or contact your gym.",
          reason: "no_coverage",
        },
      };
    case "class_full":
      return {
        status: 409,
        body: {
          error: `This class is full — ${result.taken} of ${result.maxCapacity} places are taken. Ask staff if there is room.`,
          reason: "class_full",
        },
      };
    case "duplicate":
      return { status: 409, body: { error: "Already checked in", reason: "already_checked_in" } };
    case "roster_not_listed":
      return { status: 403, body: { error: "You're not on the roster for this class.", reason: "roster_not_listed" } };
    case "waiver_unsigned":
      return {
        status: 403,
        body: {
          error: "A signed waiver is needed before checking in. Sign it in your profile (for a child, from Family) or ask your gym.",
          reason: "waiver_unsigned",
        },
      };
    case "on_hold":
      return {
        status: 403,
        body: {
          error: result.holdUntil
            ? `This membership is on hold until ${ukDate(result.holdUntil)}. Ask your gym to resume it early if you want to train before then.`
            : "This membership is on hold. Ask your gym to resume it.",
          reason: "on_hold",
        },
      };
    case "kids_class":
      return { status: 403, body: { error: KIDS_CLASS_REFUSAL, reason: "kids_class" } };
    case "venue_not_covered":
      return {
        status: 403,
        body: {
          error: `Your membership covers ${result.tierVenue}; this class is at ${result.classVenue}. Ask your gym about training there.`,
          reason: "venue_not_covered",
        },
      };
    case "member_not_found":
      return { status: 404, body: { error: "Member not found", reason: "member_not_found" } };
    default:
      return null;
  }
}
