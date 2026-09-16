import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

/**
 * Every member-facing screen, opened as a real member, asserted to RENDER.
 *
 * The staff sweep (`demo-sweep.spec.ts`) covers the back office. This is the
 * other half a prospective customer is shown — "and here is what your members
 * get" — and it had never had a pass of any kind.
 *
 * It asserts the same four things, none of which is a status code, because this
 * codebase's documented failure mode is reporting success on failure: an HTTP
 * error rendered as an empty state, a toast on a non-ok response, a page that
 * 200s while its own data call 404s. The member portal has form: a magic-link
 * session once landed in a portal that served DEMO DATA with HTTP 200 while the
 * sibling API 404'd the same condition.
 *
 * The member portal is the DARK, tenant-branded shell (UI-RULES §1), so a
 * contrast or token mistake here shows as invisible text rather than an error —
 * which is why "a heading is visible" is asserted rather than "the route
 * resolved".
 */

const MEMBER_ROUTES = [
  { href: "/member/home", label: "Home" },
  { href: "/member/schedule", label: "Schedule" },
  { href: "/member/progress", label: "Progress" },
  { href: "/member/profile", label: "Profile" },
  { href: "/member/billing", label: "Billing" },
  { href: "/member/shop", label: "Shop" },
  { href: "/member/actions", label: "Actions" },
  // NOT listed: /member/family. app/member/family holds only [childId], so
  // there is no page at that path and its 404 is correct, not a gap. Checked
  // rather than assumed — the sweep flagged it and the route tree confirmed it.
];

const IGNORABLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /react-devtools/i,
  /webpack-hmr|turbopack-hmr/i,
  /destination stream closed early/i,
  // Recorded, not silenced: 30 call sites run Promise.all INSIDE one
  // interactive transaction, i.e. concurrent queries on a single pooled client.
  // pg@8 serialises them so results are correct today; pg@9 removes that. Named
  // by its exact text so the sweep cannot start tolerating anything else.
  /DeprecationWarning: Calling client\.query\(\) when the client is already executing a query/i,
];

function collect(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const ignorable = (t: string) => IGNORABLE.some((re) => re.test(t));
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error" && !ignorable(msg.text())) consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (!ignorable(err.message)) pageErrors.push(err.message);
  });
  return { consoleErrors, pageErrors };
}

test.describe("every member screen renders", () => {
  for (const route of MEMBER_ROUTES) {
    test(`${route.label} (${route.href})`, async ({ page }) => {
      const found = collect(page);

      const response = await page.goto(route.href, { waitUntil: "domcontentloaded" });

      // A member reaching a staff-only or missing surface must be REFUSED
      // cleanly, not shown a broken page. 404 is a legitimate answer for a
      // route this club does not offer; a 500 never is.
      const status = response?.status() ?? 0;
      expect(status, `${route.href} returned a server error`).toBeLessThan(500);

      if (status === 404) {
        // Nothing more to assert — but say so loudly rather than passing
        // silently, so a route quietly disappearing is visible in the output.
        console.log(`[member-sweep] ${route.href} -> 404 (route not present)`);
        return;
      }

      // It did not bounce to login. A member session reaching /login means the
      // gate is wrong, and it is the one failure that looks like "works" in a
      // status check.
      await expect(page, `${route.href} redirected to login`).not.toHaveURL(/\/login/, {
        timeout: 30_000,
      });

      // It composed. Any heading level — the member shell is mobile-first and
      // does not use the staff PageHeader primitive.
      await expect(
        page.locator("h1, h2").first(),
        `${route.href} rendered no heading — it responded but did not compose`,
      ).toBeVisible({ timeout: 45_000 });

      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      expect(body, `${route.href} is showing an error boundary`).not.toMatch(
        /Application error|Something went wrong|MF-[A-Z0-9]{6}/,
      );

      // The portal must never present fabricated data as real (UI-RULES).
      // A magic-link session once reached a demo-data portal with HTTP 200.
      expect(body, `${route.href} is rendering demo/placeholder data to a real member`).not.toMatch(
        /Demo Member|Sample Gym|Lorem ipsum|placeholder@/i,
      );

      await page.waitForTimeout(1500);
      expect(found.pageErrors, `${route.href} threw on the client`).toEqual([]);
      expect(found.consoleErrors, `${route.href} logged console errors`).toEqual([]);
    });
  }
});

test.describe("the member shell itself", () => {
  test("the bottom nav offers its routes and each one is reachable", async ({ page }) => {
    await page.goto("/member/home", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 45_000 });

    const missing: string[] = [];
    for (const href of ["/member/home", "/member/schedule", "/member/progress", "/member/profile"]) {
      if ((await page.locator(`a[href="${href}"]`).count()) === 0) missing.push(href);
    }
    expect(missing, "member nav entries absent from the shell").toEqual([]);
  });

  test("text is legible against the tenant's own background", async ({ page }) => {
    // The member portal is dark and TENANT-BRANDED, so a club's colour choice
    // can make text vanish — a documented hazard on the kiosk, where a light
    // tenant colour made every row disappear. Assert the heading is not the
    // same colour as what it sits on.
    await page.goto("/member/home", { waitUntil: "domcontentloaded" });
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible({ timeout: 45_000 });

    const contrast = await heading.evaluate((el) => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const fg = parse(getComputedStyle(el).color);
      let node: HTMLElement | null = el as HTMLElement;
      let bg = [0, 0, 0];
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        const parts = parse(c);
        if (parts.length === 3 && !/rgba\(.*,\s*0\)/.test(c)) { bg = parts; break; }
        node = node.parentElement;
      }
      const a = lum(fg), b = lum(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });

    // 3:1 is the WCAG floor for large text, which a page heading is.
    expect(contrast, "the member home heading is not legible on its own background").toBeGreaterThan(3);
  });
});
