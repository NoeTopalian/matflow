import { test, expect } from "@playwright/test";

async function loginAsOwner(page: import("@playwright/test").Page) {
  // Auth pre-loaded via storageState — navigate to confirm session is active
  await page.goto("/dashboard");
  await page.waitForURL(/dashboard/, { timeout: 8_000 });
}

test.describe("Owner dashboard button wiring", () => {
  test("dashboard task buttons open useful owner workflows", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard");

    await page.getByRole("button", { name: /To Do List/i }).first().click();
    await expect(page.getByRole("complementary", { name: /To Do List/i })).toBeVisible();

    const sidebar = page.getByRole("complementary", { name: /To Do List/i });
    await sidebar.getByRole("link", { name: /Review waivers/i }).first().click();
    await expect(page).toHaveURL(/\/dashboard\/members\?filter=waiver-missing/);
    await expect(page.getByRole("button", { name: /Waiver Missing/i })).toBeVisible();

    await page.goto("/dashboard");
    await page.getByRole("link", { name: /Payments Due/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/members\?filter=overdue/);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: /At-Risk Members/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/members\?filter=quiet/);
  });

  test("dashboard add-class button opens the timetable class drawer", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard");

    await page.getByRole("link", { name: /Add Class/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/timetable\?new=class/);
    await expect(page.getByRole("heading", { name: /New Class/i })).toBeVisible();
  });
});
