import { test, expect } from "@playwright/test";

async function loginAsOwner(page: import("@playwright/test").Page) {
  await page.goto("/dashboard");
  await page.waitForURL(/dashboard/, { timeout: 8_000 });
}

test.describe("Check-in window settings", () => {
  test("check-in window inputs exist on waiver tab", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/settings?tab=waiver");

    await expect(page.locator("input[type='number']").first()).toBeVisible({ timeout: 8_000 });
  });

  test("values above 180 are clamped on input", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/settings?tab=waiver");

    const inputs = page.locator("input[type='number']");
    const first = inputs.first();
    await first.waitFor({ timeout: 8_000 });

    await first.fill("300");
    await first.dispatchEvent("change");
    const value = await first.inputValue();
    expect(Number(value)).toBeLessThanOrEqual(180);
  });

  test("saving a valid check-in window shows success toast", async ({ page }) => {
    await loginAsOwner(page);
    await page.goto("/dashboard/settings?tab=waiver");

    const inputs = page.locator("input[type='number']");
    await inputs.first().waitFor({ timeout: 8_000 });
    await inputs.first().fill("45");
    await inputs.nth(1).fill("30");

    await page.getByRole("button", { name: /Save/i }).last().click();

    await expect(page.locator("text=/saved|success/i").first()).toBeVisible({ timeout: 6_000 });
  });
});
