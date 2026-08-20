import { test, expect, type Page } from "@playwright/test";

/**
 * A5H-2 — Cancellation banner on /member/home.
 *
 * The banner renders when the home payload's `me.status` is "cancelled",
 * "inactive", or "suspended". Active members must NOT see it.
 *
 * The home page now loads everything through the consolidated
 * /api/member/home endpoint (audit Lane 4 A15), so that is what we
 * intercept; /api/member/me stays intercepted too because the member
 * layout's 2FA banner still fetches it. The preview session (GET /preview)
 * is sufficient to satisfy the member layout's auth check in demo mode.
 */

const BANNER_TEXT = /your gym membership is currently/i;

/** Minimal me shape — only the fields consumed by home/page.tsx */
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

/** Consolidated /api/member/home shape (me + schedule + children + announcements). */
function homePayload(status: string) {
  return {
    me: memberPayload(status),
    schedule: [],
    children: [],
    announcements: { announcements: [] },
  };
}

test.describe("Cancellation banner — /member/home", () => {
  /** Navigate through /preview then /member/home, honouring the demo-mode
   *  session that the existing specs rely on. */
  async function openHomeWithStatus(page: Page, status: string) {
    // Intercept BEFORE navigation so the route handlers are in place when the
    // page component fires its fetch on mount.
    await page.route("**/api/member/home**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(homePayload(status)),
      });
    });
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
