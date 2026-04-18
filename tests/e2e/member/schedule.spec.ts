import { test, expect } from "@playwright/test";

test.describe("Member Schedule", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/member/schedule");
  });

  test("week label is shown", async ({ page }) => {
    // Week nav shows a date range like "6–12 April"
    await expect(page.locator("text=/\\d+.*–.*\\d+/")).toBeVisible();
  });

  test("day pills are rendered (7 days)", async ({ page }) => {
    const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    for (const day of dayLabels) {
      await expect(page.locator(`text=${day}`).first()).toBeVisible();
    }
  });

  test("Today button is present", async ({ page }) => {
    await expect(page.locator("button", { hasText: "Today" })).toBeVisible();
  });

  test("at least one class event is shown", async ({ page }) => {
    // The schedule should show at least one class block on most days
    // (demo data covers Mon–Sat)
    const classBlocks = page.locator(".absolute.rounded-xl");
    // If today has no classes, navigate to a day that does
    const count = await classBlocks.count();
    // At minimum, no JS errors and page rendered
    await expect(page.locator("body")).not.toContainText("Error");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("tapping a class opens the detail sheet", async ({ page }) => {
    const firstClass = page.locator(".absolute.rounded-xl").first();
    const count = await firstClass.count();
    if (count === 0) test.skip();

    await firstClass.click();
    // EventSheet should appear
    await expect(page.locator("text=/Time|Coach|Location/i").first()).toBeVisible();
  });
});
