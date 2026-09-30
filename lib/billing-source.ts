/**
 * Who collects a member's money (readiness spec v3 §7, TeamUp bridge).
 *
 * While Total BJJ runs its day in MatFlow, TeamUp keeps collecting every
 * existing membership. A member imported from TeamUp is `billedBy: "teamup"`
 * and carries the date of the export its standing came from. MatFlow must not
 * start, change or stop that collection, and its screens must say so.
 *
 * Pure: no server imports, safe in client components. The server-side refusal
 * lives in `lib/billing-source-server.ts`.
 * Contract: docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md.
 */

export const BILLED_BY = ["matflow", "teamup"] as const;
export type BilledBy = (typeof BILLED_BY)[number];

/** Standing older than this is shown to staff as stale; it never refuses a check-in. */
export const BILLING_STATUS_STALE_AFTER_DAYS = 8;

export const BILLED_ELSEWHERE_REFUSAL =
  "Billed by TeamUp — change this in TeamUp; MatFlow updates at the next status refresh.";

export const HOLD_ACCESS_ONLY_NOTE =
  "This pauses access in MatFlow only. Pause the membership in TeamUp too, or TeamUp keeps collecting.";

export const CHASE_ELSEWHERE_NOTE =
  "TeamUp sends its own payment reminders for this member. Send this one only if you mean to add to them.";

export function isBilledElsewhere(m: { billedBy?: string | null } | null | undefined): boolean {
  return m?.billedBy === "teamup";
}

function toDate(d: Date | string | null | undefined): Date | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
}

/** True when the standing is more than the threshold old. Unknown dates are not stale — they are shown as unknown. */
export function isBillingStatusStale(asOf: Date | string | null | undefined, now: Date = new Date()): boolean {
  const d = toDate(asOf);
  if (!d) return false;
  return now.getTime() - d.getTime() > BILLING_STATUS_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/** "Billed by TeamUp · status as of 3 Oct 2026", or null for a member MatFlow bills. */
export function billingSourceLabel(
  m: { billedBy?: string | null; billingStatusAsOf?: Date | string | null } | null | undefined,
): string | null {
  if (!isBilledElsewhere(m)) return null;
  const d = toDate(m?.billingStatusAsOf ?? null);
  const when = d ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "unknown";
  return `Billed by TeamUp · status as of ${when}`;
}

/** Staff-facing warning when the standing is stale, else null. */
export function staleBillingWarning(
  m: { billedBy?: string | null; billingStatusAsOf?: Date | string | null } | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!isBilledElsewhere(m) || !isBillingStatusStale(m?.billingStatusAsOf ?? null, now)) return null;
  const d = toDate(m?.billingStatusAsOf ?? null)!;
  return `Billing status last updated ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} — check TeamUp before relying on it.`;
}
