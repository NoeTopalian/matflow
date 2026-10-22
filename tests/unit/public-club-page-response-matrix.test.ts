// T9c identical-response matrix (ticket T9c, Tests §2; acceptance 1 and 7).
//
// Every slug that is not a published, admitted club — unknown, opted out,
// suspended, cancelled, deleted, and a failed lookup — must answer EXACTLY
// like an unknown slug: the same redirect to the branded login and the same
// noindex metadata. Only a published club renders, and only it is indexable.
// Review-locked clubs may publish (Q9 E-10 proposed default) without prices.
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { ReactElement } from "react";

const { gateRows, contentCalls, authMock, gateReads, ip } = vi.hoisted(() => ({
  gateRows: new Map<string, Record<string, unknown> | "throw">(),
  contentCalls: [] as { tenantId: string; model: string; args: Record<string, unknown> }[],
  authMock: vi.fn(),
  gateReads: { n: 0 },
  ip: { value: "203.0.113.7" },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-vercel-forwarded-for": ip.value }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/auth", () => ({ auth: authMock }));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: {
        findUnique: async ({ where, select }: { where: { slug: string }; select: Record<string, unknown> }) => {
          // The gate read must stay on its fixed field list.
          expect(Object.keys(select).sort()).toEqual(["deletedAt", "id", "publicPageEnabled", "subscriptionStatus"]);
          gateReads.n++;
          const row = gateRows.get(where.slug);
          if (row === "throw") throw new Error("db down");
          return row ?? null;
        },
      },
    }),
  withTenantContext: async <T,>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const rec = (model: string, result: unknown) => async (args: Record<string, unknown>) => {
      contentCalls.push({ tenantId, model, args });
      return result;
    };
    return fn({
      tenant: {
        findFirst: rec("tenant", {
          name: `Club ${tenantId}`,
          slug: `slug-${tenantId}`,
          logoUrl: "data:image/png;base64,iVBORw0KGgo=",
          logoSize: "md",
          primaryColor: "#3b82f6",
          secondaryColor: "#2563eb",
          textColor: "#ffffff",
          bgColor: "#111111",
          fontFamily: "'Inter', sans-serif",
          publicPageDescription: null,
          publicPageEmail: null,
          publicPagePhone: null,
          publicPageAddress: null,
          websiteUrl: null,
          instagramUrl: null,
          facebookUrl: null,
          tiktokUrl: null,
          youtubeUrl: null,
          twitterUrl: null,
          reviewLockedAt: tenantId === "t-locked" ? new Date() : null,
        }),
      },
      class: { findMany: rec("class", []) },
      membershipTier: {
        findMany: rec("tier", [
          { id: "tier1", name: "Unlimited", description: null, pricePence: 6000, currency: "GBP", billingCycle: "monthly", isKids: false },
        ]),
      },
    });
  },
}));

import ClubSlugPage, { generateMetadata } from "@/app/[slug]/page";
import { forgetPublicGate, resolvePublishedClubId } from "@/lib/public-club-page-server";

const active = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subscriptionStatus: "active",
  deletedAt: null,
  publicPageEnabled: true,
  ...over,
});

beforeEach(() => {
  forgetPublicGate();
  gateReads.n = 0;
  ip.value = "203.0.113.7";
  gateRows.clear();
  contentCalls.length = 0;
  authMock.mockReset();
  authMock.mockResolvedValue(null);
  gateRows.set("published", active("t-pub"));
  gateRows.set("locked", active("t-locked"));
  gateRows.set("optedout", active("t-off", { publicPageEnabled: false }));
  gateRows.set("suspended", active("t-sus", { subscriptionStatus: "suspended" }));
  gateRows.set("cancelled", active("t-can", { subscriptionStatus: "cancelled" }));
  gateRows.set("deleted", active("t-del", { deletedAt: new Date() }));
  gateRows.set("outage", "throw");
});

async function respond(slug: string, search: Record<string, string> = {}) {
  const params = Promise.resolve({ slug });
  const meta = await generateMetadata({ params });
  try {
    const el = await ClubSlugPage({ params, searchParams: Promise.resolve(search) });
    return { meta, outcome: "rendered" as const, el };
  } catch (e) {
    return { meta, outcome: (e as Error).message, el: null };
  }
}

