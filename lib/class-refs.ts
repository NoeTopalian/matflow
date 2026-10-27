import type { Prisma } from "@prisma/client";

/**
 * The foreign ids a class body may carry, each of which must belong to the
 * caller's club before it is written.
 *
 * Finding E-2 (cross-tenant matrix, 6 Oct 2026): POST /api/classes and
 * PATCH /api/classes/[id] checked `locationId` and nothing else, so gym A
 * could point its own class at gym B's belt or staff user. GET then
 * `include`d requiredRank / coachUser and returned gym B's belt and coach
 * names, and the ranks DELETE counted gym B's belt holders. RLS does not
 * help: Postgres foreign-key checks ignore row security.
 *
 * Every id is refused, never silently dropped — a class that quietly loses
 * its rank gate is a check-in rule the owner thinks exists and does not.
 */
export type ClassRefs = {
  requiredRankId?: string | null;
  maxRankId?: string | null;
  coachUserId?: string | null;
  locationId?: string | null;
  /** T6a: the memberships that include the class. Every id must be this club's. */
  allowedTierIds?: readonly string[] | null;
};

export const CLASS_REF_ERRORS = {
  location: "That location is not one of this club's locations",
  rank: "That belt is not one of this club's belts",
  coach: "That coach is not one of this club's staff",
  tier: "That membership is not one of this club's memberships",
} as const;

/**
 * Returns the refusal message for the first id that is not the caller's, or
 * null when every supplied id belongs to `tenantId`. Null and undefined mean
 * "clear" / "leave alone" and are not looked up.
 */
export async function classRefError(
  tx: Prisma.TransactionClient,
  tenantId: string,
  refs: ClassRefs,
): Promise<string | null> {
  if (refs.locationId) {
    const loc = await tx.location.findFirst({ where: { id: refs.locationId, tenantId }, select: { id: true } });
    if (!loc) return CLASS_REF_ERRORS.location;
  }
  for (const rankId of [refs.requiredRankId, refs.maxRankId]) {
    if (!rankId) continue;
    const rank = await tx.rankSystem.findFirst({ where: { id: rankId, tenantId }, select: { id: true } });
    if (!rank) return CLASS_REF_ERRORS.rank;
  }
  if (refs.coachUserId) {
    const coach = await tx.user.findFirst({ where: { id: refs.coachUserId, tenantId }, select: { id: true } });
    if (!coach) return CLASS_REF_ERRORS.coach;
  }
  if (refs.allowedTierIds && refs.allowedTierIds.length > 0) {
    const unique = [...new Set(refs.allowedTierIds)];
    const tiers = await tx.membershipTier.findMany({
      where: { id: { in: unique }, tenantId },
      select: { id: true },
    });
    if (tiers.length !== unique.length) return CLASS_REF_ERRORS.tier;
  }
  return null;
}
