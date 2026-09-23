/**
 * The membership billing cycle, defined once.
 *
 * `MembershipTier.billingCycle` started life as `monthly | annual | none` and
 * every surface that showed or advanced it carried its own copy of that list —
 * a label map in the tier editor, a copy string in the subscribe drawer, a
 * month count in the overdue derivation, a zod enum per route. The first club
 * migrating from another platform bills some members every four weeks, and
 * widening five private lists in step is exactly how one of them gets missed.
 * So the cycle set, its labels, its calendar arithmetic and its Stripe shape
 * all come from here, and the DB CHECK (`MembershipTier_billingCycle_check`)
 * is kept in step by migration whenever this tuple changes.
 *
 * Week-based cycles step by whole days in UTC: 7, 14 and 28 days are exact and
 * cannot drift, unlike "a month". Month-based cycles keep the existing
 * end-of-month clamping in lib/overdue.ts.
 */
import { z } from "zod";

export const BILLING_CYCLES = [
  "weekly",
  "fortnightly",
  "four_weekly",
  "monthly",
  "annual",
  "none",
] as const;

export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const billingCycleSchema = z.enum(BILLING_CYCLES);

export function isBillingCycle(value: string): value is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(value);
}

/** Days per cycle for the week-based cycles; null for month-based or none. */
export function cycleDays(cycle: string): number | null {
  if (cycle === "weekly") return 7;
  if (cycle === "fortnightly") return 14;
  if (cycle === "four_weekly") return 28;
  return null;
}

/** Months per cycle for the month-based cycles; null for week-based or none. */
export function cycleMonths(cycle: string): number | null {
  if (cycle === "monthly") return 1;
  if (cycle === "annual") return 12;
  return null;
}

/** Short label for a pill or a select option: "Every 4 weeks". */
export function cycleLabel(cycle: string): string {
  switch (cycle) {
    case "weekly": return "Weekly";
    case "fortnightly": return "Fortnightly";
    case "four_weekly": return "Every 4 weeks";
    case "monthly": return "Monthly";
    case "annual": return "Annual";
    case "none": return "One-off / Drop-in";
    default: return cycle;
  }
}

/** Suffix for a price: "£40.00 a month", "£38.00 every 4 weeks", "£10.00 one-off". */
export function cyclePriceSuffix(cycle: string): string {
  switch (cycle) {
    case "weekly": return "a week";
    case "fortnightly": return "every 2 weeks";
    case "four_weekly": return "every 4 weeks";
    case "monthly": return "a month";
    case "annual": return "a year";
    default: return "one-off";
  }
}

/** Sentence tail for the subscribe confirmation: ", billed every 4 weeks until cancelled". */
export function cycleBilledCopy(cycle: string): string | null {
  switch (cycle) {
    case "weekly": return ", billed weekly until cancelled";
    case "fortnightly": return ", billed every 2 weeks until cancelled";
    case "four_weekly": return ", billed every 4 weeks until cancelled";
    case "monthly": return ", billed monthly until cancelled";
    case "annual": return ", billed yearly until cancelled";
    default: return null;
  }
}

/**
 * The Stripe `recurring` block for a cycle, or null for a non-recurring tier.
 * Stripe has no "four-weekly" interval; it is `week` with `interval_count: 4`,
 * which is also exactly what a platform migrating a 4-weekly plan needs to
 * mint so the member's charge lands every 28 days as before.
 */
export function stripeRecurring(
  cycle: string,
): { interval: "week" | "month" | "year"; interval_count: number } | null {
  switch (cycle) {
    case "weekly": return { interval: "week", interval_count: 1 };
    case "fortnightly": return { interval: "week", interval_count: 2 };
    case "four_weekly": return { interval: "week", interval_count: 4 };
    case "monthly": return { interval: "month", interval_count: 1 };
    case "annual": return { interval: "year", interval_count: 1 };
    default: return null;
  }
}

/**
 * The inverse: which cycle a Stripe price's `recurring` block describes, or
 * null when it is not one this product models (e.g. every 3 months). Used to
 * match an existing Stripe subscription to a tier during a migration.
 */
export function cycleFromStripeRecurring(
  recurring: { interval: string; interval_count?: number | null } | null | undefined,
): BillingCycle | null {
  if (!recurring) return null;
  const count = recurring.interval_count ?? 1;
  if (recurring.interval === "week") {
    if (count === 1) return "weekly";
    if (count === 2) return "fortnightly";
    if (count === 4) return "four_weekly";
    return null;
  }
  if (recurring.interval === "month" && count === 1) return "monthly";
  if (recurring.interval === "month" && count === 12) return "annual";
  if (recurring.interval === "year" && count === 1) return "annual";
  return null;
}
