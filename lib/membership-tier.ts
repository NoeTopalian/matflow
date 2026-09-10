import { withTenantContext } from "@/lib/prisma-tenant";

/**
 * Resolve a client-supplied `membershipTierId` to the tier row it names,
 * inside the caller's tenant.
 *
 * Two reasons this exists rather than spreading the id straight into
 * `member.update`:
 *
 *  1. **Tenant scoping is load-bearing here, not a formality.** Row Level
 *     Security is currently decorative in this product — the app connects as a
 *     role that bypasses every policy — so this `where: { id, tenantId }` is
 *     the only thing stopping one gym from attaching its members to another
 *     gym's price list. An unresolved id must be refused, never written.
 *  2. **The legacy label is derived, never trusted.** `Member.membershipType`
 *     is a free-text column that revenue reporting still string-matches on, so
 *     it has to keep working. Whenever staff pick a tier both columns are
 *     written together and the label comes from the tier row on the server —
 *     if the client supplied it, the two would drift the first time an owner
 *     renamed a tier.
 */
export type ResolvedMembershipTier = { id: string; name: string };

export async function resolveMembershipTier(
  tenantId: string,
  membershipTierId: string,
): Promise<ResolvedMembershipTier | null> {
  return withTenantContext(tenantId, (tx) =>
    tx.membershipTier.findFirst({
      where: { id: membershipTierId, tenantId },
      select: { id: true, name: true },
    }),
  );
}

/**
 * The pair of columns to write for a given `membershipTierId` input.
 *
 * - `undefined` input → `{}`, leave both columns alone.
 * - `null` input → detach from the tier, leave the legacy label as-is (a
 *   member can sit on a plan the gym has not modelled as a tier yet).
 * - an id → both columns, label derived from the tier.
 */
export function membershipTierWrite(
  tier: ResolvedMembershipTier | null | undefined,
): { membershipTierId?: string | null; membershipType?: string } {
  if (tier === undefined) return {};
  if (tier === null) return { membershipTierId: null };
  return { membershipTierId: tier.id, membershipType: tier.name };
}
