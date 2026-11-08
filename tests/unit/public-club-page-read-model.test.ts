// T9c read-model pin: the anonymous club page's whole disclosure is the field
// lists in lib/public-club-page.ts. A field added to any of them must be added
// here too — a reviewed change, never a drive-by (ticket T9c, Tests §1).
import { describe, it, expect } from "vitest";
import {
  PUBLIC_GATE_SELECT,
  PUBLIC_TENANT_SELECT,
  PUBLIC_CLASS_SELECT,
  PUBLIC_SCHEDULE_SELECT,
  PUBLIC_TIER_SELECT,
  publicClassWhere,
  publicScheduleWhere,
  publicTierWhere,
  buildPublicClubPage,
  buildPublicSessions,
  filterSessions,
  filterOptions,
  EMPTY_FILTER,
  clubJsonLd,
  serialiseJsonLd,
  derivedOpeningHours,
  inlineLogo,
  decodeInlineLogo,
  isPublishedGate,
  clubMetadata,
  NOT_PUBLISHED_METADATA,
  clubLogoUrl,
} from "@/lib/public-club-page";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    name: "North Side BJJ",
    slug: "northside",
    logoUrl: PNG,
    logoSize: "md",
    primaryColor: "#3b82f6",
    secondaryColor: "#2563eb",
    textColor: "#ffffff",
    bgColor: "#111111",
    fontFamily: "'Inter', sans-serif",
    publicPageDescription: "Gi and no-gi for all levels.",
    publicPageEmail: "hello@northside.example",
    publicPagePhone: "+44 115 000 0000",
    publicPageAddress: "1 High Street, Nottingham",
    websiteUrl: "https://northside.example",
    instagramUrl: "https://instagram.com/northside",
    facebookUrl: null,
    tiktokUrl: "http://insecure.example", // not https: dropped
    youtubeUrl: null,
    twitterUrl: null,
    reviewLockedAt: null,
    ...over,
  };
}