describe("T9c /[slug] identical-response matrix", () => {
  it("unknown, opted-out, suspended, cancelled, deleted and outage answer exactly like an unknown slug", async () => {
    const unknown = await respond("nosuchclub");
    expect(unknown.outcome).toBe("REDIRECT:/login?club=nosuchclub");
    expect(unknown.meta).toEqual({ robots: { index: false, follow: false } });

    for (const slug of ["optedout", "suspended", "cancelled", "deleted", "outage"]) {
      const r = await respond(slug);
      expect(r.outcome, slug).toBe(`REDIRECT:/login?club=${slug}`);
      expect(r.meta, slug).toEqual(unknown.meta);
    }
    // No content read ran for any of them.
    expect(contentCalls).toEqual([]);
  });

  it("a reserved or empty segment is a 404, as before", async () => {
    expect((await respond("dashboard")).outcome).toBe("NOT_FOUND");
    expect((await respond("!!!")).outcome).toBe("NOT_FOUND");
  });

  it("a published club renders, indexable, and every content read is scoped to that club", async () => {
    const r = await respond("Published");
    expect(r.outcome).toBe("rendered");
    expect(r.meta.robots).toEqual({ index: true, follow: true });
    expect(contentCalls.length).toBeGreaterThan(0);
    for (const c of contentCalls) {
      expect(c.tenantId).toBe("t-pub");
      const where = c.args.where as Record<string, unknown>;
      expect(c.model === "tenant" ? where.id : where.tenantId, c.model).toBe("t-pub");
    }
    const tierCall = contentCalls.find((c) => c.model === "tier")!;
    expect(tierCall.args.where).toEqual({ tenantId: "t-pub", isActive: true, showOnPublicPage: true });
  });

  it("a review-locked club may publish, but without prices", async () => {
    const r = await respond("locked");
    expect(r.outcome).toBe("rendered");
    const props = (r.el as { props: { page: { tiers: unknown[] } } }).props;
    expect(props.page.tiers).toEqual([]);
  });

  it("?preview=1 is the owner's own preview only; anyone else gets the login door", async () => {
    // Anonymous.
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
    // Owner of a different club.
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-other", role: "owner" } });
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
    // A coach of the club itself.
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-off", role: "coach" } });
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
    // The owner of a suspended club.
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-sus", role: "owner" } });
    expect((await respond("suspended", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=suspended");
    // The club's own owner: preview renders, still noindex.
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-off", role: "owner" } });
    const own = await respond("optedout", { preview: "1" });
    expect(own.outcome).toBe("rendered");
    expect((own.el as { props: { preview?: boolean } }).props.preview).toBe(true);
    expect(own.meta).toEqual({ robots: { index: false, follow: false } });
  });

  it("?preview=1 refuses an owner session that is half signed in", async () => {
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-off", role: "owner", totpPending: true } });
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-off", role: "owner", mustChangePassword: true } });
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
    authMock.mockResolvedValue({ user: { tenantId: "t-off", role: "owner" } });
    expect((await respond("optedout", { preview: "1" })).outcome).toBe("REDIRECT:/login?club=optedout");
  });

  it("the published page points the logo at the cacheable route; only the owner preview inlines it", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const published = renderToStaticMarkup((await respond("published")).el as ReactElement);
    expect(published).toContain('src="/api/tenant/slug-t-pub/logo"');
    expect(published).not.toContain("data:image/png");
    // No tier id reaches the markup.
    expect(published).not.toContain("tier1");

    authMock.mockResolvedValue({ user: { id: "u", tenantId: "t-off", role: "owner" } });
    const preview = renderToStaticMarkup((await respond("optedout", { preview: "1" })).el as ReactElement);
    expect(preview).toContain("data:image/png;base64");
  });
});

describe("T9c gate throttle", () => {
  it("caches each slug's answer, so a burst on one slug is one read", async () => {
    for (let i = 0; i < 5; i++) expect(await resolvePublishedClubId("published", { clientIp: "a" })).toBe("t-pub");
    for (let i = 0; i < 5; i++) expect(await resolvePublishedClubId("nosuch", { clientIp: "a" })).toBeNull();
    expect(gateReads.n).toBe(2);
  });

  it("never caches a failed lookup", async () => {
    await resolvePublishedClubId("outage");
    await resolvePublishedClubId("outage");
    expect(gateReads.n).toBe(2);
  });

  it("expires after the TTL and can be forgotten after a save", async () => {
    const t0 = 1_000_000;
    await resolvePublishedClubId("published", { now: t0 });
    await resolvePublishedClubId("published", { now: t0 + 29_000 });
    expect(gateReads.n).toBe(1);
    await resolvePublishedClubId("published", { now: t0 + 31_000 });
    expect(gateReads.n).toBe(2);
    forgetPublicGate("Published");
    await resolvePublishedClubId("published", { now: t0 + 32_000 });
    expect(gateReads.n).toBe(3);
  });

  it("fresh skips the cache (the logo route)", async () => {
    await resolvePublishedClubId("published");
    await resolvePublishedClubId("published", { fresh: true });
    expect(gateReads.n).toBe(2);
  });

  it("a visitor over the cache-miss budget gets the unknown-slug answer, with no read", async () => {
    const now = 5_000_000;
    for (let i = 0; i < 120; i++) await resolvePublishedClubId(`random-${i}`, { clientIp: "flood", now });
    expect(gateReads.n).toBe(120);
    // Over budget: even a published club answers like an unknown slug, and no
    // database read happens.
    expect(await resolvePublishedClubId("published", { clientIp: "flood", now })).toBeNull();
    expect(gateReads.n).toBe(120);
    // Another visitor is unaffected; the flood's budget refills after a minute.
    expect(await resolvePublishedClubId("published", { clientIp: "other", now })).toBe("t-pub");
    forgetPublicGate("published");
    expect(await resolvePublishedClubId("published", { clientIp: "flood", now: now + 61_000 })).toBe("t-pub");
  });

  it("the page answers an over-budget visitor with the same redirect as an unknown slug", async () => {
    ip.value = "198.51.100.9";
    for (let i = 0; i < 120; i++) await resolvePublishedClubId(`random-${i}`, { clientIp: ip.value });
    const r = await respond("published");
    expect(r.outcome).toBe("REDIRECT:/login?club=published");
    expect(r.meta).toEqual({ robots: { index: false, follow: false } });
  });
});
