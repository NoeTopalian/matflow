import { test, expect } from "@playwright/test";

test.describe("Login flow", () => {
  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("input[type='email']")).toBeVisible();
    await expect(page.locator("input[type='password']")).toBeVisible();
    await expect(page.locator("button[type='submit']")).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/login");
    await page.fill("input[type='email']", "wrong@example.com");
    await page.fill("input[type='password']", "wrongpassword");
    await page.click("button[type='submit']");

    // Should stay on login page and show an error
    await expect(page).toHaveURL(/login/);
  });

  test("redirects to dashboard after successful login", async ({ page }) => {
    await page.goto("/login");
    await page.fill("input[type='email']", process.env.TEST_EMAIL ?? "owner@totalbjj.co.uk");
    await page.fill("input[type='password']", process.env.TEST_PASSWORD ?? "password123");
    await page.click("button[type='submit']");

    // Should redirect to dashboard
    await page.waitForURL(/dashboard|member/, { timeout: 10_000 });
    await expect(page).not.toHaveURL(/login/);
  });
});
