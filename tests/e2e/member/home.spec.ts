import { test, expect } from "@playwright/test";

/**
 * Member Home page — covers the key UI elements visible to any logged-in member.
 * Uses the preview/demo URL so no auth is required.
 */
test.describe("Member Home", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/preview");
    // Navigate to member home if preview redirects to it, else go directly
    await page.goto("/member/home");
  });

  test("greeting is shown", async ({ page }) => {
    // Should show a personalised greeting
    await expect(page.locator("h1").first()).toBeVisible();
    const heading = await page.locator("h1").first().innerText();
    expect(heading).toMatch(/good (morning|afternoon|evening)/i);
  });

  test("Sign In to Class button is present", async ({ page }) => {
    await expect(page.locator("button", { hasText: /sign in to class/i })).toBeVisible();
  });

  // Both sections render only once the home data has loaded (D5: an unloaded
  // list is not an empty one), which on a dev server against a remote test
  // database can take longer than the default 5 s — the other member specs
  // give home 45 s.
  test("Today's Classes section is shown", async ({ page }) => {
    await expect(page.locator("text=Today's Classes").first()).toBeVisible({ timeout: 30_000 });
  });

  test("Announcements section is shown", async ({ page }) => {
    await expect(page.locator("text=Announcements")).toBeVisible({ timeout: 30_000 });
  });

  test("bottom nav has 4 tabs (no Shop)", async ({ page }) => {
    const nav = page.locator("nav[aria-label='Member navigation']");
    await expect(nav).toBeVisible();
    const links = nav.locator("a");
    await expect(links).toHaveCount(4);
  });

  test("shop bubble is in the header", async ({ page }) => {
    const shopBubble = page.locator("a[aria-label='Shop']");
    await expect(shopBubble).toBeVisible();
  });
});
