// T9c search-engine plumbing: the sitemap lists only published, admitted,
// non-reserved clubs; robots keeps every private surface disallowed; the logo
// route serves only a published club's inline logo.
import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  gate: new Map<string, Record<string, unknown>>(),
  logo: null as string | null,
  fail: false,
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (h.fail) throw new Error("db down");
    return fn({
      tenant: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => {
          expect(where).toMatchObject({ publicPageEnabled: true, deletedAt: null });
          return h.rows;
        },
        findUnique: async ({ where }: { where: { slug: string } }) => h.gate.get(where.slug) ?? null,
      },
    });
  },
  withTenantContext: async <T,>(tenantId: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      tenant: {
        findFirst: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
          expect(where.id).toBe(tenantId);
          expect(select).toEqual({ logoUrl: true });
          return { logoUrl: h.logo };
        },
      },
    }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.1",
}));

import sitemap from "@/app/sitemap";
import robots from "@/app/robots";
import { GET as logoGET } from "@/app/api/tenant/[slug]/logo/route";

const row = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `t-${slug}`,
  slug,
  subscriptionStatus: "active",
  deletedAt: null,
  publicPageEnabled: true,
  publicPageEnabledAt: new Date("2026-10-17T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  h.rows = [];
  h.gate.clear();
  h.logo = null;
  h.fail = false;
});

describe("app/sitemap.ts", () => {
  it("adds published clubs to the static pages, skipping reserved, unadmitted and malformed slugs", async () => {
    h.rows = [
      row("northside"),
      row("dashboard"), // reserved: never a club page
      row("pastdue", { subscriptionStatus: "past_due" }),
      row("paused", { subscriptionStatus: "SUSPENDED" }),
      row("Mixed_Case"),
    ];
    const out = await sitemap();
    const urls = out.map((e) => e.url);
    expect(urls).toContain("https://matflow.studio/");
    expect(urls).toContain("https://matflow.studio/northside");
    expect(urls).toContain("https://matflow.studio/pastdue");
    expect(urls).not.toContain("https://matflow.studio/dashboard");
    expect(urls).not.toContain("https://matflow.studio/paused");
    expect(urls.some((u) => u.includes("Mixed_Case"))).toBe(false);
  });

  it("still serves the static pages when the club list cannot be read", async () => {
    h.fail = true;
    const out = await sitemap();
    expect(out.map((e) => e.url)).toEqual([
      "https://matflow.studio/",
      "https://matflow.studio/apply",
      "https://matflow.studio/legal/terms",
      "https://matflow.studio/legal/privacy",
      "https://matflow.studio/legal/aup",
      "https://matflow.studio/legal/subprocessors",
    ]);
  });
});

// Google's robots.txt semantics (RFC 9309): a rule matches by prefix, "*" is
// any run of characters, a trailing "$" anchors the end of the URL, and the
// longest matching rule wins (allow wins a tie).
function robotsAllows(path: string, allow: string[], disallow: string[]): boolean {
  const toRe = (rule: string) => {
    const anchored = rule.endsWith("$");
    const body = (anchored ? rule.slice(0, -1) : rule)
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`);
  };
  const best = (rules: string[]) =>
    rules.filter((r) => toRe(r).test(path)).reduce((n, r) => Math.max(n, r.length), -1);
  const a = best(allow);
  const d = best(disallow);
  return d < 0 || a >= d;
}

describe("app/robots.ts", () => {
  const r = robots();
  const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
  const allow = ([] as string[]).concat(rule.allow ?? []);
  const disallow = ([] as string[]).concat(rule.disallow ?? []);
  const allowed = (p: string) => robotsAllows(p, allow, disallow);

  it("keeps every private surface disallowed, bare and below, with or without a query", () => {
    for (const p of [
      "/login", "/login?club=northside", "/dashboard", "/dashboard/members", "/member", "/member/home",
      "/admin", "/admin/hub", "/api/settings", "/kiosk/abc", "/onboarding", "/set-password",
      "/set-password?token=x", "/waiver", "/waiver/abc", "/leaderboard/tok", "/print/x", "/preview",
    ]) {
      expect(allowed(p), p).toBe(false);
    }
    expect(r.sitemap).toBe("https://matflow.studio/sitemap.xml");
  });

  it("allows the marketing pages, club pages and the club logo for link previews", () => {
    for (const p of ["/", "/apply", "/legal/terms", "/northside", "/api/tenant/northside/logo"]) {
      expect(allowed(p), p).toBe(true);
    }
  });

  it("allows a club whose slug merely starts with a private segment", () => {
    for (const p of ["/loginbjj", "/waiverly", "/preview-bjj", "/set-password-club", "/memberships-bjj", "/dashboardgym"]) {
      expect(allowed(p), p).toBe(true);
    }
  });
});

describe("GET /api/tenant/[slug]/logo", () => {
  const call = (slug: string) =>
    logoGET(new Request(`http://localhost/api/tenant/${slug}/logo`), { params: Promise.resolve({ slug }) });

  it("serves a published club's inline logo with a short shared cache", async () => {
    h.gate.set("northside", row("northside"));
    h.logo = "data:image/png;base64,iVBORw0KGgo=";
    const res = await call("northside");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60");
  });

  it("answers the same 404 for unknown, unpublished, suspended and non-inline logos", async () => {
    h.gate.set("optedout", row("optedout", { publicPageEnabled: false }));
    h.gate.set("paused", row("paused", { subscriptionStatus: "suspended" }));
    h.gate.set("bloblogo", row("bloblogo"));
    h.logo = "https://abc.public.blob.vercel-storage.com/tenants/t-bloblogo/logo.png";
    const bodies = [];
    for (const slug of ["nosuch", "optedout", "paused", "bloblogo"]) {
      const res = await call(slug);
      expect(res.status, slug).toBe(404);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });
});
