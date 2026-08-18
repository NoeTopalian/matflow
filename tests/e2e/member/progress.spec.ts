import { test, expect } from "@playwright/test";

// /member/progress renders skeletons until GET /api/member/me resolves, and
// deliberately renders no belt/stats before then (UI-RULES §7 — no fabricated
// placeholder people). That call aggregates attendance across a year and
// measures ~4–5s warm against the remote Neon test branch, so the 5s
// Playwright default sits inside the noise band. Data-dependent assertions
// therefore carry an explicit timeout, matching member/shop.spec.ts.
const DATA_TIMEOUT = 15_000;

test.describe("Member Progress", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/member/progress");
  });

  test("Progress heading is visible", async ({ page }) => {
    await expect(page.locator("h1", { hasText: "Progress" })).toBeVisible();
  });

  test("belt card is shown", async ({ page }) => {
    // Should show belt name (e.g. "Blue Belt")
    await expect(page.locator("text=/belt/i").first()).toBeVisible({ timeout: DATA_TIMEOUT });
  });

  test("stats grid shows 4 cards", async ({ page }) => {
    await expect(page.locator("text=This Week").first()).toBeVisible({ timeout: DATA_TIMEOUT });
    await expect(page.locator("text=This Month").first()).toBeVisible();
    await expect(page.locator("text=This Year").first()).toBeVisible();
    await expect(page.locator("text=Current Streak").first()).toBeVisible();
  });

  test("Your Classes section is shown", async ({ page }) => {
    await expect(page.locator("text=Your Classes").first()).toBeVisible();
  });

  test("milestones are shown", async ({ page }) => {
    await expect(page.locator("text=Milestones").first()).toBeVisible({ timeout: DATA_TIMEOUT });
  });

  // The product rule this guards: COACHES decide belts. A milestone must never
  // imply that turning up earns a promotion. The staff-only RankRequirement
  // model (minAttendances / minMonths) is one careless import away from
  // rendering "24 of 30 to blue belt" on this exact card, so the constraint is
  // asserted rather than left as a comment in lib/member-stats.ts.
  test("milestones never mention belts, promotion or rank", async ({ page }) => {
    const card = page.locator("div", { has: page.locator("h2", { hasText: "Milestones" }) }).last();
    await expect(card).toBeVisible({ timeout: DATA_TIMEOUT });

    const text = (await card.innerText()).toLowerCase();
    expect(text).not.toMatch(/belt|promot|stripe|\brank\b/);
  });
});
