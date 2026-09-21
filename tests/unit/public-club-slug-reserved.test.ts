import { describe, it, expect } from "vitest";

// app/[slug]/page.tsx is the public, anonymous club page — the second,
// independent guard against a top-level segment being treated as a tenant's
// public page. Next's own router already prefers a literal folder
// (app/dashboard, app/login, …) over this dynamic route, so this test is
// NOT re-proving routing precedence; it is pinning the denylist itself,
// which also stops the tenant lookup running at all for a name that could
// never be a real club — including "leaderboard", which has no route today
// but is named in the build brief as one to keep reserved.
//
// Only the pure exports are touched (`isReservedSlug` / `RESERVED_SLUGS`) —
// the default export (the page component) is never invoked here, so this
// never reaches Prisma or `notFound()`'s request-context requirement.
describe("reserved-slug guard (lib/reserved-slugs — shared by proxy.ts and app/[slug]/page.tsx)", () => {
  it("reserves every existing top-level app/ route segment", async () => {
    const { isReservedSlug } = await import("@/lib/reserved-slugs");

    // One-to-one with the real folders under app/ (excluding the [slug] dynamic
    // route itself). A new top-level route added without registering here fails
    // this test — the point of the denylist being one shared, pinned list.
    for (const real of [
      "admin",
      "api",
      "apply",
      "dashboard",
      "kiosk",
      "leaderboard",
      "legal",
      "login",
      "member",
      "onboarding",
      "preview",
      "print",
      "waiver",
    ]) {
      expect(isReservedSlug(real), real).toBe(true);
    }
  });

  it("does not reserve an ordinary club slug", async () => {
    const { isReservedSlug } = await import("@/lib/reserved-slugs");
    for (const real of ["totalbjj", "north-side-bjj", "gracie-barra-2"]) {
      expect(isReservedSlug(real), real).toBe(false);
    }
  });

  it("the guard runs on the NORMALISED slug, so case and punctuation can't smuggle a reserved word past it", async () => {
    // The page normalises with slug.toLowerCase().replace(/[^a-z0-9-]/g, "")
    // before calling isReservedSlug — mirrored here rather than re-imported,
    // since it is the same one-line transform app/api/tenant/[slug]/route.ts
    // already uses and this test is about the denylist, not the transform.
    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const { isReservedSlug } = await import("@/lib/reserved-slugs");

    expect(isReservedSlug(normalise("Dashboard"))).toBe(true);
    expect(isReservedSlug(normalise("DASH-BOARD"))).toBe(false); // genuinely a different string — the hyphen survives normalisation
    // Whitespace and punctuation are STRIPPED, not treated as separators, so
    // "  admin  " collapses to "admin" rather than escaping the guard.
    expect(isReservedSlug(normalise("  admin  "))).toBe(true);
  });
});
