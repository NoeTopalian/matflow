/**
 * Smoke coverage for flows that previously had no e2e tests:
 *   - Kiosk check-in (public, token-based)
 *   - Parent/guardian "open" waiver (public)
 *   - Ad-hoc Stripe charge API (owner-gated; validates without a real charge)
 * Happy-path / guard-rail smoke only — full Stripe + token flows need fixtures.
 */
import { test, expect } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

test.describe("Public flows — smoke", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("TC-KIOSK-01: /kiosk/<bad-token> renders an invalid state, not a crash", async ({ page }) => {
    await page.goto(`${BASE}/kiosk/invalid-token-xyz`);
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("500");
    const body = await page.locator("body").innerText();
    expect(body.trim().length).toBeGreaterThan(20);
  });

  test("TC-WAIVER-01: /waiver/open loads the waiver content (no auth)", async ({ page }) => {
    await page.goto(`${BASE}/waiver/open`);
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).toContainText(/waiver|agree|sign|liabilit|consent/i, {
      timeout: 10_000,
    });
  });
});

test.describe("Ad-hoc charge — owner", () => {
  test("TC-CHARGE-01: POST /api/members/:id/charge is owner-gated and validates input", async ({ request }) => {
    const list = await request.get(`${BASE}/api/members`);
    expect(list.status()).toBe(200);
    const members = (await list.json()).members as Array<{ id: string }>;
    expect(members.length).toBeGreaterThan(0);

    const res = await request.post(`${BASE}/api/members/${members[0].id}/charge`, {
      headers: { Origin: BASE, "Content-Type": "application/json" },
      data: {},
    });
    // The route guards/validates rather than 500-ing or silently charging:
    //   400 invalid data · 402 no payment method / Stripe not connected ·
    //   503 Stripe not configured. Never 200 (no real charge) and never 5xx-crash.
    expect([400, 402, 403, 503]).toContain(res.status());
  });

  test("TC-CHARGE-02: charge requires same-origin (CSRF) — bare POST is rejected", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.post(`${BASE}/api/members/anyid/charge`, { data: {} });
    // No session + no Origin → blocked (401/403, or redirected to /login).
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });
});
