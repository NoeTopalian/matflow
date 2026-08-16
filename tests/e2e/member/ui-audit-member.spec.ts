import { test, expect, type Page } from "@playwright/test";

/**
 * UI interaction audit — member portal (plan Stage B). Runs under BOTH member
 * projects: `chromium-member` (desktop 1280×720) and `Mobile Chrome member`
 * (Pixel 5), so every menu and button is verified on mobile AND PC.
 *
 * Covers: bottom-tab completeness + navigation, route rendering with no
 * console errors, horizontal-overflow and fixed-nav overlap checks, and the
 * key interactive flows (sign-in sheet, schedule detail sheet, shop cart,
 * profile notification switches).
 */

// The member tab bar is defined inline in app/member/layout.tsx (TABS) plus
// the Shop bubble pinned top-right. Kept in sync manually — tiny and stable.
const MEMBER_TABS = [
  { href: "/member/home", label: "Home" },
  { href: "/member/schedule", label: "Schedule" },
  { href: "/member/progress", label: "Progress" },
  { href: "/member/profile", label: "Profile" },
];
const MEMBER_ROUTES = [...MEMBER_TABS.map((t) => t.href), "/member/shop"];

test.describe.configure({ timeout: 60_000 });

test.beforeAll(() => {
  const db = process.env.DATABASE_URL ?? "";
  if (db.includes("ep-bold-wave")) {
    throw new Error("UI audit refused to run: DATABASE_URL points at PROD (ep-bold-wave).");
  }
});

// The first-run onboarding wizard auto-opens on /member/home for a fresh
// browser profile and (correctly) blocks everything behind it — mark it done
// so the audit drives the normal UI. The announcement modal is handled
// separately by dismissAnnouncement().
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem("bjj_onboarded", "true"); } catch {}
  });
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

const IGNORED_ERROR_PATTERNS = [/Failed to load resource.*favicon/i, /Download the React DevTools/i];
const realErrors = (errs: string[]) => errs.filter((e) => !IGNORED_ERROR_PATTERNS.some((p) => p.test(e)));

