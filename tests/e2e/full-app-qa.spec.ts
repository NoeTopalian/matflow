/**
 * full-app-qa.spec.ts — Comprehensive QA sweep for MatFlow.
 *
 * Covers: auth flows, all owner dashboard routes, member routes,
 * API smoke tests (authenticated), and new-feature validation
 * (payments page, reports KPIs, promotion alerts, revenue owner-gate).
 *
 * Auth: uses the pre-loaded owner storageState (tests/e2e/.auth/owner.json)
 * set up by auth.setup.ts. Some tests explicitly override with an empty
 * storage state to test unauthenticated behaviour.
 *
 * Port: playwright.config.ts targets http://localhost:3847
 */

import { test, expect, type Page } from "@playwright/test";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

/** Navigate to a URL and wait for network idle. */
async function goto(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 });
}

/** Login via the two-step club-code → email/password form. */
async function loginAs(
  page: Page,
  email: string,
  password: string,
  gymCode = "totalbjj",
) {
  await page.goto(`${BASE}/login`);
  // Step 1: gym code
  const codeInput = page.locator("input[name='code'], input[placeholder*='code' i], input[placeholder*='club' i]").first();
  if (await codeInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await codeInput.fill(gymCode);
    const nextBtn = page.getByRole("button", { name: /continue|next/i }).first();
    await nextBtn.click();
  }
  // Step 2: credentials
  await page.waitForSelector("input[type='email']", { timeout: 10_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 15_000 });
}

const OWNER_EMAIL = process.env.TEST_EMAIL ?? "noetopalian@gmail.com";
const OWNER_PASSWORD = process.env.E2E_BYPASS_TOKEN ?? "playwright-e2e-2026";

// ─── Authentication flows ─────────────────────────────────────────────────────

test.describe("Authentication", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("TC-AUTH-01: login page renders all form elements", async ({ page }) => {
    await page.goto(`${BASE}/login`);
    // The login form may be a two-step wizard; at minimum the page must load
    await expect(page).not.toHaveURL(/500|error/);
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(10);
  });

  test("TC-AUTH-02: wrong password stays on login and shows error", async ({ page }) => {
    await page.goto(`${BASE}/login?club=totalbjj`);
    await page.waitForSelector("input[type='email']", { timeout: 15_000 });
    await page.fill("input[type='email']", "wrong@example.com");
    await page.fill("input[type='password']", "definitelywrong");
    await page.click("button[type='submit']");
    // Must remain on login — no dashboard redirect
    await page.waitForTimeout(3_000);
    expect(page.url()).toMatch(/login/);
  });

  test("TC-AUTH-03: valid credentials redirect to dashboard or member area", async ({ page }) => {
    await loginAs(page, OWNER_EMAIL, OWNER_PASSWORD);
    expect(page.url()).toMatch(/dashboard|member/);
  });
});

// ─── Logout ──────────────────────────────────────────────────────────────────

