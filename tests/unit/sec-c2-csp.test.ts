/**
 * SF-30 / SEC-041 / SEC-044 — per-request nonce CSP (security campaign iteration 2, lane C2, 9 Oct 2026).
 *
 * The static policy (next.config.ts) allows 'unsafe-inline' scripts. proxy.ts now mints a nonce per
 * document request and sends the strict policy from lib/csp.ts — report-only unless
 * MATFLOW_CSP_ENFORCE is "1"/"true" — and forwards it on the REQUEST so Next stamps the nonce on its
 * scripts. Driven through the real proxy.ts with NextAuth's wrapper replaced by a counting pass-through.
 *
 * Red (recorded in docs/security/evidence/C2/02-csp-red-green.log): against the HEAD proxy.ts every
 * proxy-level cell fails — no nonce policy on any document, nothing forwarded, kiosk/leaderboard not in
 * the matcher.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const h = vi.hoisted(() => ({ authCalls: 0, session: null as null | Record<string, unknown> }));
vi.mock("@/auth", () => ({
  auth: (fn: (req: Record<string, unknown>, ev?: unknown) => unknown) =>
    async (req: Record<string, unknown>, ev?: unknown) => {
      h.authCalls++;
      req.auth = h.session;
      return fn(req, ev);
    },
}));

import { buildNonceCsp, cspMode, newNonce, CONNECT_HOSTS, SCRIPT_HOSTS, isTokenDocumentPath } from "@/lib/csp";

const OWNER = { user: { id: "u-c2", tenantId: "t-c2", role: "owner" } };

function mkReq(pathname: string, headers: Record<string, string> = {}) {
  const url = `http://localhost:3999${pathname}`;
  return {
    nextUrl: new URL(url),
    url,
    method: "GET",
    headers: new Headers(headers),
    cookies: { get: () => undefined },
  };
}

async function run(pathname: string, headers: Record<string, string> = {}): Promise<Response> {
  const mod = await import("../../proxy");
  return (mod.default as unknown as (r: unknown, e?: unknown) => Promise<Response>)(mkReq(pathname, headers), undefined);
}

const policyOf = (res: Response) =>
  res.headers.get("content-security-policy-report-only") ?? res.headers.get("content-security-policy");
const nonceIn = (policy: string | null) => policy?.match(/'nonce-([^']+)'/)?.[1] ?? null;
const scriptSrc = (policy: string) => policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) ?? "";
/** What Next will see on the forwarded request (NextResponse.next({ request: { headers } }) protocol). */
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

beforeEach(() => {
  h.authCalls = 0;
  h.session = null;
  delete process.env.MATFLOW_CSP_ENFORCE;
});

describe("lib/csp policy", () => {
  it("is report-only unless MATFLOW_CSP_ENFORCE is exactly 1/true", () => {
    expect(cspMode({})).toBe("report-only");
    for (const v of ["", "0", "false", "yes", "on", "enforce"]) expect(cspMode({ MATFLOW_CSP_ENFORCE: v })).toBe("report-only");
    for (const v of ["1", "true", "TRUE", " true "]) expect(cspMode({ MATFLOW_CSP_ENFORCE: v })).toBe("enforce");
  });

  it("scripts: nonce + strict-dynamic, never 'unsafe-inline'; 'unsafe-eval' only in development", () => {
    const n = newNonce();
    const prod = buildNonceCsp(n, { isDev: false, mode: "report-only" });
    const s = scriptSrc(prod);
    expect(s).toContain(`'nonce-${n}'`);
    expect(s).toContain("'strict-dynamic'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
    expect(scriptSrc(buildNonceCsp(n, { isDev: true, mode: "report-only" }))).toContain("'unsafe-eval'");
    for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'", "worker-src 'self'", "report-uri /api/csp-report", "report-to csp-endpoint"]) {
      expect(prod).toContain(d);
    }
    // upgrade-insecure-requests is ignored in a report-only policy; only sent when enforcing in production.
    expect(prod).not.toContain("upgrade-insecure-requests");
    expect(buildNonceCsp(n, { isDev: false, mode: "enforce" })).toContain("upgrade-insecure-requests");
  });

  it("refuses a nonce that could break out of the source list", () => {
    for (const bad of ["abc' 'unsafe-inline", "short", "a;b=cdefghijklmnopqrstuv", ""]) {
      expect(() => buildNonceCsp(bad, { isDev: false, mode: "enforce" })).toThrow();
    }
  });

  it("nonces are 128-bit and do not repeat (1000 draws)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const n = newNonce();
      expect(Buffer.from(n, "base64").length).toBe(16);
      seen.add(n);
    }
    expect(seen.size).toBe(1000);
  });

  it("connect-src and script hosts match the static next.config.ts policy (no silent drift)", async () => {
    const cfg = (await import("../../next.config")).default;
    const rules = await cfg.headers!();
    const staticCsp = rules.flatMap((r) => r.headers).find((x) => x.key === "Content-Security-Policy")!.value;
    const connect = staticCsp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "))!;
    for (const host of CONNECT_HOSTS) expect(connect).toContain(host);
    const staticScripts = scriptSrc(staticCsp);
    for (const host of SCRIPT_HOSTS) expect(staticScripts).toContain(host);
  });
});

