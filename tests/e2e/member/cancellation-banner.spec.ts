import { test, expect } from "@playwright/test";

/**
 * A5H-2 — Cancellation banner on /member/home.
 *
 * The banner renders when /api/member/me returns status "cancelled",
 * "inactive", or "suspended". Active members must NOT see it.
 *
 * Because the seed has no cancelled-member account and the specs must not
 * hit the production DB, we use page.route() to intercept /api/member/me
 * and inject the desired status. The preview session (GET /preview) is
 * sufficient to satisfy the member layout's auth check in demo mode.
 */

const BANNER_TEXT = /your gym membership is currently/i;

/** Minimal /api/member/me shape — only the fields consumed by home/page.tsx */
function memberPayload(status: string) {
  return {
    name: "Alex Johnson",
    primaryColor: "#3b82f6",
    onboardingCompleted: true,
    nextClass: null,
    accountType: "member",
    status,
  };
}

test.describe("Cancellation banner — /member/home", () => {
  /** Navigate through /preview then /member/home, honouring the demo-mode
   *  session that the existing specs rely on. */
  async function openHomeWithStatus(
    page: Parameters<Parameters<typeof test>[1]>[0]["page"],
    status: string,
  ) {
    // Intercept BEFORE navigation so the route handler is in place when the
    // page component fires its fetch on mount.
    await page.route("**/api/member/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(memberPayload(status)),
      });
    });

    await page.goto("/preview");
    await page.goto("/member/home");
  }

  test("banner is visible when member status is cancelled", async ({ page }) => {
    await openHomeWithStatus(page, "cancelled");

    const banner = page.locator("text=/your gym membership is currently/i");
    await expect(banner.first()).toBeVisible({ timeout: 8_000 });
  });

  test("banner is visible when member status is inactive", async ({ page }) => {
    await openHomeWithStatus(page, "inactive");

    await expect(page.locator("text=/your gym membership is currently/i").first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test("banner is visible when member status is suspended", async ({ page }) => {
    await openHomeWithStatus(page, "suspended");

    await expect(page.locator("text=/your gym membership is currently/i").first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test("banner contains the reactivation call-to-action", async ({ page }) => {
    await openHomeWithStatus(page, "cancelled");

    // The second paragraph inside the banner instructs the member to contact
    // the gym — assert the copy is present and correct.
    await expect(
      page.locator("text=/contact your gym to reactivate/i").first(),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("banner is NOT shown for an active member", async ({ page }) => {
    await openHomeWithStatus(page, "active");

    // Give the page time to settle so we are not asserting before the API
    // response has been processed.
    await page.waitForSelector("h1", { timeout: 8_000 });

    await expect(page.locator("text=/your gym membership is currently/i").first()).not.toBeVisible();
  });
});