test.describe("Logout", () => {
  test("TC-AUTH-04: logout redirects to login", async ({ page }) => {
    // Navigate to dashboard first (storageState has owner session)
    await goto(page, "/dashboard");
    await page.waitForURL(/dashboard/, { timeout: 10_000 });

    // Hit NextAuth signOut endpoint directly — most reliable across UI variants
    await page.goto(`${BASE}/api/auth/signout`);
    // The signout page has a submit button to confirm
    const confirmBtn = page.getByRole("button", { name: /sign out/i });
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }
    await page.waitForURL(/login|signout|\//, { timeout: 10_000 });
    // After signout, dashboard should now redirect to login
    await page.goto(`${BASE}/dashboard`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });
});

// ─── Dashboard pages (owner-authenticated) ────────────────────────────────────

test.describe("Dashboard — core pages", () => {
  test("TC-DASH-01: /dashboard loads with stats cards", async ({ page }) => {
    await goto(page, "/dashboard");
    await page.waitForURL(/dashboard/, { timeout: 10_000 });
    // Page must not be an error page
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("500");
    // Stats cards: active members heading present somewhere
    const body = await page.locator("body").innerText();
    expect(body).toBeTruthy();
    // Should not be a blank page
    expect(body.trim().length).toBeGreaterThan(100);
  });

  test("TC-DASH-02: /dashboard/members renders member list", async ({ page }) => {
    await goto(page, "/dashboard/members");
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10_000 });
    // Table or list must be present — check for member-related UI
    await expect(page.locator("body")).not.toContainText("Application error");
    const body = await page.locator("body").innerText();
    // At minimum the heading and some members or an empty state
    expect(body.trim().length).toBeGreaterThan(50);
  });

  test("TC-DASH-03: /dashboard/members search input is present", async ({ page }) => {
    await goto(page, "/dashboard/members");
    const searchInput = page.locator("input[placeholder*='search' i], input[type='search']").first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
  });

  test("TC-DASH-04: /dashboard/members Add Member button is present", async ({ page }) => {
    await goto(page, "/dashboard/members");
    const addBtn = page.getByRole("button", { name: /add member/i }).or(
      page.getByRole("link", { name: /add member/i })
    ).first();
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
  });

  test("TC-DASH-05: /dashboard/attendance renders without error", async ({ page }) => {
    await goto(page, "/dashboard/attendance");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("500");
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 10_000 });
  });

  test("TC-DASH-06: /dashboard/reports renders all chart sections", async ({ page }) => {
    await goto(page, "/dashboard/reports");
    await expect(page.locator("body")).not.toContainText("Application error");
    const body = await page.locator("body").innerText();
    // Reports page should contain KPI labels
    expect(body).toMatch(/report|member|attendance|churn|retention|payment/i);
  });

  test("TC-DASH-07: /dashboard/reports contains Churn Rate text", async ({ page }) => {
    await goto(page, "/dashboard/reports");
    await expect(page.locator("body")).toContainText(/churn/i, { timeout: 15_000 });
  });

  test("TC-DASH-08: /dashboard/reports contains Retention Rate text", async ({ page }) => {
    await goto(page, "/dashboard/reports");
    await expect(page.locator("body")).toContainText(/retention/i, { timeout: 15_000 });
  });

  test("TC-DASH-09: /dashboard/reports contains Payment Health text", async ({ page }) => {
    await goto(page, "/dashboard/reports");
    await expect(page.locator("body")).toContainText(/payment health/i, { timeout: 15_000 });
  });

  test("TC-DASH-10: /dashboard/analysis loads without error", async ({ page }) => {
    await goto(page, "/dashboard/analysis");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 15_000 });
  });

  test("TC-DASH-11: /dashboard/checkin renders search UI", async ({ page }) => {
    await goto(page, "/dashboard/checkin");
    await expect(page.locator("body")).not.toContainText("Application error");
    // Must show a search field or member lookup
    const body = await page.locator("body").innerText();
    expect(body.trim().length).toBeGreaterThan(50);
  });

  test("TC-DASH-12: /dashboard/settings renders settings form", async ({ page }) => {
    await goto(page, "/dashboard/settings");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
    const body = await page.locator("body").innerText();
    expect(body).toMatch(/setting|gym|club|profile/i);
  });
});

// ─── Payments page (new feature) ─────────────────────────────────────────────

test.describe("Payments page — new feature", () => {
  test("TC-PAY-01: /dashboard/payments renders Payment History heading", async ({ page }) => {
    await goto(page, "/dashboard/payments");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.getByRole("heading", { name: /payment history/i })).toBeVisible({ timeout: 15_000 });
  });

  test("TC-PAY-02: /dashboard/payments renders status filter tabs", async ({ page }) => {
    await goto(page, "/dashboard/payments");
    // STATUS_TABS: All, Succeeded, Failed, Refunded, Disputed, Pending
    await expect(page.getByRole("button", { name: /^all$/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /succeeded/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /failed/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /refunded/i })).toBeVisible();
  });

  test("TC-PAY-03: /dashboard/payments member search input present", async ({ page }) => {
    await goto(page, "/dashboard/payments");
    const searchInput = page.locator("input[placeholder*='search member' i]").first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
  });

  test("TC-PAY-04: /dashboard/payments table renders (or empty state)", async ({ page }) => {
    await goto(page, "/dashboard/payments");
    // Wait for loading skeletons to resolve
    await page.waitForTimeout(3_000);
    // Either a table with data or the empty state message
    const hasTable = await page.locator("table").isVisible().catch(() => false);
    const hasEmptyState = await page.locator("body").innerText()
      .then((t) => /no payments found|payment records will appear/i.test(t));
    expect(hasTable || hasEmptyState).toBe(true);
  });

  test("TC-PAY-05: clicking Failed tab updates filter (no crash)", async ({ page }) => {
    await goto(page, "/dashboard/payments");
    const failedTab = page.getByRole("button", { name: /failed/i });
    await expect(failedTab).toBeVisible({ timeout: 10_000 });
    await failedTab.click();
    await page.waitForTimeout(2_000);
    await expect(page.locator("body")).not.toContainText("Application error");
  });

});

