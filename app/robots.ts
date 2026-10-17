import type { MetadataRoute } from "next";

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
        // Every authenticated, operational or token-bearing surface is
        // disallowed so search engines don't index login pages, dashboards,
        // API endpoints, waiver links or leaderboard display tokens.
        disallow: [
          "/dashboard/",
          "/member/",
          "/admin/",
          "/api/",
          "/login",
          "/kiosk/",
          "/onboarding/",
          "/set-password",
          "/waiver",
          "/leaderboard/",
          "/print/",
          "/preview",
        ],
      },
    ],
    sitemap: "https://matflow.studio/sitemap.xml",
  };
}
