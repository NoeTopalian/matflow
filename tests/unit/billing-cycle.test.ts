// The billing-cycle set is defined once (lib/billing-cycle.ts) and every
// surface reads it: the tier editor's options, the price suffix, the subscribe
// copy, the zod enums on the memberships API, the DB CHECK. These tests pin the
// pieces that would silently diverge — the Stripe shape in particular, because a
// 4-weekly plan minted as `month` would bill a member on the wrong day for ever.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BILLING_CYCLES,
  billingCycleSchema,
  cycleFromStripeRecurring,
  cycleLabel,
  cyclePriceSuffix,
  cycleBilledCopy,
  cycleDays,
  cycleMonths,
  stripeRecurring,
} from "@/lib/billing-cycle";
import { formatTierPrice } from "@/lib/membership-tier-format";

describe("the cycle set", () => {
  it("carries the week-based cycles alongside the original three", () => {
    expect([...BILLING_CYCLES]).toEqual([
      "weekly", "fortnightly", "four_weekly", "monthly", "annual", "none",
    ]);
  });

  it("every cycle is either day-based, month-based or none — never both, never neither", () => {
    for (const c of BILLING_CYCLES) {
      const d = cycleDays(c);
      const m = cycleMonths(c);
      if (c === "none") {
        expect(d).toBeNull();
        expect(m).toBeNull();
      } else {
        expect([d, m].filter((v) => v !== null)).toHaveLength(1);
      }
    }
  });

  it("the zod enum accepts four_weekly and refuses a value outside the set", () => {
    expect(billingCycleSchema.safeParse("four_weekly").success).toBe(true);
    expect(billingCycleSchema.safeParse("quarterly").success).toBe(false);
  });

  it("the DB CHECK migration lists exactly the same values", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260923220000_billing_cycle_weekly/migration.sql"),
      "utf8",
    );
    const m = sql.match(/IN \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const inDb = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(inDb).toEqual([...BILLING_CYCLES]);
  });
});

describe("what a cycle says on screen", () => {
  it("labels and price suffixes are British and specific", () => {
    expect(cycleLabel("four_weekly")).toBe("Every 4 weeks");
    expect(cycleLabel("fortnightly")).toBe("Fortnightly");
    expect(cyclePriceSuffix("four_weekly")).toBe("every 4 weeks");
    expect(cyclePriceSuffix("none")).toBe("one-off");
    expect(formatTierPrice({ pricePence: 3800, currency: "GBP", billingCycle: "four_weekly" })).toBe(
      "£38.00 every 4 weeks",
    );
    expect(formatTierPrice({ pricePence: 6500, currency: "GBP", billingCycle: "monthly" })).toBe(
      "£65.00 a month",
    );
  });

  it("the subscribe confirmation names the cycle, and says nothing for a one-off", () => {
    expect(cycleBilledCopy("four_weekly")).toBe(", billed every 4 weeks until cancelled");
    expect(cycleBilledCopy("monthly")).toBe(", billed monthly until cancelled");
    expect(cycleBilledCopy("none")).toBeNull();
  });
});

describe("the Stripe shape", () => {
  it("week-based cycles are `week` with an interval_count, never `month`", () => {
    expect(stripeRecurring("weekly")).toEqual({ interval: "week", interval_count: 1 });
    expect(stripeRecurring("fortnightly")).toEqual({ interval: "week", interval_count: 2 });
    expect(stripeRecurring("four_weekly")).toEqual({ interval: "week", interval_count: 4 });
    expect(stripeRecurring("monthly")).toEqual({ interval: "month", interval_count: 1 });
    expect(stripeRecurring("annual")).toEqual({ interval: "year", interval_count: 1 });
    expect(stripeRecurring("none")).toBeNull();
  });

  it("round-trips: every recurring cycle maps back to itself from its Stripe shape", () => {
    for (const c of BILLING_CYCLES) {
      const r = stripeRecurring(c);
      if (!r) continue;
      expect(cycleFromStripeRecurring(r)).toBe(c);
    }
  });

  it("an existing Stripe price on a cadence this product does not model maps to null", () => {
    expect(cycleFromStripeRecurring({ interval: "month", interval_count: 3 })).toBeNull();
    expect(cycleFromStripeRecurring({ interval: "week", interval_count: 3 })).toBeNull();
    expect(cycleFromStripeRecurring(null)).toBeNull();
    // Stripe sometimes expresses a year as 12 months; treat it as annual.
    expect(cycleFromStripeRecurring({ interval: "month", interval_count: 12 })).toBe("annual");
  });
});
