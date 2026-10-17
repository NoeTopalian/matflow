/**
 * What a check-in answer MEANS to the person who pressed the button. Every
 * client door (member sheet, kiosk, register) decides through this one
 * function, so "signed in!" is only ever shown for a committed record or a
 * verified existing one.
 *
 * Background (customer simulation, 26 Sep 2026, F-6): the member sheet treated
 * every 409 as success, so "This class is full — 3 of 2 places are taken" was
 * shown to the parent as "Ravi Patel signed in!" with nothing recorded.
 *
 * The decision is made on the machine `reason` the server sends (see
 * lib/checkin-refusal.ts), never by parsing the sentence. A 409 with no reason
 * is a refusal we do not understand and is shown as one.
 *
 * Pure, no imports; safe in client components.
 */
export type CheckinOutcome =
  | { kind: "recorded" }
  | { kind: "already_checked_in"; message: string }
  | { kind: "refused"; message: string; reason: string | null }
  | { kind: "signed_out"; message: string }
  | { kind: "unreachable"; message: string };

const FALLBACK = "Couldn't sign you in. Please try again or ask staff.";

export function classifyCheckinResponse(status: number, body: unknown): CheckinOutcome {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; reason?: unknown };
  const message = typeof b.error === "string" && b.error.trim() ? b.error : FALLBACK;
  const reason = typeof b.reason === "string" ? b.reason : null;
  if (status >= 200 && status < 300) return { kind: "recorded" };
  if (status === 401) return { kind: "signed_out", message: "You've been signed out. Sign in again and try once more." };
  if (status === 409 && reason === "already_checked_in") {
    return { kind: "already_checked_in", message: "You're already signed in to this class." };
  }
  if (status === 0) return { kind: "unreachable", message: "Could not connect. Please try again." };
  return { kind: "refused", message, reason };
}

/**
 * What the member schedule says when a booking (or un-booking) fails. A
 * refusal the server explains (403 tier_not_included, 409 class_paused, 403
 * roster_not_listed, 409 full) is shown in the server's own words, which name
 * the class and the plan; only a failure with no sentence (network, 5xx, an
 * unreadable body) falls back to the generic line. Status 0 = no response.
 */
export function bookingFailureMessage(status: number, body: unknown, wasSubscribed: boolean): string {
  const b = (body && typeof body === "object" ? body : {}) as { error?: unknown };
  if (status >= 400 && status < 500 && status !== 401 && typeof b.error === "string" && b.error.trim()) return b.error;
  if (status === 401) return "You've been signed out. Sign in again and try once more.";
  return wasSubscribed
    ? "Couldn't unsubscribe — please try again."
    : "Couldn't book this class — please try again.";
}
