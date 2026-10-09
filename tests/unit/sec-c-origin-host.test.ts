// Security campaign lane C — SEC-042 (the origin gate itself) and SEC-045
// (host-header abuse in generated links). Unit level; the route-by-route sweep
// is tests/unit/sec-c-csrf-sweep.test.ts and the live-server probe is
// docs/security/evidence/C/scripts/http-probe.mjs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertSameOrigin } from "@/lib/csrf";
import { getBaseUrl } from "@/lib/env-url";

const saved: Record<string, string | undefined> = {};
const KEYS = ["NEXTAUTH_URL", "VERCEL_URL", "NEXT_PUBLIC_VERCEL_URL", "NODE_ENV"];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.NEXTAUTH_URL = "https://matflow.studio";
  delete process.env.VERCEL_URL;
  delete process.env.NEXT_PUBLIC_VERCEL_URL;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
});

const post = (headers: Record<string, string>) =>
  new Request("https://matflow.studio/api/x", { method: "POST", headers: { host: "matflow.studio", ...headers } });

describe("SEC-042 assertSameOrigin", () => {
  it("positive control: the app's own origin passes", () => {
    expect(assertSameOrigin(post({ origin: "https://matflow.studio" }))).toBeNull();
  });
  it("positive control: a same-origin Referer passes when Origin is absent", () => {
    expect(assertSameOrigin(post({ referer: "https://matflow.studio/dashboard" }))).toBeNull();
  });
  it.each([
    ["foreign origin", { origin: "https://evil.example" }],
    ["sibling subdomain (same-site, cross-origin)", { origin: "https://evil.matflow.studio" }],
    ["suffix trick", { origin: "https://matflow.studio.evil.example" }],
    ["opaque origin (sandboxed iframe, data: page)", { origin: "null" }],
    ["no Origin and no Referer", {}],
    ["foreign Referer", { referer: "https://evil.example/matflow.studio" }],
    ["malformed Referer", { referer: "not a url" }],
    ["port variant", { origin: "https://matflow.studio:8443" }],
  ])("refuses %s with 403", (_label, headers) => {
    const res = assertSameOrigin(post(headers as Record<string, string>));
    expect(res?.status).toBe(403);
  });
  it("a foreign Origin is refused even when the Referer is same-origin (Origin wins)", () => {
    expect(assertSameOrigin(post({ origin: "https://evil.example", referer: "https://matflow.studio/x" }))?.status).toBe(403);
  });
  it("safe methods are not gated", () => {
    expect(assertSameOrigin(new Request("https://matflow.studio/api/x", { method: "GET", headers: { origin: "https://evil.example" } }))).toBeNull();
  });
  it("documented residual: http:// on the request's own host is accepted (HSTS preload keeps browsers on https)", () => {
    expect(assertSameOrigin(post({ origin: "http://matflow.studio" }))).toBeNull();
  });
});

describe("SEC-045 generated links ignore a forged Host when NEXTAUTH_URL is set", () => {
  it("getBaseUrl returns NEXTAUTH_URL, never the request host", () => {
    const req = new Request("https://evil.example/api/magic-link/request", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
    expect(getBaseUrl(req)).toBe("https://matflow.studio");
  });
  it("trims a pasted trailing newline/slash", () => {
    process.env.NEXTAUTH_URL = "https://matflow.studio/\n";
    expect(getBaseUrl()).toBe("https://matflow.studio");
  });
  it("documented residual: without NEXTAUTH_URL the request origin is used (production sets it — evidence E-04)", () => {
    delete process.env.NEXTAUTH_URL;
    expect(getBaseUrl(new Request("https://evil.example/x"))).toBe("https://evil.example");
  });
});
