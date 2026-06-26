import { test as setup, expect } from "@playwright/test";

// Mints a MEMBER session storageState (parallel to auth.setup.ts which mints the
// owner one). The TESTING_MODE + E2E_BYPASS_TOKEN bypass yields a member session
// when the email matches a Member with a passwordHash and no shadowing User row
// (jordan@example.com on the seeded totalbjj tenant). Used by the
// chromium-member / Mobile Chrome member projects for tests/e2e/member/**.
const MEMBER_AUTH = "tests/e2e/.auth/member.json";

setup("authenticate as member", async ({ page }) => {
  await page.goto("/login?club=totalbjj");
  await page.waitForSelector("input[type='email']", { timeout: 15_000 });
  await page.fill("input[type='email']", process.env.TEST_MEMBER_EMAIL ?? "jordan@example.com");
  await page.fill("input[type='password']", process.env.E2E_BYPASS_TOKEN ?? "playwright-e2e-2026");
  await page.click("button[type='submit']");
  // Must land in the member area — fail loudly if the bypass resolved to owner.
  await page.waitForURL(/\/member/, { timeout: 15_000 });
  expect(page.url()).toContain("/member");
  await page.context().storageState({ path: MEMBER_AUTH });
});
