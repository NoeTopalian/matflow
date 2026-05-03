import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // Allow only the public marketing surface — every authenticated
        // surface is disallowed so search engines don't index login pages,
        // dashboards, or API endpoints.
        allow: ["/", "/apply", "/legal", "/preview", "/login"],
        disallow: [
          "/api/",
          "/dashboard/",
          "/member/",
          "/onboarding/",
        ],
      },
    ],
  };
}