const classes = [
  {
    name: "No-Gi",
    isKids: false,
    duration: 60,
    location: "Mat 1",
    locationRef: null,
    coachName: null,
    coachUser: { name: "Coach Sam" },
    schedules: [
      { dayOfWeek: 3, startTime: "19:00", endTime: "20:00" },
      { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" },
    ],
  },
  {
    name: "Kids BJJ",
    isKids: true,
    duration: 45,
    location: null,
    locationRef: { name: "Northside" },
    coachName: "Coach Jo",
    coachUser: null,
    schedules: [{ dayOfWeek: 0, startTime: "10:00", endTime: "10:45" }],
  },
];

const tiers = [
  { id: "t1", name: "Unlimited", description: "All classes", pricePence: 6500, currency: "GBP", billingCycle: "monthly", isKids: false },
  { id: "t2", name: "TeamUp-billed", description: null, pricePence: 0, currency: "GBP", billingCycle: "none", isKids: false },
  { id: "t3", name: "Kids", description: null, pricePence: 3500, currency: "GBP", billingCycle: "monthly", isKids: true },
];

describe("T9c read model — approved field lists", () => {
  it("gate read selects exactly id, status, deletedAt and the publish flag", () => {
    expect(Object.keys(PUBLIC_GATE_SELECT).sort()).toEqual(["deletedAt", "id", "publicPageEnabled", "subscriptionStatus"]);
  });

  it("club read selects only branding, owner-entered public fields, links and the review lock", () => {
    expect(Object.keys(PUBLIC_TENANT_SELECT).sort()).toEqual(
      [
        "bgColor", "facebookUrl", "fontFamily", "instagramUrl", "logoSize", "logoUrl", "name",
        "primaryColor", "publicPageAddress", "publicPageDescription", "publicPageEmail", "publicPagePhone",
        "reviewLockedAt", "secondaryColor", "slug", "textColor", "tiktokUrl", "twitterUrl", "websiteUrl", "youtubeUrl",
      ].sort(),
    );
    // The club's PRIVATE contact and billing fields are never read here.
    for (const k of ["contactEmail", "address", "billingContactEmail", "groupChatUrl", "stripeAccountId", "privacyContactEmail"]) {
      expect(PUBLIC_TENANT_SELECT, k).not.toHaveProperty(k);
    }
  });

  it("class read has no id, capacity, roster, rank or coach id", () => {
    expect(Object.keys(PUBLIC_CLASS_SELECT).sort()).toEqual(
      ["coachName", "coachUser", "duration", "isKids", "location", "locationRef", "name"].sort(),
    );
    expect(PUBLIC_CLASS_SELECT.coachUser).toEqual({ select: { name: true } });
    expect(PUBLIC_CLASS_SELECT.locationRef).toEqual({ select: { name: true } });
    expect(Object.keys(PUBLIC_SCHEDULE_SELECT).sort()).toEqual(["dayOfWeek", "endTime", "startTime"]);
  });

  it("tier read has no id, description, Stripe ids, member counts or venue", () => {
    expect(Object.keys(PUBLIC_TIER_SELECT).sort()).toEqual(
      ["billingCycle", "currency", "isKids", "name", "pricePence"].sort(),
    );
  });

  it("schedule predicate: active, already started, not yet ended", () => {
    const now = new Date("2026-10-17T12:00:00Z");
    expect(publicScheduleWhere(now)).toEqual({
      isActive: true,
      startDate: { lte: now },
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    });
  });

  it("live-class and tier predicates carry the tenant filter and exclude imported, paused, removed and roster-only classes", () => {
    expect(publicClassWhere("t-A")).toEqual({
      tenantId: "t-A",
      isActive: true,
      deletedAt: null,
      sourceImportJobId: null,
      rosterMembers: { none: {} },
    });
    expect(publicTierWhere("t-A")).toEqual({ tenantId: "t-A", isActive: true, showOnPublicPage: true });
  });
});

describe("T9c published gate", () => {
  const base = { id: "t", subscriptionStatus: "active", deletedAt: null, publicPageEnabled: true };
  it("publishes only an opted-in club that admits sign-in", () => {
    expect(isPublishedGate(base)).toBe(true);
    expect(isPublishedGate({ ...base, subscriptionStatus: "past_due" })).toBe(true);
    expect(isPublishedGate({ ...base, subscriptionStatus: "trial" })).toBe(true);
    expect(isPublishedGate(null)).toBe(false);
    expect(isPublishedGate({ ...base, publicPageEnabled: false })).toBe(false);
    expect(isPublishedGate({ ...base, subscriptionStatus: "suspended" })).toBe(false);
    expect(isPublishedGate({ ...base, subscriptionStatus: "Cancelled " })).toBe(false);
    expect(isPublishedGate({ ...base, deletedAt: new Date() })).toBe(false);
  });
});

describe("T9c view model", () => {
  it("orders sessions Monday first, then by time, with coach and venue resolved", () => {
    const rows = buildPublicSessions(classes);
    expect(rows.map((r) => [r.dayOfWeek, r.startTime, r.className])).toEqual([
      [1, "18:00", "No-Gi"],
      [3, "19:00", "No-Gi"],
      [0, "10:00", "Kids BJJ"],
    ]);
    expect(rows[0]).toMatchObject({ coach: "Coach Sam", venue: "Mat 1", durationMin: 60, isKids: false });
    expect(rows[2]).toMatchObject({ coach: "Coach Jo", venue: "Northside", durationMin: 45, isKids: true });
  });

  it("each session carries exactly the public fields, with unique keys and no ids", () => {
    const twin = [
      ...classes,
      // Two schedules of one class on the same day and time must not collide.
      { ...classes[0], schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] },
    ];
    const rows = buildPublicSessions(twin);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["className", "coach", "dayOfWeek", "durationMin", "endTime", "isKids", "key", "startTime", "venue"],
      );
    }
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    for (const r of rows) expect(r.key).toMatch(/^\d-\d\d:\d\d-\d+$/);
  });

  it("publishes known prices only, cheapest first, and none while review-locked", () => {
    const page = buildPublicClubPage(tenantRow(), classes, tiers);
    expect(page.tiers.map((t) => [t.name, t.price])).toEqual([
      ["Kids", "£35.00 a month"],
      ["Unlimited", "£65.00 a month"],
    ]);
    expect(buildPublicClubPage(tenantRow({ reviewLockedAt: new Date() }), classes, tiers).tiers).toEqual([]);
  });

  it("each tier carries exactly name, price, kids flag and a position key", () => {
    const page = buildPublicClubPage(tenantRow(), classes, tiers);
    for (const t of page.tiers) {
      expect(Object.keys(t).sort()).toEqual(["isKids", "key", "name", "price"]);
    }
    expect(page.tiers.map((t) => t.key)).toEqual(["tier-0", "tier-1"]);
  });

  it("never carries a blob or external logo, the review lock, or any non-public key", () => {
    expect(buildPublicClubPage(tenantRow({ logoUrl: "https://abc.public.blob.vercel-storage.com/tenants/t/logo.png" }), [], []).logoDataUrl).toBeNull();
    expect(inlineLogo("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(inlineLogo(PNG)).toBe(PNG);
    const json = JSON.stringify(buildPublicClubPage(tenantRow(), classes, tiers));
    for (const k of ["reviewLockedAt", "maxCapacity", "coachUserId", "memberId", "stripe", "contactEmail", "pricePence"]) {
      expect(json, k).not.toContain(k);
    }
    expect(json).not.toContain("insecure.example");
  });
});

