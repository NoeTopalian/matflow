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
    await expect(page.locator("h1")).toBeVisible();
    const heading = await page.locator("h1").innerText();
    expect(heading).toMatch(/good (morning|afternoon|evening)/i);
  });

  test("Sign In to Class button is present", async ({ page }) => {
    await expect(page.locator("button", { hasText: /sign in to class/i })).toBeVisible();
  });

  test("Today's Classes section is shown", async ({ page }) => {
    await expect(page.locator("text=Today's Classes")).toBeVisible();
  });

  test("Announcements section is shown", async ({ page }) => {
    await expect(page.locator("text=Announcements")).toBeVisible();
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
