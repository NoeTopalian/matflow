/**
 * The staff tier pickers (add-member dropdown, profile tier change) label each
 * tier with formatTierPrice. A tier set up for a plan another system bills
 * (Total BJJ handover, 3 Oct 2026: price 0, billing cycle "none") must not
 * read "£0.00 one-off" or "Free" there; it reads "Price not set", the words
 * the Memberships page uses. A genuinely free desk tier (price 0 on a
 * recurring cycle) and every priced tier are unchanged.
 */
import { describe, it, expect } from "vitest";
import { formatTierPrice, PRICE_NOT_SET } from "@/lib/membership-tier-format";

describe("formatTierPrice — price not set", () => {
  it("price 0 with no billing cycle reads Price not set, never £0.00 or Free", () => {
    const label = formatTierPrice({ pricePence: 0, currency: "GBP", billingCycle: "none" });
    expect(label).toBe("Price not set");
    expect(label).toBe(PRICE_NOT_SET);
    expect(label).not.toMatch(/£|0\.00|free/i);
  });

  it("matches the Memberships page wording", () => {
    expect(PRICE_NOT_SET).toBe("Price not set");
  });

  it("a free desk tier on a recurring cycle is unchanged", () => {
    expect(formatTierPrice({ pricePence: 0, currency: "GBP", billingCycle: "monthly" })).toBe("£0.00 a month");
    expect(formatTierPrice({ pricePence: 0, currency: "GBP", billingCycle: "four_weekly" })).toBe("£0.00 every 4 weeks");
  });

  it("a priced one-off and a priced recurring tier are unchanged", () => {
    expect(formatTierPrice({ pricePence: 1500, currency: "GBP", billingCycle: "none" })).toBe("£15.00 one-off");
    expect(formatTierPrice({ pricePence: 6500, currency: "GBP", billingCycle: "monthly" })).toBe("£65.00 a month");
    expect(formatTierPrice({ pricePence: 4000, currency: "EUR", billingCycle: "annual" })).toBe("EUR 40.00 a year");
  });
});
