import { test, expect } from "@playwright/test";

test.describe("Member Progress", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/member/progress");
  });

  test("Progress heading is visible", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Progress" })).toBeVisible();
  });

  test("belt card is shown", async ({ page }) => {
    // Should show belt name (e.g. "Blue Belt")
    await expect(page.locator("text=/belt/i").first()).toBeVisible();
  });

  test("stats grid shows 4 cards", async ({ page }) => {
    await expect(page.locator("text=This Week")).toBeVisible();
    await expect(page.locator("text=This Month")).toBeVisible();
    await expect(page.locator("text=This Year")).toBeVisible();
    await expect(page.locator("text=Current Streak")).toBeVisible();
  });

  test("Your Classes section is shown", async ({ page }) => {
    await expect(page.locator("text=Your Classes")).toBeVisible();
  });
});
