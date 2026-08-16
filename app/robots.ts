import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // Only the public marketing surface is indexable — every
        // authenticated or operational surface is disallowed so search
        // engines don't index login pages, dashboards, or API endpoints.
        allow: ["/", "/apply", "/legal/"],
        disallow: [
          "/dashboard/",
          "/member/",
          "/admin/",
          "/api/",
          "/login",
          "/kiosk/",
          "/onboarding/",
        ],
      },
    ],
    sitemap: "https://matflow.studio/sitemap.xml",
  };
}
