import { test, expect } from "@playwright/test";

/**
 * A5H-5 — Bottom-nav tap targets must meet WCAG 2.5.5 (≥ 44 × 44 px).
 *
 * The member layout renders a fixed bottom <nav aria-label="Member navigation">
 * containing one <a> per tab (Home, Schedule, Progress, Shop — 4 tabs).
 * Each Link carries min-h-[48px] in Tailwind, which should render at ≥ 44 px
 * on every viewport. This spec locks that contract in so a future CSS change
 * cannot silently shrink the targets below the accessibility threshold.
 *
 * Critical for "Mobile Chrome" (Pixel 5, 393 × 851 CSS px) — desktop viewports
 * would never fail this since the layout hides the bottom nav on md+ screens.
 * Both Playwright projects run the same assertions; the desktop project serves
 * as a regression guard in case a future media-query change mis-fires.
 */

const WCAG_MIN_PX = 44;

test.describe("Member bottom-nav tap targets (WCAG 2.5.5)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/preview");
    await page.goto("/member/home");
    // Wait for the nav to be present before measuring.
    await page.waitForSelector("nav[aria-label='Member navigation']", {
      timeout: 8_000,
    });
  });

  test("every bottom-nav link has a rendered height of at least 44 px", async ({
    page,
  }) => {
    const nav = page.locator("nav[aria-label='Member navigation']");
    const links = nav.locator("a");
    const count = await links.count();

    // Guard: at least 1 link must exist so the loop below is meaningful.
    expect(count).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      const label = await link.getAttribute("aria-label");
      const box = await link.boundingBox();

      // boundingBox() returns null only for hidden/detached elements.
      expect(box, `Nav link "${label}" has no bounding box`).not.toBeNull();

      expect.soft(
        box!.height,
        `Nav link "${label}" height ${box!.height}px is below WCAG 2.5.5 minimum of ${WCAG_MIN_PX}px`,
      ).toBeGreaterThanOrEqual(WCAG_MIN_PX);

      expect.soft(
        box!.width,
        `Nav link "${label}" width ${box!.width}px is below WCAG 2.5.5 minimum of ${WCAG_MIN_PX}px`,
      ).toBeGreaterThanOrEqual(WCAG_MIN_PX);
    }
  });

  test("bottom-nav contains exactly 4 tab links", async ({ page }) => {
    const nav = page.locator("nav[aria-label='Member navigation']");
    // Matches the assertion in home.spec.ts — lock the count so nav
    // additions are a conscious decision reviewed in CI.
    await expect(nav.locator("a")).toHaveCount(4);
  });
});
