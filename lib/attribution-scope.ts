// Attribution FK ids a staff write may set on a Member must each point inside
// the caller's own tenant. trialRunById and creditedToUserId reference a User
// (staff); creditedToMemberId references another Member ("brought a friend").
// None carries a database-level tenant constraint (all are onDelete: SetNull),
// so without this check a staff user of tenant A could store an id belonging to
// tenant B. No current read path discloses these cross-tenant (reviewer A-1,
// 2026-11-02), but an unresolved foreign id is a latent isolation gap and is
// closed here the same way parentMemberId and membershipTierId already are:
// resolved in-tenant, rejected on miss. RLS is the backstop; the explicit
// tenantId filter is the defence (CLAUDE.md tenant convention).

export type AttributionIds = {
  trialRunById?: string | null;
  creditedToUserId?: string | null;
  creditedToMemberId?: string | null;
};

export type AttributionField = "trialRunById" | "creditedToUserId" | "creditedToMemberId";

type FindFirst = (args: { where: { id: string; tenantId: string }; select: { id: true } }) => Promise<{ id: string } | null>;
type TxLike = { user: { findFirst: FindFirst }; member: { findFirst: FindFirst } };

const CHECKS: ReadonlyArray<readonly [AttributionField, "user" | "member"]> = [
  ["trialRunById", "user"],
  ["creditedToUserId", "user"],
  ["creditedToMemberId", "member"],
];

/**
 * Returns the first attribution field whose non-null id does not resolve to a
 * row in `tenantId`, or null when every supplied id is absent, null, or
 * in-tenant. Must run inside the caller's withTenantContext transaction so the
 * lookups are RLS-scoped as well as explicitly filtered. Absent/null ids are
 * valid (attribution is optional and may be cleared).
 */
export async function firstForeignAttribution(
  tx: TxLike,
  tenantId: string,
  data: AttributionIds,
): Promise<AttributionField | null> {
  for (const [field, model] of CHECKS) {
    const id = data[field];
    if (id == null) continue;
    const row = await tx[model].findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) return field;
  }
  return null;
}

/** Human-facing reason for a rejected foreign attribution id. */
export function attributionNotFoundMessage(field: AttributionField): string {
  const what =
    field === "creditedToMemberId" ? "Credited member" : field === "trialRunById" ? "Trial-run staff member" : "Credited staff member";
  return `${what} not found in this tenant`;
}
