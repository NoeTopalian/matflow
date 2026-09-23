/**
 * One way to say what a membership tier costs, shared by every surface that
 * shows a price list (the add-member dropdown and the staff subscribe
 * control). British English, `en-GB` conventions, no per-call-site copies —
 * the same discipline lib/date.ts applies to dates (UI-RULES §10). The cycle
 * wording comes from lib/billing-cycle.ts so a new cycle shows up here without
 * this file knowing.
 */
import { cyclePriceSuffix } from "@/lib/billing-cycle";

export function formatTierPrice(tier: {
  pricePence: number;
  currency: string;
  billingCycle: string;
}): string {
  const symbol = tier.currency === "GBP" ? "£" : `${tier.currency} `;
  const amount = `${symbol}${(tier.pricePence / 100).toFixed(2)}`;
  return `${amount} ${cyclePriceSuffix(tier.billingCycle)}`;
}