describe("T9c client filter", () => {
  const sessions = buildPublicSessions(classes);
  it("searches by class, coach or venue and filters by day, coach and category", () => {
    expect(filterSessions(sessions, { ...EMPTY_FILTER, query: "no-gi" })).toHaveLength(2);
    expect(filterSessions(sessions, { ...EMPTY_FILTER, query: "jo" }).map((s) => s.className)).toEqual(["Kids BJJ"]);
    expect(filterSessions(sessions, { ...EMPTY_FILTER, day: 3 })).toHaveLength(1);
    expect(filterSessions(sessions, { ...EMPTY_FILTER, coach: "Coach Sam" })).toHaveLength(2);
    expect(filterSessions(sessions, { ...EMPTY_FILTER, category: "kids" }).map((s) => s.className)).toEqual(["Kids BJJ"]);
    expect(filterSessions(sessions, { ...EMPTY_FILTER, category: "adults" })).toHaveLength(2);
  });
  it("offers only options present in the data", () => {
    expect(filterOptions(sessions)).toEqual({ days: [1, 3, 0], coaches: ["Coach Jo", "Coach Sam"], showCategory: true });
    expect(filterOptions(sessions.filter((s) => !s.isKids)).showCategory).toBe(false);
  });
});

describe("T9c search-engine output", () => {
  const page = buildPublicClubPage(tenantRow(), classes, tiers);

  it("JSON-LD is an ExerciseGym with the published contact, links and derived hours", () => {
    const ld = clubJsonLd(page);
    expect(ld).toMatchObject({
      "@type": "ExerciseGym",
      name: "North Side BJJ",
      url: "https://matflow.studio/northside",
      logo: "https://matflow.studio/api/tenant/northside/logo",
      address: { "@type": "PostalAddress", streetAddress: "1 High Street, Nottingham" },
      email: "hello@northside.example",
      telephone: "+44 115 000 0000",
      sameAs: ["https://northside.example", "https://instagram.com/northside"],
    });
    expect(ld.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Monday", opens: "18:00", closes: "19:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Wednesday", opens: "19:00", closes: "20:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Sunday", opens: "10:00", closes: "10:45" },
    ]);
    // No tier, price or member data in structured data.
    expect(JSON.stringify(ld)).not.toContain("£");
  });

  it("omits what it cannot derive: no logo, no address, no hours", () => {
    const bare = buildPublicClubPage(
      tenantRow({ logoUrl: null, publicPageAddress: null, publicPageEmail: null, publicPagePhone: null, websiteUrl: null, instagramUrl: null }),
      [],
      [],
    );
    const ld = clubJsonLd(bare);
    for (const k of ["logo", "image", "address", "email", "telephone", "sameAs", "openingHoursSpecification"]) {
      expect(ld, k).not.toHaveProperty(k);
    }
    expect(clubLogoUrl(bare)).toBeNull();
    expect(derivedOpeningHours([])).toEqual([]);
  });

  it("escapes < so a club name cannot close the script element", () => {
    const evil = buildPublicClubPage(tenantRow({ name: "</script><script>alert(1)</script>" }), [], []);
    const out = serialiseJsonLd(clubJsonLd(evil));
    expect(out).not.toContain("<");
    expect(JSON.parse(out).name).toBe("</script><script>alert(1)</script>");
  });

  it("metadata: indexable with canonical and Open Graph logo when published; noindex otherwise", () => {
    const m = clubMetadata(page);
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(m.alternates).toEqual({ canonical: "https://matflow.studio/northside" });
    expect(m.openGraph).toMatchObject({ url: "https://matflow.studio/northside", images: [{ url: "https://matflow.studio/api/tenant/northside/logo" }] });
    expect(m.description).toBe("Gi and no-gi for all levels.");
    expect(NOT_PUBLISHED_METADATA).toEqual({ robots: { index: false, follow: false } });
  });

  it("decodes only inline raster logos", () => {
    const d = decodeInlineLogo(PNG);
    expect(d?.contentType).toBe("image/png");
    expect(d?.bytes.length).toBeGreaterThan(0);
    expect(decodeInlineLogo("data:image/jpg;base64,AAAA")?.contentType).toBe("image/jpeg");
    expect(decodeInlineLogo("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(decodeInlineLogo("https://example.com/logo.png")).toBeNull();
    expect(decodeInlineLogo(null)).toBeNull();
  });
});
