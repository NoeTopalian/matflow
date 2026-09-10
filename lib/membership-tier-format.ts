/**
 * One way to say what a membership tier costs, shared by every surface that
 * shows a price list (the add-member dropdown and the staff subscribe
 * control). British English, `en-GB` conventions, no per-call-site copies —
 * the same discipline lib/date.ts applies to dates (UI-RULES §10).
 */
export function formatTierPrice(tier: {
  pricePence: number;
  currency: string;
  billingCycle: string;
}): string {
  const symbol = tier.currency === "GBP" ? "£" : `${tier.currency} `;
  const amount = `${symbol}${(tier.pricePence / 100).toFixed(2)}`;
  if (tier.billingCycle === "monthly") return `${amount} a month`;
  if (tier.billingCycle === "annual") return `${amount} a year`;
  return `${amount} one-off`;
}
