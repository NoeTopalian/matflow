// T9c identical-response matrix (ticket T9c, Tests §2; acceptance 1 and 7).
//
// Every slug that is not a published, admitted club — unknown, opted out,
// suspended, cancelled, deleted, and a failed lookup — must answer EXACTLY
// like an unknown slug: the same redirect to the branded login and the same
// noindex metadata. Only a published club renders, and only it is indexable.
// Review-locked clubs may publish (Q9 E-10 proposed default) without prices.
import { vi, describe, it, expect, beforeEach } from "vitest";

const { gateRows, contentCalls, authMock } = vi.hoisted(() => ({
  gateRows: new Map<string, Record<string, unknown> | "throw">(),
  contentCalls: [] as { tenantId: string; model: string; args: Record<string, unknown> }[],
  authMock: vi.fn(),
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
          logoUrl: null,
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

const active = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  subscriptionStatus: "active",
  deletedAt: null,
  publicPageEnabled: true,
  ...over,
});

beforeEach(() => {
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
});
