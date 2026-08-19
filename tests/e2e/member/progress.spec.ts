import { test, expect } from "@playwright/test";

// /member/progress renders skeletons until GET /api/member/me resolves, and
// deliberately renders no belt/stats before then (UI-RULES §7 — no fabricated
// placeholder people). That call is an attendance + rank-timeline aggregate
// costing ~15 sequential round trips; measured warm and idle against the remote
// Neon test branch it takes 5–6s, and every worker shares ONE `next dev` process
// and ONE branch. So under `--workers>=2` its latency is bounded by whatever the
// other worker is doing, not by the app.
//
// A wall-clock assertion budget is therefore a coin flip: these two
// data-dependent tests failed at --workers=2 with the page still showing
// skeletons (no error banner — the request had simply not come back), while the
// two tests on this page that need no data passed alongside them. Waiting on the
// real response instead removes the guess without touching what is asserted:
// once /api/member/me has come back 200, the assertions below run against a page
// that is known to have its data.
const DATA_TIMEOUT = 15_000;
// Bounds the synchronisation wait, not an assertion. Absorbs cross-worker
// contention rather than app latency.
const API_TIMEOUT = 60_000;

// Same 60s-class allowance the sibling specs that do cold `next dev` route loads
// against the remote Neon branch already take (ui-sync-sweep.spec.ts:26,
// ui-audit-member.spec.ts, ui-audit-staff.spec.ts; member-auth.setup.ts uses
// 120s). This file was left on Playwright's 30s default while asserting on the
// most expensive endpoint in the member portal, so the default capped the
// beforeEach below before its wait could ever complete.
test.describe.configure({ timeout: 90_000 });

test.describe("Member Progress", () => {
  test.beforeEach(async ({ page }) => {
    // Armed before navigating so the response cannot be missed. The layout's
    // 2FA banner hits the same path with ?fields=security, which is deliberately
    // cheap — matching it would satisfy this wait early and defeat the point, so
    // require the page's own unqualified call.
    //
    // Matched on path only, never on status: gating the match on `=== 200` would
    // make a 401/500 look identical to a slow response and burn the full timeout
    // before failing with a useless "waiting for event". Assert the status after.
    const [me] = await Promise.all([
      page.waitForResponse((r) => {
        const u = new URL(r.url());
        return u.pathname === "/api/member/me" && !u.searchParams.has("fields");
      }, { timeout: API_TIMEOUT }),
      page.goto("/member/progress"),
    ]);
    expect(me.status(), `GET /api/member/me returned ${me.status()}`).toBe(200);
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