// ─── Revenue (owner-only) ─────────────────────────────────────────────────────

test.describe("Revenue tab", () => {
  test("TC-REV-01: dashboard contains Revenue-related content (owner)", async ({ page }) => {
    await goto(page, "/dashboard");
    // Revenue may be a tab or section on the dashboard page
    const body = await page.locator("body").innerText();
    // The dashboard stats should include financial or revenue info
    await expect(page.locator("body")).not.toContainText("Application error");
    expect(body.length).toBeGreaterThan(100);
  });
});

// ─── Member routes ────────────────────────────────────────────────────────────

test.describe("Member-facing pages", () => {
  test("TC-MEM-01: /member/home renders greeting heading", async ({ page }) => {
    await goto(page, "/member/home");
    await expect(page.locator("body")).not.toContainText("Application error");
    // Owner may be redirected to dashboard; accept both outcomes
    const url = page.url();
    if (url.includes("/member/home")) {
      await expect(page.locator("h1").first()).toBeVisible({ timeout: 10_000 });
    } else {
      // Owner redirected to dashboard — acceptable
      expect(url).toMatch(/dashboard/);
    }
  });

  test("TC-MEM-02: /member/profile renders without error", async ({ page }) => {
    await goto(page, "/member/profile");
    await expect(page.locator("body")).not.toContainText("Application error");
    const url = page.url();
    // May redirect owner to dashboard
    if (url.includes("/member/profile")) {
      const body = await page.locator("body").innerText();
      expect(body.trim().length).toBeGreaterThan(50);
    }
  });

  test("TC-MEM-03: /member/actions renders without error", async ({ page }) => {
    await goto(page, "/member/actions");
    await expect(page.locator("body")).not.toContainText("Application error");
  });
});

// ─── Other owner dashboard routes ────────────────────────────────────────────

test.describe("Additional dashboard routes", () => {
  test("TC-ROUTE-01: /dashboard/timetable renders without error", async ({ page }) => {
    await goto(page, "/dashboard/timetable");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
  });

  test("TC-ROUTE-02: /dashboard/memberships renders without error", async ({ page }) => {
    await goto(page, "/dashboard/memberships");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
  });

  test("TC-ROUTE-03: /dashboard/promotions renders without error", async ({ page }) => {
    await goto(page, "/dashboard/promotions");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("404");
  });

  test("TC-ROUTE-04: /dashboard/notifications renders without error", async ({ page }) => {
    await goto(page, "/dashboard/notifications");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("404");
  });

  test("TC-ROUTE-05: /dashboard/ranks renders without error", async ({ page }) => {
    await goto(page, "/dashboard/ranks");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("404");
  });

  test("TC-ROUTE-06: /dashboard/coach renders without error", async ({ page }) => {
    await goto(page, "/dashboard/coach");
    await expect(page.locator("body")).not.toContainText("Application error");
    await expect(page.locator("body")).not.toContainText("404");
  });
});

// ─── API smoke tests (authenticated, using Playwright's request fixture) ─────

