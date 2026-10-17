import type { MetadataRoute } from "next";

/**
 * Every authenticated, operational or token-bearing top-level surface. These
 * are disallowed so search engines don't index login pages, dashboards, API
 * endpoints, waiver links or leaderboard display tokens.
 */
const PRIVATE_SEGMENTS = [
  "dashboard",
  "member",
  "admin",
  "api",
  "login",
  "kiosk",
  "onboarding",
  "set-password",
  "waiver",
  "leaderboard",
  "print",
  "preview",
] as const;

/**
 * robots.txt rules match by prefix, so a bare "/login" also blocks a club
 * whose slug merely starts with it ("/loginbjj", "/waiverly", "/preview-bjj"),
 * and that club's published page would be in the sitemap but uncrawlable.
 * Each segment is therefore disallowed exactly: the bare path ("$" anchors the
 * end of the URL), the path with a query string ("?" is literal in robots.txt)
 * and everything below it.
 */
function segmentRules(segment: string): string[] {
  return [`/${segment}$`, `/${segment}?`, `/${segment}/`];
}

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // The public marketing surface and the club pages are indexable.
        // A club page is a bare /<slug>, which "/" allows; whether a given
        // club is indexable is decided by the page itself (T9c): an opted-in
        // club renders index metadata and is listed in the sitemap, every
        // other slug redirects to the robots-disallowed /login with noindex.
        //
        // "/api/tenant/*/logo" is the published club's logo for link previews
        // (Open Graph); the longer rule wins over "/api/".
        allow: ["/", "/apply", "/legal/", "/api/tenant/*/logo"],
        disallow: PRIVATE_SEGMENTS.flatMap(segmentRules),
      },
    ],
    sitemap: "https://matflow.studio/sitemap.xml",
  };
}
