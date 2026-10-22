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

// ─── Gate throttle ───────────────────────────────────────────────────────────
//
// Every bare /<slug> request is an anonymous by-slug read under the RLS bypass.
// Two per-instance brakes keep that from becoming direct database load:
//
//  - a short gate cache per slug (published id OR "not published"), so a burst
//    on one slug — a crawler, a shared link — costs one read per TTL. Failed
//    lookups are never cached. The TTL is also how long an unpublish takes to
//    reach other instances; the logo route already accepts 60 s (E-11), and the
//    settings route clears this instance's entry on save.
//  - a per-IP budget on the reads that MISS the cache (random-slug floods).
//    Over budget answers exactly like an unknown slug (the login redirect), so
//    the states stay indistinguishable. In memory on purpose: the shared rate
//    limiter (lib/rate-limit.ts) costs up to five round trips per allowed call,
//    more than the single indexed read it would be guarding.
const GATE_TTL_MS = 30_000;
const GATE_CACHE_MAX = 1_000;
const MISS_BUDGET = 120;
const MISS_WINDOW_MS = 60_000;
const IP_TABLE_MAX = 5_000;

const gateCache = new Map<string, { id: string | null; expiresAt: number }>();
const missBudget = new Map<string, { count: number; resetAt: number }>();

function readGateCache(slug: string, now: number): { id: string | null } | null {
  const hit = gateCache.get(slug);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    gateCache.delete(slug);
    return null;
  }
  return { id: hit.id };
}

function writeGateCache(slug: string, id: string | null, now: number) {
  if (gateCache.size >= GATE_CACHE_MAX) {
    // Map iterates in insertion order: drop the oldest entry.
    const oldest = gateCache.keys().next().value;
    if (oldest !== undefined) gateCache.delete(oldest);
  }
  gateCache.set(slug, { id, expiresAt: now + GATE_TTL_MS });
}

function spendMissBudget(ip: string, now: number): boolean {
  const entry = missBudget.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (!entry && missBudget.size >= IP_TABLE_MAX) {
      for (const [k, v] of missBudget) if (v.resetAt <= now) missBudget.delete(k);
      if (missBudget.size >= IP_TABLE_MAX) {
        const oldest = missBudget.keys().next().value;
        if (oldest !== undefined) missBudget.delete(oldest);
      }
    }
    missBudget.set(ip, { count: 1, resetAt: now + MISS_WINDOW_MS });
    return true;
  }
  if (entry.count >= MISS_BUDGET) return false;
  entry.count++;
  return true;
}

/** Forget a club's cached gate answer (this instance only), e.g. after a save. */
export function forgetPublicGate(slug?: string) {
  if (slug === undefined) {
    gateCache.clear();
    missBudget.clear();
    return;
  }
  gateCache.delete(normaliseClubSlug(slug));
}

/**
 * The published club's id, or null for every other case: unknown, not opted
 * in, suspended, cancelled, deleted, reserved — and a failed lookup. A failed
 * lookup answers like an unpublished club (the login door, today's behaviour)
 * rather than an error page, so an outage cannot be told apart per slug and
 * the short URL keeps working as the login door it was before T9c.
 *
 * `clientIp`, when given, spends that visitor's cache-miss budget (the page
 * passes it; the logo route has its own shared rate limit and does not).
 * `fresh` skips the cache read, so the logo route keeps its E-11 promise that
 * an unpublished logo stops being served within its own 60 s cache.
 */
export async function resolvePublishedClubId(
  slug: string,
  opts: { clientIp?: string; now?: number; fresh?: boolean } = {},
): Promise<string | null> {
  const normalised = normaliseClubSlug(slug);
  if (isNonClubSlug(normalised)) return null;
  const now = opts.now ?? Date.now();
  const cached = opts.fresh ? null : readGateCache(normalised, now);
  if (cached) return cached.id;
  if (opts.clientIp !== undefined && !spendMissBudget(opts.clientIp, now)) return null;
  let row;
  try {
    row = await withRlsBypass((tx) =>
      tx.tenant.findUnique({ where: { slug: normalised }, select: PUBLIC_GATE_SELECT }),
    );
  } catch (e) {
    console.error("[public-club-page] gate lookup failed", { slug: normalised }, e);
    return null;
  }
  const id = isPublishedGate(row) ? row.id : null;
  writeGateCache(normalised, id, now);
  return id;
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
export const getPublishedClubPage = cache(async (slug: string, clientIp?: string): Promise<PublicClubPage | null> => {
  const id = await resolvePublishedClubId(slug, { clientIp });
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
export async function listPublishedClubSlugs(): Promise<{ slug: string }[]> {
  const rows = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: {
        publicPageEnabled: true,
        deletedAt: null,
        subscriptionStatus: { notIn: ["suspended", "cancelled"] },
      },
      select: { slug: true, subscriptionStatus: true, deletedAt: true, publicPageEnabled: true, id: true },
      orderBy: { slug: "asc" },
    }),
  );
  return rows
    .filter((r) => isPublishedGate(r) && !isNonClubSlug(normaliseClubSlug(r.slug)) && normaliseClubSlug(r.slug) === r.slug)
    .map((r) => ({ slug: r.slug }));
}
