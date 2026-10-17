/**
 * T9c — database reads for the opt-in public club page. Server only.
 *
 * Tenant isolation:
 *  - The RLS bypass is confined to two select-only reads with fixed fields:
 *    the slug → gate lookup (PUBLIC_GATE_SELECT) and the sitemap's slug list.
 *    There is no session at an anonymous door, so no tenant context exists yet.
 *  - Every content read runs under withTenantContext(resolved id) AND carries an
 *    explicit `tenantId` filter. RLS is inert under a BYPASSRLS runtime role
 *    (docs/security/ITERATION-2-REPORT.md), so the application filter is the
 *    live control.
 */
import { cache } from "react";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import {
  PUBLIC_CLASS_SELECT,
  PUBLIC_GATE_SELECT,
  PUBLIC_SCHEDULE_SELECT,
  PUBLIC_TENANT_SELECT,
  PUBLIC_TIER_SELECT,
  buildPublicClubPage,
  isNonClubSlug,
  isPublishedGate,
  normaliseClubSlug,
  publicClassWhere,
  publicScheduleWhere,
  publicTierWhere,
  type PublicClubPage,
} from "@/lib/public-club-page";

/**
 * The published club's id, or null for every other case: unknown, not opted
 * in, suspended, cancelled, deleted, reserved — and a failed lookup. A failed
 * lookup answers like an unpublished club (the login door, today's behaviour)
 * rather than an error page, so an outage cannot be told apart per slug and
 * the short URL keeps working as the login door it was before T9c.
 */
export async function resolvePublishedClubId(slug: string): Promise<string | null> {
  const normalised = normaliseClubSlug(slug);
  if (isNonClubSlug(normalised)) return null;
  let row;
  try {
    row = await withRlsBypass((tx) =>
      tx.tenant.findUnique({ where: { slug: normalised }, select: PUBLIC_GATE_SELECT }),
    );
  } catch (e) {
    console.error("[public-club-page] gate lookup failed", { slug: normalised }, e);
    return null;
  }
  return isPublishedGate(row) ? row.id : null;
}

/** Content for a published club. A read failure here throws (honest error page). */
export async function loadClubContent(tenantId: string, now: Date = new Date()): Promise<PublicClubPage | null> {
  const { tenant, classes, tiers } = await withTenantContext(tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: PUBLIC_TENANT_SELECT });
    const classes = await tx.class.findMany({
      where: publicClassWhere(tenantId),
      select: {
        ...PUBLIC_CLASS_SELECT,
        schedules: { where: publicScheduleWhere(now), select: PUBLIC_SCHEDULE_SELECT },
      },
      orderBy: { name: "asc" },
    });
    const tiers = await tx.membershipTier.findMany({
      where: publicTierWhere(tenantId),
      select: PUBLIC_TIER_SELECT,
    });
    return { tenant, classes, tiers };
  });
  if (!tenant) return null;
  return buildPublicClubPage(tenant, classes, tiers);
}

/**
 * The page for this slug, or null when it must answer like an unknown slug.
 * Wrapped in React `cache` so generateMetadata and the page share one read.
 */
export const getPublishedClubPage = cache(async (slug: string): Promise<PublicClubPage | null> => {
  const id = await resolvePublishedClubId(slug);
  if (!id) return null;
  return loadClubContent(id);
});

/**
 * The owner's preview of their own club page, published or not. Returns null
 * unless the slug resolves to exactly `viewerTenantId` and the club admits
 * sign-in — so it can never show another club, and an anonymous request (no
 * viewer tenant) gets the same answer as an unknown slug.
 */
export async function previewClubPageFor(slug: string, viewerTenantId: string | null | undefined): Promise<PublicClubPage | null> {
  if (!viewerTenantId) return null;
  const normalised = normaliseClubSlug(slug);
  if (isNonClubSlug(normalised)) return null;
  const row = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug: normalised }, select: PUBLIC_GATE_SELECT }),
  );
  if (!row || row.id !== viewerTenantId) return null;
  if (!isPublishedGate({ ...row, publicPageEnabled: true })) return null;
  return loadClubContent(row.id);
}

/** Slugs for the sitemap: published, admitted, not reserved. Select-only, fixed fields. */
export async function listPublishedClubSlugs(): Promise<{ slug: string; updatedAt: Date | null }[]> {
  const rows = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: {
        publicPageEnabled: true,
        deletedAt: null,
        subscriptionStatus: { notIn: ["suspended", "cancelled"] },
      },
      select: { slug: true, publicPageEnabledAt: true, subscriptionStatus: true, deletedAt: true, publicPageEnabled: true, id: true },
      orderBy: { slug: "asc" },
    }),
  );
  return rows
    .filter((r) => isPublishedGate(r) && !isNonClubSlug(normaliseClubSlug(r.slug)) && normaliseClubSlug(r.slug) === r.slug)
    .map((r) => ({ slug: r.slug, updatedAt: r.publicPageEnabledAt }));
}
