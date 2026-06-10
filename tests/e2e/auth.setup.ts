import { test as setup } from "@playwright/test";

const OWNER_AUTH = "tests/e2e/.auth/owner.json";

setup("authenticate as owner", async ({ page }) => {
  await page.goto("/login?club=totalbjj");
  await page.waitForSelector("input[type='email']", { timeout: 15_000 });
  await page.fill("input[type='email']", process.env.TEST_EMAIL ?? "owner@totalbjj.com");
  await page.fill("input[type='password']", process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123");
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 10_000 });
  await page.context().storageState({ path: OWNER_AUTH });
});
