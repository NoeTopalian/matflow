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
  /** The mat the class runs on. Must be one of this club's mats. */
  matId?: string | null;
  /** T6a: the memberships that include the class. Every id must be this club's. */
  allowedTierIds?: readonly string[] | null;
};

export const CLASS_REF_ERRORS = {
  location: "That location is not one of this club's locations",
  rank: "That belt is not one of this club's belts",
  coach: "That coach is not one of this club's staff",
  tier: "That membership is not one of this club's memberships",
  mat: "That mat is not one of this club's mats.",
} as const;

/**
 * A write refused by the Class → Mat foreign key (Prisma P2003 naming the
 * `matId` column or its constraint): the mat was removed in the instant
 * between the club check and the write. Answered as CLASS_REF_ERRORS.mat, not
 * as a 500.
 */
export function isMatForeignKeyError(e: unknown): boolean {
  const err = e as { code?: unknown; meta?: unknown } | null;
  if (!err || err.code !== "P2003") return false;
  try {
    return JSON.stringify(err.meta ?? {}).includes("matId");
  } catch {
    return false;
  }
}

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
  if (refs.matId) {
    const mat = await tx.mat.findFirst({ where: { id: refs.matId, tenantId }, select: { id: true } });
    if (!mat) return CLASS_REF_ERRORS.mat;
  }
  for (const rankId of [refs.requiredRankId, refs.maxRankId]) {
    if (!rankId) continue;
    const rank = await tx.rankSystem.findFirst({ where: { id: rankId, tenantId }, select: { id: true } });
    if (!rank) return CLASS_REF_ERRORS.rank;
  }
  if (refs.coachUserId) {
    // PR 3: a deactivated account cannot be made a class's coach.
    const coach = await tx.user.findFirst({ where: { id: refs.coachUserId, tenantId, deactivatedAt: null }, select: { id: true } });
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
