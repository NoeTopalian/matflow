// The proxy matcher decides which requests reach middleware at all. Anything
// the document links *before* the user authenticates has to be excluded, or
// the browser follows a 307 to /login and renders an HTML page where an asset
// belongs. That is how the iOS home-screen icon broke: `apple-touch-icon.png`
// was linked in every response but missing from the exclusion list.
//
// The pattern is read from source rather than imported, because importing
// proxy.ts pulls in NextAuth and the whole session stack for what is really an
// assertion about one config string.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// proxy.ts wraps its handler in NextAuth's `auth()`. Mocking that to the
// identity function lets this file import the module for the pure helper below
// without dragging in the session stack, Prisma or an adapter.
vi.mock("@/auth", () => ({ auth: (fn: unknown) => fn }));

const source = readFileSync(resolve(__dirname, "../../proxy.ts"), "utf8");

/** The single matcher entry in `export const config`. */
function matcherPattern(): string {
  const match = source.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) throw new Error("could not find the matcher pattern in proxy.ts");
  // The literal is a JS string containing regex escapes (\\. in source is \. in the value).
  return match[1].replace(/\\\\/g, "\\");
}

const matches = (path: string) => new RegExp(`^${matcherPattern()}$`).test(path);

describe("proxy matcher", () => {
  // Each of these is referenced by an unauthenticated document or by the OS
  // itself. A 307 here is a silently broken asset, never an error anyone sees.
  it.each([
    "/favicon.ico",
    "/apple-touch-icon.png",
    "/icon.png",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/manifest.webmanifest",
    "/robots.txt",
    "/sitemap.xml",
  ])("does not run middleware for %s", (path) => {
    expect(matches(path)).toBe(false);
  });

  // Endpoints that authenticate themselves at the route-handler level, via
  // signature, bearer secret or HMAC token.
  it.each([
    "/api/webhooks/resend",
    "/api/stripe/webhook",
    "/api/cron/retention",
    "/api/health",
    "/api/kiosk/abc123/checkin",
    "/api/magic-link/verify",
  ])("does not run middleware for %s", (path) => {
    expect(matches(path)).toBe(false);
  });

  // NextAuth's own endpoints. The `auth()` wrapper this file's default export
  // is wrapped in makes an internal session request and APPENDS that response's
  // cookies to the route's own (`next-auth/lib/index.js:182-185`), so running it
  // in front of `/api/auth/csrf` — whose entire job is to set
  // `authjs.csrf-token` and return the matching token — put that cookie in the
  // response twice. A browser keeps the last; a client that replays cookies in
  // header order sends the other and is refused `MissingCSRF`.
  it.each([
    "/api/auth/csrf",
    "/api/auth/session",
    "/api/auth/callback/credentials",
    "/api/auth/signout",
  ])("does not run the auth wrapper in front of NextAuth's own %s", (path) => {
    expect(matches(path)).toBe(false);
  });

  // …and the exclusion must not reach past NextAuth's handlers into the
  // hand-written routes that merely live under the same prefix. Those carry
  // real tenant data and their own `requireSession()` gates, and they must
  // still reach the middleware.
  it.each([
    "/api/authorised-somewhere",
    "/api/authz",
  ])("does not over-reach: %s still runs middleware", (path) => {
    expect(matches(path)).toBe(true);
  });

  // The exclusions must stay narrow. If one of these ever stops matching, a
  // tenant-scoped surface has escaped the middleware entirely.
  it.each([
    "/dashboard",
    "/dashboard/settings",
    "/member/home",
    "/api/members",
    "/api/member/me",
    "/admin",
  ])("still runs middleware for %s", (path) => {
    expect(matches(path)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an UNAUTHENTICATED request gets.
 *
 * A page redirected to /login is right: the browser is a person, and a person
 * needs the form. An API call redirected to /login is wrong, and wrong in the
 * most expensive way — `fetch` follows the 307, receives the login PAGE with
 * status 200 and `content-type: text/html`, and every caller that checks
 * `res.ok` reads a refused request as a successful one. Callers then either
 * render the HTML as data or, worse, treat the absence of an error as proof
 * the write landed. `components/dashboard/CardScanner.tsx:365-380` is the only
 * place in the product that guessed correctly, and it had to set
 * `redirect: "manual"` and sniff `res.type === "opaqueredirect"` to do it.
 *
 * So: `/api/*` is refused with a real 401 and the refusal body shape the rest
 * of the product uses, `{ ok: false, error }`. Pages keep the redirect, and the
 * public prefixes are untouched at both ends.
 */
describe("unauthenticated requests", () => {
  async function refuse(pathname: string) {
    const { unauthenticatedResponse } = await import("../../proxy");
    return unauthenticatedResponse(pathname, `http://localhost:3847${pathname}`, "req-test-00000001");
  }

  it.each([
    "/api/members",
    "/api/member/me",
    "/api/checkin",
    "/api/settings",
    "/api/staff",
    "/api/reports",
  ])("refuses %s with 401 JSON rather than a redirect", async (path) => {
    const res = await refuse(path);
    expect(res.status, `${path} status`).toBe(401);
    expect(res.headers.get("location"), `${path} must not redirect`).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Unauthorized" });
  });

  it.each(["/dashboard", "/dashboard/settings", "/member/home", "/member/schedule"])(
    "still redirects the page %s to /login",
    async (path) => {
      const res = await refuse(path);
      expect(res.status, `${path} status`).toBe(307);
      expect(res.headers.get("location"), `${path} location`).toContain("/login");
    },
  );

  it("does not mistake a page whose path merely begins with the letters api", async () => {
    // `/apiary` is not an API route. `startsWith("/api/")` — with the trailing
    // slash — is what keeps this a page redirect.
    const res = await refuse("/apiary");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("stamps the request id on the refusal so the 401 is traceable", async () => {
    const res = await refuse("/api/members");
    expect(res.headers.get("x-request-id")).toBe("req-test-00000001");
  });
});
