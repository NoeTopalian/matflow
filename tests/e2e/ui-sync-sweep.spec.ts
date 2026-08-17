import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

/**
 * Log in via the /login form and wait until the browser lands on a
 * non-login page. The session cookie is persisted on the page context for
 * all subsequent navigations in the same test.
 */
async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${BASE}/login?club=totalbjj`);
  await page.waitForSelector("input[type='email']", { timeout: 15_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 30_000 });
}

// Every test in this file performs a full form login and then a cold route
// load, both of which compile on demand under `next dev` and hit a remote
// Neon branch. 30s (the Playwright default) is not enough headroom for that
// on a loaded machine — matches the 60s used by the UI-audit specs.
test.describe.configure({ timeout: 60_000 });

// E2E bypass: with TESTING_MODE + localhost, any valid tenant email + the
// E2E_BYPASS_TOKEN logs in (skips bcrypt). Owner email → owner session; a
// member email (passwordHash, no shadowing User) → member session.
const BYPASS = process.env.E2E_BYPASS_TOKEN ?? "playwright-e2e-2026";
const OWNER_EMAIL = process.env.TEST_OWNER_EMAIL ?? process.env.TEST_EMAIL ?? "noetopalian@gmail.com";
const OWNER_PASSWORD = process.env.TEST_OWNER_PASSWORD ?? BYPASS;
const MEMBER_EMAIL = process.env.TEST_MEMBER_EMAIL ?? "jordan@example.com";
const MEMBER_PASSWORD = process.env.TEST_MEMBER_PASSWORD ?? BYPASS;

const ROUTES_BY_ROLE: Record<string, { email: string; password: string; routes: string[] }> = {
  owner: {
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
    routes: [
      "/dashboard",
      "/dashboard/members",
      "/dashboard/timetable",
      "/dashboard/reports",
      "/dashboard/settings",
      "/dashboard/coach",
      "/dashboard/promotions",
      "/dashboard/notifications",
      "/dashboard/ranks",
      "/dashboard/memberships",
      "/dashboard/payments",
      "/dashboard/analysis",
    ],
  },
  member: {
    email: MEMBER_EMAIL,
    password: MEMBER_PASSWORD,
    routes: [
      "/member",
      "/member/home",
      "/member/profile",
      "/member/schedule",
      "/member/progress",
      "/member/shop",
    ],
  },
};

for (const [role, config] of Object.entries(ROUTES_BY_ROLE)) {
  for (const route of config.routes) {
    test(`${role} navigates to ${route} without 4xx/5xx`, async ({ page }) => {
      await loginAs(page, config.email, config.password);

      const errors: string[] = [];
      page.on("response", (resp) => {
        const status = resp.status();
        const url = resp.url();
        if (status >= 400 && url.includes(new URL(BASE).host)) {
          errors.push(`${status} ${resp.request().method()} ${url}`);
        }
      });

      await page.goto(`${BASE}${route}`);
      // Non-fatal, bounded: this test asserts on HTTP status codes, not on the
      // network going quiet. Under `next dev` the HMR channel and background
      // revalidation can keep the page from ever reaching networkidle, which
      // used to fail the test before the status assertion below ever ran.
      // Same pattern as tests/e2e/member/ui-audit-member.spec.ts:75.
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

      const clickables = await page.locator("a:visible, button:visible").all();
      for (const el of clickables.slice(0, 30)) {
        try {
          await el.click({ trial: true, timeout: 200 });
        } catch {
          // ignore — trial click failures are non-fatal
        }
      }

      expect(errors, `Found 4xx/5xx during sweep:\n${errors.join("\n")}`).toEqual([]);
    });
  }
}
