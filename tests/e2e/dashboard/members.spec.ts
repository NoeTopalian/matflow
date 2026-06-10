import { test, expect } from "@playwright/test";

// These tests verify unauthenticated redirect behaviour — clear any pre-loaded auth state
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("Dashboard Members", () => {
  test("members page redirects to login if unauthenticated", async ({ page }) => {
    await page.goto("/dashboard/members");
    // Should redirect to login
    await page.waitForURL(/login/, { timeout: 8000 });
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Dashboard Timetable", () => {
  test("timetable page redirects to login if unauthenticated", async ({ page }) => {
    await page.goto("/dashboard/timetable");
    await page.waitForURL(/login/, { timeout: 8000 });
    await expect(page).toHaveURL(/login/);
  });
});

test.describe("Dashboard Settings", () => {
  test("settings page redirects to login if unauthenticated", async ({ page }) => {
    await page.goto("/dashboard/settings");
    await page.waitForURL(/login/, { timeout: 8000 });
    await expect(page).toHaveURL(/login/);
  });
});
