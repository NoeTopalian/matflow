/**
 * One way to say what a membership tier costs, shared by every surface that
 * shows a price list (the add-member dropdown and the staff subscribe
 * control). British English, `en-GB` conventions, no per-call-site copies —
 * the same discipline lib/date.ts applies to dates (UI-RULES §10). The cycle
 * wording comes from lib/billing-cycle.ts so a new cycle shows up here without
 * this file knowing.
 */
import { cyclePriceSuffix } from "@/lib/billing-cycle";

/**
 * Said instead of a price for a tier whose price MatFlow does not know: price
 * 0 with no billing cycle, which is how a tier for a plan another system bills
 * is set up (Total BJJ: TeamUp bills; scripts/readiness/teamup-tier-plan.mjs).
 * Price 0 + cycle none keeps it from seeding a due date or an overdue; it must
 * not then read as "£0.00 one-off" in the staff tier pickers. Same words as
 * the Memberships page (MembershipsManager tierPriceText).
 */
export const PRICE_NOT_SET = "Price not set";

export function formatTierPrice(tier: {
  pricePence: number;
  currency: string;
  billingCycle: string;
}): string {
  // A genuinely free desk tier still has a recurring cycle and reads "£0.00 a
  // month"; only price 0 with no cycle at all is an unknown price.
  if (tier.pricePence === 0 && tier.billingCycle === "none") return PRICE_NOT_SET;
  const symbol = tier.currency === "GBP" ? "£" : `${tier.currency} `;
  const amount = `${symbol}${(tier.pricePence / 100).toFixed(2)}`;
  return `${amount} ${cyclePriceSuffix(tier.billingCycle)}`;
}