// The seeded member has unseen announcements, and /member/home auto-opens the
// first one in a modal that (correctly) blocks the page behind it. Dismiss it
// before driving navigation, like a real member would.
async function dismissAnnouncement(page: Page) {
  // Iterate: dismissing one announcement can reveal/queue another, and the
  // exit animation needs a beat before the backdrop stops intercepting.
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"], div.fixed.inset-0').last();
    if (!(await dialog.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    const close = page.locator('button[aria-label="Close"], button[aria-label="Dismiss"]').last();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    await page.waitForTimeout(450);
  }
}

test.describe("member routes render", () => {
  for (const href of MEMBER_ROUTES) {
    test(`route ${href} renders cleanly`, async ({ page }, testInfo) => {
      const errors = collectErrors(page);
      const res = await page.goto(href);
      expect(res?.status(), `${href} should not 404/500`).toBeLessThan(400);
      await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState("networkidle").catch(() => {});

      // Honesty guard (UI-RULES §7): fabricated identities must never appear.
      // ("Coach Mike" is deliberately NOT in this list — the seed data
      // legitimately names a coach Mike on the timetable.)
      const body = await page.locator("body").innerText();
      for (const fake of ["Alex Johnson", "UKBJJA Nottingham", "alex@example.com"]) {
        expect(body, `${href} still renders fabricated content "${fake}"`).not.toContain(fake);
      }

      const isMobile = (testInfo.project.use.viewport?.width ?? 1280) < 500;
      if (isMobile) {
        const overflow = await page.evaluate(
          () => document.scrollingElement!.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${href} horizontal overflow on mobile`).toBeLessThanOrEqual(1);
      }
      await page.screenshot({
        path: `test-results/ui-audit/member-${href.replace(/\//g, "_")}-${isMobile ? "mobile" : "desktop"}.png`,
        fullPage: true,
      });
      expect(realErrors(errors), `${href} logged errors`).toEqual([]);
    });
  }
});

test("bottom tab bar is complete and navigates", async ({ page }) => {
  await page.goto("/member/home");
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await dismissAnnouncement(page);

  const nav = page.locator('[aria-label="Member navigation"]');
  await expect(nav, "member bottom nav missing").toBeVisible();
  for (const tab of MEMBER_TABS) {
    await expect(nav.locator(`a[href="${tab.href}"]`), `tab ${tab.label} missing`).toBeVisible();
  }
  // Shop bubble pinned in the top bar.
  await expect(page.locator('a[href="/member/shop"]').first(), "shop entry missing").toBeVisible();

  // Click-through: every tab actually navigates. We assert the hit-test
  // OURSELVES (elementFromPoint at the tab's centre must resolve inside the
  // link — the real "is it tappable" guarantee) and then force-click:
  // Playwright's own actionability re-check flakes against the schedule
  // pager's animating transform even though live probing shows the tabs
  // hit-test correctly at rest.
  for (const tab of MEMBER_TABS.slice(1)) {
    const link = nav.locator(`a[href="${tab.href}"]`);
    // Poll: a modal animating out may transiently cover the bar (legitimate);
    // the guarantee is that the tab is tappable AT REST within a few seconds.
    await expect
      .poll(
        () =>
          link.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return hit === el || el.contains(hit);
          }),
        { timeout: 5_000, message: `${tab.label} tab is covered at its centre point` },
      )
      .toBe(true);
    // Navigation with retry: an announcement modal re-opening in the same
    // frame can swallow one click — the tab must land within three attempts.
    let navigated = false;
    for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
      await dismissAnnouncement(page);
      await link.click({ force: true });
      navigated = await page
        .waitForURL(new RegExp(tab.href.replace(/\//g, "\\/")), { timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
    }
    expect(navigated, `${tab.label} tab did not navigate after 3 attempts`).toBe(true);
    await expect(page).toHaveURL(new RegExp(tab.href.replace(/\//g, "\\/")));
    await expect(nav.locator(`a[href="${tab.href}"]`)).toHaveAttribute("aria-current", "page");
    await page.waitForTimeout(400);
  }
});

test("schedule: class detail sheet opens above the tab bar", async ({ page }) => {
  await page.goto("/member/schedule");
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await dismissAnnouncement(page);

  // Open the first class entry if the seeded timetable has one today/this week.
  const firstClass = page.locator("main button").filter({ hasText: /:\d{2}|am|pm|Coach/i }).first();
  if (await firstClass.isVisible().catch(() => false)) {
    // The class chip is absolutely positioned inside the nested-scroll time
    // grid — Playwright's pointer can't always reach it. A DOM-level click
    // still runs the React handler; the assertion below verifies the sheet
    // actually opens.
    await firstClass.evaluate((el) => (el as HTMLElement).click());
    // The EventSheet (fixed inset-0 overlay) should appear above the nav —
    // not the always-present-but-empty Toast container, hence inset-0.
    const overlay = page.locator("div.fixed.inset-0:visible").last();
    await expect(overlay).toBeVisible();
  }
});

test("shop: add to cart → cart sheet opens with checkout control", async ({ page }) => {
  await page.goto("/member/shop");
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  const addButton = page.locator("main button", { hasText: /add/i }).first();
  if (await addButton.isVisible().catch(() => false)) {
    await addButton.click();
    // Cart affordance appears; open it.
    const cartButton = page.locator("button", { hasText: /cart|basket|\d+ item/i }).first();
    if (await cartButton.isVisible().catch(() => false)) {
      await cartButton.click();
      await expect(page.locator("button", { hasText: /checkout|pay/i }).first()).toBeVisible();
    }
  }
});

test("profile: notification switches keep fixed geometry and toggle", async ({ page }) => {
  await page.goto("/member/profile");
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  const switches = page.locator('button[role="switch"]');
  const count = await switches.count();
  expect(count, "notification switches missing from profile").toBeGreaterThanOrEqual(2);

  for (let i = 0; i < count; i++) {
    const sw = switches.nth(i);
    // §5a control geometry: track must be exactly 40×22 regardless of context.
    const box = await sw.boundingBox();
    expect(Math.round(box?.width ?? 0), `switch ${i} width stretched`).toBe(40);
    expect(Math.round(box?.height ?? 0), `switch ${i} height stretched`).toBe(22);
  }

  // Toggling flips aria-checked (and rolls back only on network failure).
  const first = switches.first();
  const before = await first.getAttribute("aria-checked");
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  // Restore original state to keep the seeded member unchanged.
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", before ?? "true");
});

test("branding contrast holds under worst-case accents", async ({ page }) => {
  await page.goto("/member/profile");
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Worst-case tenant accent (UI-RULES §2a): near-white #ffe14d. An
  // `!important` author rule beats the inline --color-primary the member
  // layout sets — pure style injection, no settings API writes.
  await page.addStyleTag({ content: "* { --color-primary: #ffe14d !important; }" });

  const switches = page.locator('button[role="switch"]');
  expect(await switches.count(), "no switches to audit on profile").toBeGreaterThanOrEqual(1);
  // Prefer a checked switch — its track is filled with the injected accent.
  const checked = page.locator('button[role="switch"][aria-checked="true"]');
  const target = (await checked.count()) > 0 ? checked.first() : switches.first();

  const result = await target.evaluate((el) => {
    const transparent = (c: string) => c === "transparent" || /rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c);
    // Nearest ancestor painting a real background = the card behind the switch.
    let node: HTMLElement | null = el.parentElement;
    let cardBg = "";
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !transparent(bg)) { cardBg = bg; break; }
      node = node.parentElement;
    }
    const thumb = el.querySelector("span");
    const thumbStyle = thumb ? getComputedStyle(thumb) : null;
    return {
      trackBg: getComputedStyle(el).backgroundColor,
      cardBg,
      thumbBorderWidth: thumbStyle ? parseFloat(thumbStyle.borderTopWidth) : 0,
      thumbBorderTransparent: thumbStyle ? transparent(thumbStyle.borderTopColor) : true,
    };
  });

  expect(result.trackBg, "switch track invisible against its card").not.toBe(result.cardBg);
  expect(result.thumbBorderWidth, "thumb hairline border missing").toBeGreaterThanOrEqual(1);
  expect(result.thumbBorderTransparent, "thumb border is transparent").toBe(false);
});

test("no hardcoded gym identity in the shell before load", async ({ page }) => {
  // For the seeded member "Total BJJ" IS the real gym — legitimate once
  // fetched or cached. This test verifies the PRE-FETCH shell: with the
  // branding API blocked AND the localStorage cache cleared, the top bar
  // must show a neutral shimmer, never a seeded gym name (UI-RULES §7 —
  // the old DEFAULT_GYM constant hardcoded "Total BJJ" for every tenant).
  await page.addInitScript(() => {
    try { localStorage.removeItem("gym-settings"); } catch {}
  });
  await page.route("**/api/me/gym", (route) => route.abort());
  await page.goto("/member/home");
  await page.waitForTimeout(1500);
  const header = await page.locator("header, [class*='top']").first().innerText().catch(() => "");
  expect(header).not.toContain("Total BJJ");
  await page.unroute("**/api/me/gym");
});
