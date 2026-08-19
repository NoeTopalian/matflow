import { test, expect, type Page } from "@playwright/test";
import { STAFF_NAV, type StaffNavItem } from "../../components/layout/routes";

/**
 * UI interaction audit — staff dashboard (docs/UI-RULES.md §4, plan Stage B).
 *
 * Guarantees, at BOTH viewports (desktop `chromium` project, mobile
 * `Mobile Chrome owner` project):
 *  - every STAFF_NAV route renders (no 404, no crash, content visible)
 *  - every nav item is REACHABLE from the visible navigation for that
 *    viewport (Sidebar on desktop; bottom tabs + "More" sheet on mobile)
 *  - no horizontal page overflow on mobile
 *  - no console/page errors on any route
 *  - the last interactive element on each page is not covered by the fixed
 *    mobile nav (overlap/clearance check)
 *
 * Runs as the seeded owner (owner@totalbjj.com), who can see every item.
 */

// Heavy pages (check-in roster, reports charts, Settings) need more than the
// default 30s once full-page screenshots are included.
test.describe.configure({ timeout: 60_000 });

// Safety: this suite must never run against prod (e2e resets TOTP state).
// playwright.config.ts force-loads .env.test, but assert anyway.
test.beforeAll(() => {
  const db = process.env.DATABASE_URL ?? "";
  if (db.includes("ep-bold-wave")) {
    throw new Error(
      "UI audit refused to run: DATABASE_URL points at the PROD Neon branch (ep-bold-wave). Use the .env.test branch.",
    );
  }
});

const ownerItems: StaffNavItem[] = STAFF_NAV.filter((i) => i.roles.includes("owner"));

// The dashboard renders BOTH the desktop and mobile shells in the DOM (one is
// display:none per breakpoint) — a bare `.first()` can resolve to a hidden
// heading in the inactive shell. Always match visible content only.
function visibleContent(page: Page) {
  return page.locator("main:visible, h1:visible, h2:visible").first();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// Some console noise is environmental, not a UI defect — keep this list short
// and explicit so real errors can't hide behind it.
const IGNORED_ERROR_PATTERNS = [
  /Failed to load resource.*favicon/i,
  /Download the React DevTools/i,
];

function realErrors(errors: string[]): string[] {
  return errors.filter((e) => !IGNORED_ERROR_PATTERNS.some((p) => p.test(e)));
}

test.describe("staff routes render at this viewport", () => {
  for (const item of ownerItems) {
    test(`route ${item.href} (${item.label}) renders`, async ({ page }, testInfo) => {
      const errors = collectErrors(page);
      const res = await page.goto(item.href);
      expect(res?.status(), `${item.href} should not 404/500`).toBeLessThan(400);
      // Content actually painted, not a blank shell.
      await expect(visibleContent(page)).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState("networkidle").catch(() => {});

      const isMobile = (testInfo.project.use.viewport?.width ?? 1440) < 500;
      if (isMobile) {
        // No horizontal overflow (UI-RULES §9).
        const overflow = await page.evaluate(
          () => document.scrollingElement!.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${item.href} has ${overflow}px horizontal overflow on mobile`).toBeLessThanOrEqual(1);
      }

      await page.screenshot({
        path: `test-results/ui-audit/staff-${item.href.replace(/\//g, "_")}-${isMobile ? "mobile" : "desktop"}.png`,
        fullPage: true,
      });
      expect(realErrors(errors), `${item.href} logged errors`).toEqual([]);
    });
  }
});

test("every owner nav item is reachable from the visible navigation", async ({ page }, testInfo) => {
  const isMobile = (testInfo.project.use.viewport?.width ?? 1440) < 500;
  await page.goto("/dashboard");
  await expect(visibleContent(page)).toBeVisible({ timeout: 15_000 });

  if (!isMobile) {
    // Desktop: every item is a visible Sidebar link.
    for (const item of ownerItems) {
      const link = page.locator(`aside a[href="${item.href}"]`);
      await expect(link, `Sidebar missing ${item.label} (${item.href})`).toBeVisible();
    }
    // Spot-check navigation actually works through the menu, not just goto().
    const target = ownerItems.find((i) => i.href === "/dashboard/members")!;
    await page.click(`aside a[href="${target.href}"]`);
    await expect(page).toHaveURL(new RegExp(target.href.replace(/\//g, "\\/")));
  } else {
    // Mobile: primary items sit in the bottom tab bar…
    for (const item of ownerItems.filter((i) => i.mobilePrimary)) {
      const link = page.locator(`nav[aria-label="Main navigation"] a[href="${item.href}"]`);
      await expect(link, `Mobile tab bar missing ${item.label}`).toBeVisible();
    }
    // …and every remaining item is in the "More" sheet. Scope to :visible —
    // the hidden desktop Sidebar carries the same hrefs in the DOM.
    await page.click('button[aria-label="More options"]');
    for (const item of ownerItems.filter((i) => !i.mobilePrimary)) {
      const link = page.locator(`a[href="${item.href}"]:visible`, { hasText: item.label });
      await expect(link, `"More" sheet missing ${item.label} (${item.href})`).toBeVisible();
    }
    // Sheet navigation works end-to-end (:visible — the hidden desktop
    // Sidebar carries the same href).
    await page.click('a[href="/dashboard/settings"]:visible');
    await expect(page).toHaveURL(/\/dashboard\/settings/);
    // Sign out is present in the sheet too.
    await page.click('button[aria-label="More options"]');
    await expect(page.locator('button[aria-label="Sign out"]')).toBeVisible();
  }
});

test.describe("buttons act and are not obscured", () => {
  for (const item of ownerItems) {
    test(`interactive elements on ${item.href}`, async ({ page }, testInfo) => {
      const isMobile = (testInfo.project.use.viewport?.width ?? 1440) < 500;
      await page.goto(item.href);
      await expect(visibleContent(page)).toBeVisible({ timeout: 15_000 });
      await page.waitForLoadState("networkidle").catch(() => {});

      // Every visible button/link must have an accessible name — a nameless
      // control is invisible to screen readers and usually a broken icon
      // button (UI-RULES §8).
      const nameless = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role='button']"));
        return els
          .filter((el) => el.offsetParent !== null)
          .filter((el) => !(el.textContent ?? "").trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("title") && !el.querySelector("img[alt]"))
          .map((el) => `${el.tagName}${el.className ? "." + String(el.className).split(" ")[0] : ""}`)
          .slice(0, 10);
      });
      expect(nameless, `${item.href}: visible controls with no accessible name`).toEqual([]);

      if (isMobile) {
        // Overlap check: the LAST interactive element on the page must be
        // clickable — scrolled into view, its centre point must resolve to
        // itself (not the fixed bottom nav) via elementFromPoint.
        const covered = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll<HTMLElement>("main button, main a[href]"))
            .filter((el) => el.offsetParent !== null);
          const last = els[els.length - 1];
          if (!last) return null;
          last.scrollIntoView({ block: "center" });
          const r = last.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const ok = hit === last || last.contains(hit) || (hit !== null && hit.contains(last));
          return ok ? null : `last control <${last.tagName} ${last.getAttribute("aria-label") ?? (last.textContent ?? "").slice(0, 30)}> is covered by <${hit?.tagName}.${(hit as HTMLElement | null)?.className ?? ""}>`;
        });
        expect(covered, `${item.href}: control obscured by fixed overlay`).toBeNull();
      }
    });
  }
});
