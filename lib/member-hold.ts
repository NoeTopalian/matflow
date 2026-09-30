/**
 * Membership holds, defined once.
 *
 * A hold is `Member.paymentStatus = "paused"` plus an optional `holdUntil`.
 * When the member has a Stripe subscription the hold is ALSO a Stripe
 * `pause_collection` with `behavior: "void"` — Stripe keeps the subscription
 * and its card, issues no invoices while paused, and resumes on `resumes_at`.
 *
 * Two facts every caller must agree on, both learnt the hard way:
 *  - pausing collection does NOT change `subscription.status` (it stays
 *    "active"), so the webhook has to read `pause_collection` itself rather
 *    than rely on a "paused" status;
 *  - `behavior` is passed explicitly. Stripe's default for the dashboard is
 *    "keep_as_draft", which would pile up unpaid invoices for the member to
 *    face on return — the opposite of a hold.
 */
import type Stripe from "stripe";

/** Longest hold the routes accept. A year is generous; longer is a cancel. */
export const HOLD_MAX_DAYS = 365;

export type HoldUntilParse =
  | { ok: true; until: Date | null }
  | { ok: false; error: string };

/**
 * `until` from the request body: absent/null means open-ended; otherwise an
 * ISO date at least a day ahead and at most HOLD_MAX_DAYS away. Returns the
 * exact message the route sends, so the copy lives here.
 */
export function parseHoldUntil(input: unknown, now: Date): HoldUntilParse {
  if (input == null || input === "") return { ok: true, until: null };
  if (typeof input !== "string") return { ok: false, error: "Hold end date must be a date" };
  const until = new Date(input);
  if (Number.isNaN(until.getTime())) return { ok: false, error: "Hold end date must be a date" };
  const dayMs = 24 * 60 * 60 * 1000;
  if (until.getTime() < now.getTime() + dayMs) {
    return { ok: false, error: "Hold end date must be at least a day from now" };
  }
  if (until.getTime() > now.getTime() + HOLD_MAX_DAYS * dayMs) {
    return { ok: false, error: `Holds run for at most ${HOLD_MAX_DAYS} days — cancel the membership instead` };
  }
  return { ok: true, until };
}

/** Stripe params that start a hold on a subscription. */
export function pauseCollectionParams(until: Date | null): Stripe.SubscriptionUpdateParams {
  return {
    pause_collection: {
      behavior: "void",
      ...(until ? { resumes_at: Math.floor(until.getTime() / 1000) } : {}),
    },
  };
}

/** Stripe params that end a hold. An empty string clears the field. */
export const RESUME_COLLECTION_PARAMS: Stripe.SubscriptionUpdateParams = { pause_collection: "" };

/**
 * What a `customer.subscription.updated` payload says about holds. Stripe
 * sends `pause_collection: null` when collection is running and an object
 * when it is paused; an absent field is treated as "not paused" because the
 * event carries the whole subscription.
 */
export function readPauseCollection(obj: Record<string, unknown>): { paused: boolean; resumesAt: Date | null } {
  const pc = obj.pause_collection;
  if (!pc || typeof pc !== "object") return { paused: false, resumesAt: null };
  const resumesAt = (pc as { resumes_at?: unknown }).resumes_at;
  return {
    paused: true,
    resumesAt: typeof resumesAt === "number" ? new Date(resumesAt * 1000) : null,
  };
}

/** True while a member is on hold (the date, when set, has not passed). */
export function isOnHold(member: { paymentStatus: string; holdUntil?: Date | null }, now: Date): boolean {
  if (member.paymentStatus !== "paused") return false;
  if (member.holdUntil && member.holdUntil.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The payment status a hold or resume route answered with. The profile shows
 * THIS, never a status it assumed: resuming a member who never paid comes
 * back "pending" ("No payment yet"), and the screen used to write "paid"
 * regardless until a reload (end-user check, 30 Sep 2026). null when the
 * answer does not say — the caller then re-reads the page rather than guess.
 */
export function paymentStatusFromHoldResponse(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const status = (data as { paymentStatus?: unknown }).paymentStatus;
  return typeof status === "string" && status.length > 0 ? status : null;
}
