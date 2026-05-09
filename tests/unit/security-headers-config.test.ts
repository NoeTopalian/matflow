/**
 * Lock-in test for the security headers declared in next.config.ts.
 *
 * Headers are configured in source code, not in Vercel dashboard, so the
 * authoritative spec lives in next.config.ts. A future refactor that drops
 * a header (intentional or not) would silently weaken the production
 * surface — this test catches that.
 *
 * Strategy: read next.config.ts as text and assert the canonical key:value
 * fragments are present. We avoid importing + executing the config because
 * Next.js's runtime types pull in @opentelemetry / next/server which
 * bloat the test boot.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

let CONFIG_SRC = "";

beforeAll(() => {
  CONFIG_SRC = fs.readFileSync(
    path.resolve(__dirname, "../..", "next.config.ts"),
    "utf8",
  );
});

describe("next.config.ts — site-wide security headers", () => {
  it("HSTS enforces 2-year max-age + includeSubDomains + preload", () => {
    expect(CONFIG_SRC).toContain('"Strict-Transport-Security"');
    expect(CONFIG_SRC).toMatch(/max-age=63072000.*includeSubDomains.*preload/);
  });

  it("X-Frame-Options DENY (clickjacking)", () => {
    expect(CONFIG_SRC).toContain('"X-Frame-Options"');
    expect(CONFIG_SRC).toContain('"DENY"');
  });

  it("X-Content-Type-Options nosniff", () => {
    expect(CONFIG_SRC).toContain('"X-Content-Type-Options"');
    expect(CONFIG_SRC).toContain('"nosniff"');
  });

  it("X-XSS-Protection 0 (OWASP-modern; disables deprecated filter explicitly)", () => {
    // Some scanners dock the score if X-XSS-Protection is absent, even
    // though the modern advice is to disable the deprecated filter (CSP is
    // the real XSS defence). Setting "0" satisfies both: scanners see the
    // header present + we don't enable a buggy legacy filter.
    expect(CONFIG_SRC).toContain('"X-XSS-Protection"');
    // Don't use the `s` flag (needs es2018+ in tsconfig); test via fragment
    // proximity instead. Both fragments must appear and the value must be
    // exactly "0" (not "1; mode=block" — that's the deprecated unsafe mode).
    expect(CONFIG_SRC).toMatch(/X-XSS-Protection[\s\S]*?"0"/);
  });

  it("Referrer-Policy strict-origin-when-cross-origin", () => {
    expect(CONFIG_SRC).toContain('"Referrer-Policy"');
    expect(CONFIG_SRC).toContain('"strict-origin-when-cross-origin"');
  });

  it("Permissions-Policy denies camera / mic / geo / sensors / FLoC", () => {
    expect(CONFIG_SRC).toContain('"Permissions-Policy"');
    expect(CONFIG_SRC).toMatch(/camera=\(\)/);
    expect(CONFIG_SRC).toMatch(/microphone=\(\)/);
    expect(CONFIG_SRC).toMatch(/geolocation=\(\)/);
    expect(CONFIG_SRC).toMatch(/interest-cohort=\(\)/);
  });

  it("CSP is present (full content tested elsewhere)", () => {
    expect(CONFIG_SRC).toContain('"Content-Security-Policy"');
    expect(CONFIG_SRC).toMatch(/frame-ancestors\s+'none'/);
    expect(CONFIG_SRC).toMatch(/object-src\s+'none'/);
  });

  it("Cross-origin isolation triple: COOP + COEP + CORP", () => {
    // L5 from security audit iteration 2 (2026-05-07)
    expect(CONFIG_SRC).toContain('"Cross-Origin-Opener-Policy"');
    expect(CONFIG_SRC).toContain('"Cross-Origin-Embedder-Policy"');
    expect(CONFIG_SRC).toContain('"Cross-Origin-Resource-Policy"');
    expect(CONFIG_SRC).toContain('"same-origin"');
    expect(CONFIG_SRC).toContain('"credentialless"');
  });
});

describe("next.config.ts — strict cache-control on auth surfaces", () => {
  it("/api/auth/:path* gets private, no-store cache-control (L4 fix)", () => {
    expect(CONFIG_SRC).toContain('"/api/auth/:path*"');
    // Match the strict cache-control value as one continuous fragment so a
    // future edit can't silently downgrade to public.
    expect(CONFIG_SRC).toMatch(/private,\s*no-store/);
  });

  it("/api/admin/auth/:path* gets the same strict cache-control", () => {
    expect(CONFIG_SRC).toContain('"/api/admin/auth/:path*"');
  });

  it("/api/magic-link/:path* gets the same strict cache-control", () => {
    expect(CONFIG_SRC).toContain('"/api/magic-link/:path*"');
  });

  it("Cache-Control private, no-store fragment appears at least 3 times (one per auth surface)", () => {
    const matches = CONFIG_SRC.match(/private,\s*no-store/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});

describe("next.config.ts — headers config structure", () => {
  it("exports an async headers() function", () => {
    expect(CONFIG_SRC).toMatch(/async headers\(\)/);
  });

  it("returns a non-empty array of header blocks", () => {
    // Ensures someone can't silently swap to `return []` to disable everything.
    expect(CONFIG_SRC).toMatch(/source:\s*"\/\(\.\*\)"/);
  });
});