describe("proxy.ts sends the nonce policy on documents (SF-30)", () => {
  it.each(["/login", "/", "/apply", "/legal/privacy", "/waiver/tok-c2", "/totalbjj"])(
    "public document %s: report-only nonce policy on the response AND forwarded to the renderer",
    async (path) => {
      const res = await run(path);
      expect(res.headers.get("content-security-policy-report-only")).toBeTruthy();
      const n = nonceIn(policyOf(res));
      expect(n).toBeTruthy();
      expect(forwarded(res, "content-security-policy-report-only")).toContain(`'nonce-${n}'`);
      expect(forwarded(res, "x-nonce")).toBe(n);
      expect(res.headers.get("reporting-endpoints")).toBe('csp-endpoint="/api/csp-report"');
    },
  );

  it("signed-in staff dashboard and member portal pages carry it too", async () => {
    h.session = OWNER;
    const dash = await run("/dashboard/members");
    expect(nonceIn(policyOf(dash))).toBeTruthy();
    h.session = { user: { id: "m-c2", tenantId: "t-c2", role: "member" } };
    const portal = await run("/member/home");
    expect(nonceIn(policyOf(portal))).toBeTruthy();
  });

  it("a fresh nonce per request", async () => {
    const a = nonceIn(policyOf(await run("/login")));
    const b = nonceIn(policyOf(await run("/login")));
    expect(a && b && a !== b).toBe(true);
  });

  it("a client-supplied CSP or x-nonce request header cannot choose the nonce Next renders with", async () => {
    const res = await run("/login", {
      "content-security-policy": "script-src 'nonce-AttackerChosenNonce0=='",
      "content-security-policy-report-only": "script-src 'nonce-AttackerChosenNonce0=='",
      "x-nonce": "AttackerChosenNonce0==",
    });
    const n = nonceIn(policyOf(res));
    expect(forwarded(res, "x-nonce")).toBe(n);
    expect(forwarded(res, "content-security-policy-report-only")).not.toContain("Attacker");
    // The enforcing request header the client sent is dropped, not forwarded alongside.
    expect(forwarded(res, "content-security-policy")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toMatch(/(^|,)content-security-policy(,|$)/);
  });

  it("MATFLOW_CSP_ENFORCE=1 switches to the enforcing header (and only that one)", async () => {
    process.env.MATFLOW_CSP_ENFORCE = "1";
    const res = await run("/login");
    expect(res.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(res.headers.get("content-security-policy-report-only")).toBeNull();
    expect(forwarded(res, "content-security-policy")).toBe(res.headers.get("content-security-policy"));
  });

  it("API responses get no document policy (JSON, not documents)", async () => {
    h.session = OWNER;
    const res = await run("/api/members");
    expect(policyOf(res)).toBeNull();
    expect(forwarded(res, "x-nonce")).toBeNull();
  });

  it.each(["/kiosk/tok-c2", "/leaderboard/tok-c2"])(
    "%s receives the policy WITHOUT the next-auth wrapper running (no session work added)",
    async (path) => {
      const res = await run(path);
      expect(nonceIn(policyOf(res))).toBeTruthy();
      expect(h.authCalls).toBe(0);
    },
  );

  it("positive control: an ordinary page does run the next-auth wrapper", async () => {
    await run("/login");
    expect(h.authCalls).toBe(1);
    expect(isTokenDocumentPath("/kiosk")).toBe(true);
    expect(isTokenDocumentPath("/kioskx")).toBe(false);
    expect(isTokenDocumentPath("/api/kiosk/x")).toBe(false);
  });
});

describe("proxy matcher after lane C2", () => {
  const source = readFileSync(resolve(__dirname, "../../proxy.ts"), "utf8");
  const pattern = source.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/)![1].replace(/\\\\/g, "\\");
  const matches = (p: string) => new RegExp(`^${pattern}$`).test(p);

  it("kiosk and leaderboard documents enter the proxy; their APIs and the report sink do not", () => {
    expect(matches("/kiosk/abc123")).toBe(true);
    expect(matches("/leaderboard/abc123def456ghij")).toBe(true);
    expect(matches("/api/kiosk/abc123/checkin")).toBe(false);
    expect(matches("/api/csp-report")).toBe(false);
    // The exclusion is exact: a route that merely starts with the same letters still runs the proxy.
    expect(matches("/api/csp-reports-admin")).toBe(true);
  });
});

describe("root layout renders per request (nonce needs a dynamic render)", () => {
  it("app/layout.tsx awaits connection()", () => {
    const src = readFileSync(resolve(__dirname, "../../app/layout.tsx"), "utf8");
    expect(src).toMatch(/await connection\(\)/);
  });
});
