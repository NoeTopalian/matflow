// The proxy matcher decides which requests reach middleware at all. Anything
// the document links *before* the user authenticates has to be excluded, or
// the browser follows a 307 to /login and renders an HTML page where an asset
// belongs. That is how the iOS home-screen icon broke: `apple-touch-icon.png`
// was linked in every response but missing from the exclusion list.
//
// The pattern is read from source rather than imported, because importing
// proxy.ts pulls in NextAuth and the whole session stack for what is really an
// assertion about one config string.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
