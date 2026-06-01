/**
 * Area 7 — Infra config contract: security headers + auth cache-control.
 *
 * Locks two iter-1 closures from next.config.ts:
 *
 *   1. Security headers contract — every response from "/" must carry the
 *      full OWASP-recommended header set configured in the `/(.*)`
 *      catch-all rule.  Asserting exact HSTS value and presence-only for
 *      CSP/Permissions-Policy keeps the test stable without being brittle
 *      about the full CSP string (which differs between dev and prod).
 *
 *   2. Auth endpoint cache-control — /api/auth/session must return
 *      `private, no-store` so intermediaries and the browser BFCache never
 *      serve a stale authenticated session payload.
 *
 * Both tests use `page.goto` + `response.headers()` rather than the
 * `request` fixture so that Next.js middleware and the `headers()` config
 * both execute (the `request` fixture bypasses the full server pipeline on
 * some Next.js versions).
 *
 * No DB interaction.  Deterministic on any running server instance.
 * Both "chromium" and "Mobile Chrome" Playwright projects must pass.
 */
import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Helper — fetch a URL and return its response headers as a plain object.
// We navigate to the URL with `page.goto` so the full Next.js pipeline runs
// (including headers() config) and capture the response object it returns.
// ---------------------------------------------------------------------------
async function fetchHeaders(
  page: Page,
  url: string,
): Promise<Record<string, string>> {
  const response = await page.goto(url);
  if (!response) {
    throw new Error(`No response received for ${url}`);
  }
  return response.headers();
}

// ---------------------------------------------------------------------------
// 1. Security headers contract
// ---------------------------------------------------------------------------
test.describe("Security headers — every response from /", () => {
  let headers: Record<string, string>;

  test.beforeEach(async ({ page }) => {
    headers = await fetchHeaders(page, "/");
  });

  test("Strict-Transport-Security includes 2-year max-age", async () => {
    const hsts = headers["strict-transport-security"] ?? "";
    expect(hsts).toContain("max-age=63072000");
  });

  test("Strict-Transport-Security includes includeSubDomains", async () => {
    const hsts = headers["strict-transport-security"] ?? "";
    expect(hsts).toContain("includeSubDomains");
  });

  test("Strict-Transport-Security includes preload directive", async () => {
    const hsts = headers["strict-transport-security"] ?? "";
    expect(hsts).toContain("preload");
  });

  test("X-Frame-Options is DENY", async () => {
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("X-Content-Type-Options is nosniff", async () => {
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  test("Content-Security-Policy header is present and non-empty", async () => {
    const csp = headers["content-security-policy"] ?? "";
    expect(csp.length).toBeGreaterThan(0);
  });

  test("Permissions-Policy header is present and non-empty", async () => {
    const pp = headers["permissions-policy"] ?? "";
    expect(pp.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Auth endpoint cache-control contract
// ---------------------------------------------------------------------------
test.describe("Auth endpoint cache-control — /api/auth/session", () => {
  test("Cache-Control contains 'private'", async ({ page }) => {
    const headers = await fetchHeaders(page, "/api/auth/session");
    const cc = headers["cache-control"] ?? "";
    expect(cc).toContain("private");
  });

  test("Cache-Control contains 'no-store'", async ({ page }) => {
    const headers = await fetchHeaders(page, "/api/auth/session");
    const cc = headers["cache-control"] ?? "";
    expect(cc).toContain("no-store");
  });
});
