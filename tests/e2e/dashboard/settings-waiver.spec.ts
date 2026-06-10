import { test, expect } from "@playwright/test";

async function loginAsOwner(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill("input[type='email']", process.env.TEST_EMAIL ?? "owner@totalbjj.co.uk");
  await page.fill("input[type='password']", process.env.TEST_PASSWORD ?? "password123");
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 10_000 });
}

test.describe("Waiver settings — adult + parent/guardian", () => {
  test("both waiver sections are visible on the waiver tab", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/settings?tab=waiver");

    await expect(page.getByRole("heading", { name: /Liability Waiver/i }).first()).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("heading", { name: /Parent\/Guardian Waiver/i })).toBeVisible({ timeout: 5_000 });
  });

  test("parent/guardian waiver title can be edited and saved", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/settings?tab=waiver");

    // Click the Edit button for the kids waiver (second "Edit Waiver" button)
    const editBtns = page.getByRole("button", { name: /Edit Waiver/i });
    await editBtns.nth(1).waitFor({ timeout: 8_000 });
    await editBtns.nth(1).click();

    const titleInputs = page.locator("input[maxlength='200']");
    await titleInputs.nth(1).waitFor({ timeout: 5_000 });
    await titleInputs.nth(1).fill("Guardian Waiver E2E");

    await page.getByRole("button", { name: /^Save$/i }).last().click();

    await expect(page.locator("text=/saved|success/i").first()).toBeVisible({ timeout: 6_000 });

    // Reload and confirm it persisted
    await page.reload();
    await page.goto("/dashboard/settings?tab=waiver");
    await expect(page.locator("text=Guardian Waiver E2E")).toBeVisible({ timeout: 8_000 });
  });
});
