import type Stripe from "stripe";
import { withTenantContext } from "@/lib/prisma-tenant";
import { stripeRecurring } from "@/lib/billing-cycle";

/**
 * A tier can only be billed through Stripe once it has a Stripe price. Owners
 * have always been able to paste one in (the tier editor's price_/prod_ fields);
 * this mints one on the connected account when none exists, from the tier's
 * own amount, currency and cycle, and stores both ids back on the tier so the
 * next caller finds it. Same product+price shape as
 * app/api/stripe/subscription-plans/route.ts and app/api/class-packs/route.ts.
 *
 * Returns the price id. Throws for a non-recurring tier: a one-off tier has no
 * subscription price to mint, and callers must not silently bill it monthly.
 */
export type TierForPrice = {
  id: string;
  name: string;
  pricePence: number;
  currency: string;
  billingCycle: string;
  stripePriceId: string | null;
  stripeProductId: string | null;
};

export async function ensureTierPrice(
  stripe: Stripe,
  tenant: { id: string; stripeAccountId: string },
  tier: TierForPrice,
): Promise<string> {
  if (tier.stripePriceId) return tier.stripePriceId;

  const recurring = stripeRecurring(tier.billingCycle);
  if (!recurring) {
    throw new Error(`Tier "${tier.name}" is not recurring, so it has no subscription price to mint`);
  }
  if (!Number.isInteger(tier.pricePence) || tier.pricePence <= 0) {
    throw new Error(`Tier "${tier.name}" has no price to mint a Stripe price from`);
  }

  const opts = { stripeAccount: tenant.stripeAccountId };
  const product = tier.stripeProductId
    ? { id: tier.stripeProductId }
    : await stripe.products.create(
        { name: tier.name, metadata: { matflowTierId: tier.id, matflowTenantId: tenant.id } },
        opts,
      );
  const price = await stripe.prices.create(
    {
      product: product.id,
      unit_amount: tier.pricePence,
      currency: tier.currency.toLowerCase(),
      recurring,
      metadata: { matflowTierId: tier.id, matflowTenantId: tenant.id },
    },
    opts,
  );

  await withTenantContext(tenant.id, (tx) =>
    tx.membershipTier.update({
      where: { id: tier.id },
      data: { stripePriceId: price.id, stripeProductId: product.id },
    }),
  );

  return price.id;
}
