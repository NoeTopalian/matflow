import type { MetadataRoute } from "next";
import { listPublishedClubSlugs } from "@/lib/public-club-page-server";
import { PUBLIC_SITE_URL, clubPageUrl } from "@/lib/public-club-page";

const BASE_URL = PUBLIC_SITE_URL;

// T9c: the club list is read per request, so a club that publishes or
// unpublishes is reflected on the next fetch (no build-time snapshot, and no
// database read during `next build`).
export const dynamic = "force-dynamic";

const STATIC_ENTRIES: MetadataRoute.Sitemap = [
  {
    url: `${BASE_URL}/`,
    changeFrequency: "weekly",
    priority: 1,
  },
  {
    url: `${BASE_URL}/apply`,
    changeFrequency: "monthly",
    priority: 0.8,
  },
  {
    url: `${BASE_URL}/legal/terms`,
    changeFrequency: "yearly",
    priority: 0.3,
  },
  {
    url: `${BASE_URL}/legal/privacy`,
    changeFrequency: "yearly",
    priority: 0.3,
  },
  {
    url: `${BASE_URL}/legal/aup`,
    changeFrequency: "yearly",
    priority: 0.3,
  },
  {
    url: `${BASE_URL}/legal/subprocessors`,
    changeFrequency: "yearly",
    priority: 0.3,
  },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Only clubs that opted in to a public page AND admit sign-in. Opted-out,
  // suspended, cancelled, deleted and reserved slugs never appear.
  let clubs: { slug: string; updatedAt: Date | null }[] = [];
  try {
    clubs = await listPublishedClubSlugs();
    console.info(`[sitemap] published club pages: ${clubs.length}`);
  } catch (e) {
    // The static pages still answer; a missing club list is logged rather
    // than failing the whole sitemap.
    console.error("[sitemap] published club list failed", e);
  }
  return [
    ...STATIC_ENTRIES,
    ...clubs.map((c) => ({
      url: clubPageUrl(c.slug),
      ...(c.updatedAt ? { lastModified: c.updatedAt } : {}),
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}
