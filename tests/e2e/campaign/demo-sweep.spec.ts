import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { STAFF_NAV } from "../../../components/layout/routes";

/**
 * Every staff screen, opened as the owner, asserted to actually RENDER.
 *
 * ## Why this is not redundant with the other lanes
 *
 * The other campaign specs prove specific journeys deeply. This proves the
 * shallow thing nobody has checked: that each screen a club owner can click to
 * comes up, on the real product, with real data, and without an error boundary
 * or a red console.
 *
 * That gap is not hypothetical. This codebase's documented failure mode is
 * **reporting success on failure** — an HTTP error rendered as an empty state, a
 * toast fired on a non-ok response, a page that 200s while its own data call
 * 403s. `/dashboard/members` once showed every coach a permanent red banner
 * because an owner-only widget was mounted on an all-staff page; the payments
 * hub rendered empty for a manager because the page was widened and its API was
 * not. **Both of those return HTTP 200.** A smoke test that checks status codes
 * would have passed each of them.
 *
 * So this asserts four things per route, none of which is a status code:
 *   - the URL did not bounce (a redirect away is a gate, not a render);
 *   - a real `<h1>` is present — proof the page composed, not just responded;
 *   - no segment error boundary is showing;
 *   - no uncaught page error and no console `error` was emitted while loading.
 *
 * It is the automated half of "walk the demo before Friday". The manual half —
 * printing a card on real A4 and scanning it with the phone that will be in the
 * room — still cannot be delegated.
 */

/** Routes the owner can reach, taken from the nav manifest rather than a copy. */
const OWNER_ROUTES = STAFF_NAV.filter((r) => r.roles.includes("owner")).map((r) => ({
  href: r.href,
  label: r.label,
}));

/**
 * Console noise that is not a product defect.
 *
 * Deliberately short, and every entry earns its place — a permissive list here
 * would quietly re-admit the exact class of bug this spec exists to catch.
 */
const IGNORABLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  // Next's dev overlay and HMR websocket chatter.
  /react-devtools/i,
  /webpack-hmr|turbopack-hmr/i,
  // The dev server streams RSC payloads; an aborted stream on navigation is a
  // harness artefact, not a page fault.
  /destination stream closed early/i,
  // A REAL finding, deliberately not fixed here and deliberately not hidden:
  //
  //   "Calling client.query() when the client is already executing a query is
  //    deprecated and will be removed in pg@9.0"
  //
  // 30 call sites run `Promise.all` INSIDE a single interactive transaction —
  // `withTenantContext(tid, (tx) => Promise.all([...]))` — which is concurrent
  // queries on one pooled client. `pg@8` serialises them, so results are correct
  // today and the only present costs are that the parallelism is imaginary (the
  // page is slower than the code suggests) and that a `pg@9` upgrade breaks all
  // thirty at once. It is also the documented shape of the P2028 transaction
  // timeouts this repo has already seen on /dashboard/reports.
  //
  // Narrow on purpose: this pattern only, by name. A looser rule here would
  // re-admit exactly the class of defect this sweep exists to catch, and the
  // finding stays on the residual register rather than being silenced.
  /DeprecationWarning: Calling client\.query\(\) when the client is already executing a query/i,
];

function isIgnorable(text: string): boolean {
  return IGNORABLE.some((re) => re.test(text));
}

interface Collected {
  consoleErrors: string[];
  pageErrors: string[];
}

function collect(page: Page): Collected {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!isIgnorable(text)) consoleErrors.push(text);
  });
  page.on("pageerror", (err) => {
    if (!isIgnorable(err.message)) pageErrors.push(err.message);
  });
  return { consoleErrors, pageErrors };
}

test.describe("every owner screen renders", () => {
  for (const route of OWNER_ROUTES) {
    test(`${route.label} (${route.href})`, async ({ page }) => {
      const found = collect(page);

      await page.goto(route.href, { waitUntil: "domcontentloaded" });

      // 1. It did not bounce. A redirect away is an authorisation gate firing,
      //    which for the OWNER would be a defect.
      await expect(page, `${route.href} redirected away for the owner`).toHaveURL(
        new RegExp(route.href.replace(/\//g, "\\/") + "(\\?|$|\\/)"),
        { timeout: 45_000 },
      );

      // 2. It composed. `<h1>` is the PageHeader primitive every staff screen
      //    uses, so its absence means the page did not get as far as its own
      //    header — which a 200 will not tell you.
      await expect(
        page.locator("h1").first(),
        `${route.href} rendered no heading — it responded but did not compose`,
      ).toBeVisible({ timeout: 45_000 });

      // 3. No error boundary. app/dashboard/error.tsx and global-error.tsx both
      //    surface a reference code; Next's unstyled fallback says "Application
      //    error".
      const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
      expect(body, `${route.href} is showing an error boundary`).not.toMatch(
        /Application error|Something went wrong|MF-[A-Z0-9]{6}/,
      );

      // 4. Nothing threw. Let late client work settle first — an error thrown by
      //    a deferred fetch is still an error the owner would hit.
      await page.waitForTimeout(1500);
      expect(found.pageErrors, `${route.href} threw on the client`).toEqual([]);
      expect(found.consoleErrors, `${route.href} logged console errors`).toEqual([]);
    });
  }
});

test.describe("the screens an owner reaches by clicking, not by URL", () => {
  test("the sidebar offers every owner route, and each one is reachable", async ({ page }) => {
    // The nav manifest disagreeing with what actually renders is a documented
    // defect class here — five entries were once less permissive than the route
    // they pointed at, which is worse than more permissive, because the
    // capability exists and is simply unadvertised.
    await page.goto("/dashboard");
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 45_000 });

    const missing: string[] = [];
    for (const route of OWNER_ROUTES) {
      const link = page.locator(`a[href="${route.href}"]`).first();
      if ((await link.count()) === 0) missing.push(`${route.label} (${route.href})`);
    }
    expect(missing, "owner routes absent from the navigation").toEqual([]);
  });
});