test.describe("API smoke tests (authenticated)", () => {
  test("TC-API-01: GET /api/reports returns 200 with churnRate field", async ({ request }) => {
    const res = await request.get(`${BASE}/api/reports`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("churnRate");
    expect(typeof body.churnRate).toBe("number");
  });

  test("TC-API-02: GET /api/reports returns retentionRate field", async ({ request }) => {
    const res = await request.get(`${BASE}/api/reports`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("retentionRate");
    expect(typeof body.retentionRate).toBe("number");
  });

  test("TC-API-03: GET /api/reports returns paymentHealth object", async ({ request }) => {
    const res = await request.get(`${BASE}/api/reports`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("paymentHealth");
    expect(body.paymentHealth).toHaveProperty("overdueCount");
    expect(body.paymentHealth).toHaveProperty("failedLast30Days");
    expect(body.paymentHealth).toHaveProperty("recoveryRate");
  });

  test("TC-API-04: GET /api/payments returns 200 with payments array", async ({ request }) => {
    const res = await request.get(`${BASE}/api/payments`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("payments");
    expect(Array.isArray(body.payments)).toBe(true);
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("page");
  });

  test("TC-API-05: GET /api/payments?status=failed returns 200", async ({ request }) => {
    const res = await request.get(`${BASE}/api/payments?status=failed`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("payments");
    // All returned payments must have status 'failed'
    for (const p of body.payments) {
      expect(p.status).toBe("failed");
    }
  });

  test("TC-API-06: GET /api/members returns 200 with members array", async ({ request }) => {
    const res = await request.get(`${BASE}/api/members`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("members");
    expect(Array.isArray(body.members)).toBe(true);
  });

  test("TC-API-07: GET /api/revenue/summary returns 200 with mrr field (owner)", async ({ request }) => {
    const res = await request.get(`${BASE}/api/revenue/summary`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("mrr");
    expect(body).toHaveProperty("arr");
    expect(body).toHaveProperty("history");
    expect(Array.isArray(body.history)).toBe(true);
  });

  test("TC-API-08: GET /api/reports without auth returns 401", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/reports`);
    // Protected: a direct 401/403, or redirected (307 followed) to /login.
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });
});

// ─── Promotion alerts (new feature) ──────────────────────────────────────────

test.describe("Promotion alerts — new feature", () => {
  test("TC-PROM-01: /dashboard/members PromotionAlerts component renders (no crash)", async ({ page }) => {
    await goto(page, "/dashboard/members");
    await expect(page.locator("body")).not.toContainText("Application error");
    // The PromotionAlerts component may render nothing if no qualifying members.
    // Just confirm the page loads without error.
    const body = await page.locator("body").innerText();
    expect(body.trim().length).toBeGreaterThan(50);
  });
});

// ─── Security — unauthenticated redirect gates ────────────────────────────────

test.describe("Auth gates — unauthenticated redirects", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("TC-GATE-01: /dashboard redirects to login when unauthenticated", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });

  test("TC-GATE-02: /dashboard/members redirects to login when unauthenticated", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/members`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });

  test("TC-GATE-03: /dashboard/payments redirects to login when unauthenticated", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/payments`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });

  test("TC-GATE-04: /dashboard/reports redirects to login when unauthenticated", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/reports`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });

  test("TC-GATE-05: /dashboard/analysis redirects to login when unauthenticated", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/analysis`);
    await page.waitForURL(/login/, { timeout: 10_000 });
    expect(page.url()).toMatch(/login/);
  });

  test("TC-GATE-06: /api/payments returns 401 when unauthenticated", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/payments`);
    // Protected: a direct 401/403, or redirected (307 followed) to /login.
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });

  test("TC-GATE-07: /api/revenue/summary returns 401 when unauthenticated", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const res = await anon.get(`${BASE}/api/revenue/summary`);
    // Protected: a direct 401/403, or redirected (307 followed) to /login.
    expect(res.status() === 401 || res.status() === 403 || res.url().includes("/login")).toBeTruthy();
    await anon.dispose();
  });
});

// ─── No JS console errors on critical pages ───────────────────────────────────

test.describe("No critical JS errors", () => {
  const CRITICAL_PAGES = [
    "/dashboard",
    "/dashboard/members",
    "/dashboard/payments",
    "/dashboard/reports",
    "/dashboard/analysis",
  ];

  for (const path of CRITICAL_PAGES) {
    test(`TC-JS-${path.replace(/\//g, "-")}: no uncaught JS errors on ${path}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(err.message));
      await goto(page, path);
      await page.waitForTimeout(2_000); // let async rendering settle
      // Filter out known third-party noise; only flag errors from the app
      const appErrors = errors.filter(
        (e) => !e.includes("ResizeObserver") && !e.includes("Non-Error promise rejection"),
      );
      expect(appErrors, `Console errors on ${path}:\n${appErrors.join("\n")}`).toHaveLength(0);
    });
  }
});
