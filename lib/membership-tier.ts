import { withTenantContext } from "@/lib/prisma-tenant";
import { advanceDueDate } from "@/lib/overdue";

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
export type ResolvedMembershipTier = { id: string; name: string; billingCycle: string };

export async function resolveMembershipTier(
  tenantId: string,
  membershipTierId: string,
): Promise<ResolvedMembershipTier | null> {
  return withTenantContext(tenantId, (tx) =>
    tx.membershipTier.findFirst({
      where: { id: membershipTierId, tenantId },
      // billingCycle comes back so attaching a member to a tier can seed
      // their first due date — see membershipTierWrite.
      select: { id: true, name: true, billingCycle: true },
    }),
  );
}

/**
 * The columns to write for a given `membershipTierId` input.
 *
 * - `undefined` input → `{}`, leave everything alone.
 * - `null` input → detach from the tier, leave the legacy label as-is (a
 *   member can sit on a plan the gym has not modelled as a tier yet).
 * - an id → both tier columns, label derived from the tier.
 *
 * SEEDING THE FIRST DUE DATE. Overdue is derived from `Member.nextDueAt`
 * (lib/overdue.ts), so a club whose members all have a null due date can never
 * see anyone as behind — the derivation would be live and permanently silent,
 * which is the same uselessness it was built to remove. Putting a member on a
 * recurring tier is the moment an obligation starts, so that is where the first
 * date comes from.
 *
 * Deliberately conservative in three ways:
 *  - it only ever seeds a date that is MISSING. Changing a member's tier must
 *    not silently reset a schedule they are already on.
 *  - a `none` cycle seeds nothing: there is no recurring obligation to date.
 *  - detaching from a tier does NOT clear the date. A member who owes for last
 *    month still owes it, and wiping the date on an unrelated edit would erase
 *    a debt rather than settle it.
 */
export function membershipTierWrite(
  tier: ResolvedMembershipTier | null | undefined,
  opts?: { currentNextDueAt?: Date | null; now?: Date },
): { membershipTierId?: string | null; membershipType?: string; nextDueAt?: Date } {
  if (tier === undefined) return {};
  if (tier === null) return { membershipTierId: null };

  const columns: { membershipTierId: string; membershipType: string; nextDueAt?: Date } = {
    membershipTierId: tier.id,
    membershipType: tier.name,
  };

  if (opts && !opts.currentNextDueAt) {
    const seeded = advanceDueDate(null, tier.billingCycle, opts.now ?? new Date());
    if (seeded) columns.nextDueAt = seeded;
  }

  return columns;
}
