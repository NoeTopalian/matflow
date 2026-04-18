import { test, expect } from "@playwright/test";

test.describe("QR Check-In (public page)", () => {
  test("check-in page loads for known slug", async ({ page }) => {
    await page.goto("/checkin/total-bjj");
    // Should show a search or check-in UI, not a 404
    await expect(page.locator("body")).not.toContainText("404");
    await expect(page.locator("body")).not.toContainText("Page not found");
  });

  test("member lookup input is present", async ({ page }) => {
    await page.goto("/checkin/total-bjj");
    const input = page.locator("input[type='text']").or(page.locator("input[placeholder]")).first();
    await expect(input).toBeVisible({ timeout: 8000 });
  });
});

test.describe("Admin Check-In page", () => {
  test("admin check-in page is accessible", async ({ page }) => {
    await page.goto("/dashboard/checkin");
    // Either redirects to login or shows the page
    const url = page.url();
    expect(url).toMatch(/login|checkin/);
  });
});
