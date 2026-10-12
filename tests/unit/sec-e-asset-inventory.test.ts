/**
 * Security campaign lane E (9 Oct 2026): asset-inventory invariants (map level, not an authorization proof).
 * Cron routes must check CRON_SECRET, webhooks must verify a signature, and operator-plane routes must resolve an
 * operator. A new route that breaks the pattern fails here and gets a human look. Lanes B/C own behavioural tests.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyseRoute, classify, routeUrl } from "../../scripts/readiness/asset-inventory.mjs";

const ROOT = path.resolve(__dirname, "../..");

function routes() {
  const out: Array<{ url: string; guards: Array<string | RegExp>; methods: string[] }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^route\.tsx?$/.test(e.name)) {
        const a = analyseRoute(fs.readFileSync(p, "utf8"));
        out.push({ url: routeUrl(path.relative(ROOT, p)), guards: a.guards, methods: a.methods });
      }
    }
  };
  walk(path.join(ROOT, "app"));
  return out;
}

describe("asset-inventory helpers", () => {
  it("maps file paths to URL patterns", () => {
    expect(routeUrl(path.join("app", "api", "members", "[id]", "route.ts"))).toBe("/api/members/[id]");
    expect(routeUrl(path.join("app", "(group)", "api", "x", "route.ts"))).toBe("/api/x");
  });
  it("classifies areas", () => {
    expect(classify("/api/cron/retention")).toBe("cron");
    expect(classify("/api/admin/customers")).toBe("operator");
    expect(classify("/api/members/1")).toBe("staff/tenant");
    expect(classify("/api/member/profile")).toBe("member");
  });
  it("detects guard markers (positive and negative control)", () => {
    expect(analyseRoute('export async function GET(){ const e = process.env.CRON_SECRET; }').guards).toContain("cronSecret");
    expect(analyseRoute("export async function GET(){ return 1 }").guards).toEqual([]);
  });
});

describe("repository route invariants", () => {
  const all = routes();

  it("finds the full route surface", () => {
    expect(all.length).toBeGreaterThanOrEqual(200);
    expect(all.every((r) => r.methods.length > 0)).toBe(true);
  });

  it("every cron route checks CRON_SECRET", () => {
    const cron = all.filter((r) => r.url.startsWith("/api/cron/"));
    expect(cron.length).toBeGreaterThanOrEqual(3);
    expect(cron.filter((r) => !r.guards.includes("cronSecret")).map((r) => r.url)).toEqual([]);
  });

  it("every webhook route verifies a signature", () => {
    const hooks = all.filter((r) => r.url.startsWith("/api/webhooks/") || r.url === "/api/stripe/webhook");
    expect(hooks.length).toBeGreaterThanOrEqual(2);
    expect(hooks.filter((r) => !r.guards.some((g) => /Signature$/.test(String(g)))).map((r) => r.url)).toEqual([]);
  });

  it("every operator-plane route resolves an operator (tenant-owner routes under /api/admin are listed explicitly)", () => {
    const TENANT_OWNER_UNDER_ADMIN = /^\/api\/admin\/(import|dsar|email\/test)(\/|$)/;
    const PRE_AUTH = new Set([
      "/api/admin/auth/login",
      "/api/admin/auth/logout",
      "/api/admin/auth/operator-login",
      "/api/admin/auth/operator-totp",
    ]);
    const offenders = all
      .filter((r) => r.url.startsWith("/api/admin/"))
      .filter((r) => !TENANT_OWNER_UNDER_ADMIN.test(r.url) && !PRE_AUTH.has(r.url))
      .filter((r) => !r.guards.includes("operator"))
      .map((r) => r.url);
    expect(offenders).toEqual([]);
  });

  it("tenant-owner routes under /api/admin carry an owner/role marker", () => {
    const owner = all.filter((r) => /^\/api\/admin\/(import|dsar|email\/test)(\/|$)/.test(r.url));
    expect(owner.length).toBe(15);
    expect(owner.filter((r) => !r.guards.some((g) => ["owner", "role", "ownerOrManager", "magicLinkToken"].includes(String(g)))).map((r) => r.url)).toEqual([]);
  });
});
