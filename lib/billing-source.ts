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

export const BILLED_ELSEWHERE_REFUSAL =
  "Billed by TeamUp — change the billing in TeamUp. MatFlow is not updated automatically: a later TeamUp upload lists any difference for you to review.";

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

/**
 * "Imported from TeamUp on 3 Oct 2026" (owner decision, 27 Oct 2026). Imports
 * no longer update an existing member, so the date is the one import that
 * brought the member over and never moves. It used to read "status as of",
 * with an 8-day staleness warning that, once the date stopped moving, would
 * have stayed on for good; both are retired. Null for a member MatFlow bills.
 */
export function importedFromTeamUpLabel(
  m: { billedBy?: string | null; billingStatusAsOf?: Date | string | null } | null | undefined,
): string | null {
  if (!isBilledElsewhere(m)) return null;
  const d = toDate(m?.billingStatusAsOf ?? null);
  return d
    ? `Imported from TeamUp on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`
    : "Imported from TeamUp, date unknown";
}

/**
 * Who bills the member and when they came over, without saying TeamUp twice:
 * "Billed by TeamUp · imported 3 Oct 2026". Null for a member MatFlow bills.
 */
export function billingSourceLabel(
  m: { billedBy?: string | null; billingStatusAsOf?: Date | string | null } | null | undefined,
): string | null {
  if (!isBilledElsewhere(m)) return null;
  const d = toDate(m?.billingStatusAsOf ?? null);
  return d
    ? `Billed by TeamUp · imported ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`
    : "Billed by TeamUp · import date unknown";
}
