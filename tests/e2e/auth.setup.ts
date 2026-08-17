import { test as setup } from "@playwright/test";

const OWNER_AUTH = "tests/e2e/.auth/owner.json";

// Cold /login compile + ?club= tenant lookup + the credentials POST measures
// ~20s even on an idle machine, so the 30s Playwright default capped the
// per-action timeouts below and failed the run before they could elapse.
setup.describe.configure({ timeout: 120_000 });

setup("authenticate as owner", async ({ page }) => {
  await page.goto("/login?club=totalbjj");
  // This is the first navigation of the whole run, so `next dev` compiles
  // /login on demand (measured ~10s cold) and only THEN does the client
  // resolve ?club= via /api/tenant/[slug] and swap the club-code step for the
  // email form. 15s left no margin and failed the setup, which blocks every
  // dependent project.
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", process.env.TEST_EMAIL ?? "owner@totalbjj.com");
  await page.fill("input[type='password']", process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123");
  await page.click("button[type='submit']");
  // 30s: the first login after a cold dev-server boot pays Turbopack's
  // route-compile cost — 10s flaked whenever the suite booted its own server.
  await page.waitForURL(/dashboard|member/, { timeout: 30_000 });
  await page.context().storageState({ path: OWNER_AUTH });
});
