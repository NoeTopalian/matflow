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

test.describe("sticky rails cover what scrolls under them", () => {
  /**
   * Noe photographed this on Settings → Branding: the dark theme-preset cards
   * appearing THROUGH the tab menu. Two distinct causes, both real:
   *
   *   1. the rail's background was a gradient ending at `transparent`, so the
   *      bottom third of a sticky bar was see-through;
   *   2. `<main>` is the scrollport and carried the page's top padding. A
   *      scrollport's padding is part of the scrolling area — content scrolls
   *      through it and a `sticky top-0` child cannot rise into it. Measured:
   *      the rail pinned at 161px while `<main>`'s box top was 129px, leaving a
   *      32px band of bare page above the tabs. Every sticky rail in the staff
   *      shell had it, not just this one.
   *
   * Hit-testing rather than screenshotting on purpose. A pixel diff would need a
   * baseline and would fail on every unrelated design change; asking the browser
   * what is actually at a point is exact, and it is the same question the user's
   * eye was answering.
   */
  const RAILS = [
    { path: "/dashboard/settings", selector: ".staff-settings-rail", label: "Settings tabs" },
  ];

  /**
   * The THIRD cause, documented rather than fixed — and this comment is why.
   *
   * Below `md:` the shell lets the WINDOW scroll while `<main>` still declares
   * `overflow-y-auto`, which makes it the sticky scrollport even though it
   * never scrolls. So the settings tab rail does not stick on a phone at all —
   * measured y = -540, gone off the top of the screen.
   *
   * The one-word fix (`overflow-y-visible md:overflow-y-auto`) works: the rail
   * then pins at y = 0, and a mutation test confirmed this assertion caught its
   * absence. It was REVERTED anyway, because `UI_OVERLAP_AUDIT=1` then reported
   * two NEW findings on mobile settings — content trapped under the
   * newly-sticky chrome on the revenue and waiver tabs. That guard exists for
   * exactly this class of change and had been green, and the trade is a
   * nice-to-have (a tab bar that follows you on a phone) against a real
   * regression in a SHARED layout two days before a customer demo.
   *
   * So the desktop defect that was actually photographed is fixed; this one is
   * named, sized and left. Doing it properly means giving the mobile scroller
   * enough room — or scroll-padding — for the last element to clear the rail,
   * then re-running the overlap audit until it is green again.
   */
  test("the rail does NOT stick on mobile — known, deliberately not fixed yet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    const rail = page.locator(".staff-settings-rail");
    await expect(rail).toBeVisible({ timeout: 45_000 });
    await rail.locator("button", { hasText: "Branding" }).first().click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(800);

    const y = (await rail.boundingBox())?.y ?? 0;
    // Asserts CURRENT behaviour on purpose. Fixing it turns this red, which
    // sends whoever fixes it to the comment above rather than letting them
    // rediscover the overlap regression the hard way.
    expect(
      y,
      "the mobile rail now sticks — good, but re-run UI_OVERLAP_AUDIT=1 before shipping it: making it sticky previously trapped content on the revenue and waiver tabs",
    ).toBeLessThan(0);
  });
  for (const rail of RAILS) {
    test(`${rail.label}: nothing shows above or through it`, async ({ page }) => {
      await page.goto(rail.path, { waitUntil: "domcontentloaded" });
      const el = page.locator(rail.selector);
      await expect(el).toBeVisible({ timeout: 45_000 });

      // Scroll the scrollport, not the window: below md: the shell lets the
      // window scroll, from md: `<main>` does.
      await page.evaluate(() => {
        const m = document.querySelector("main");
        if (m && m.scrollHeight > m.clientHeight) m.scrollTop = 900;
        else window.scrollTo(0, 900);
      });
      await page.waitForTimeout(800);

      const result = await page.evaluate((selector) => {
        const main = document.querySelector("main") as HTMLElement;
        const bar = document.querySelector(selector) as HTMLElement;
        const m = main.getBoundingClientRect();
        const b = bar.getBoundingClientRect();
        const x = Math.round(b.left + b.width / 2);

        // Sample down the band from the scrollport's top edge to the bar's
        // bottom. Every hit must be the bar or something inside it.
        const intruders: string[] = [];
        for (let y = Math.ceil(m.top) + 1; y < Math.floor(b.bottom); y += 4) {
          const hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          if (hit === bar || bar.contains(hit)) continue;
          if (hit.contains(bar)) continue; // an ancestor is the page itself
          intruders.push(
            `y=${y}: <${hit.tagName.toLowerCase()} class="${(hit.className || "").toString().slice(0, 50)}">`,
          );
        }
        return { band: Math.round(b.top - m.top), intruders: intruders.slice(0, 6) };
      }, rail.selector);

      expect(
        result.band,
        "there is a gap between the top of the scrollport and the sticky bar — page content scrolls through it",
      ).toBe(0);
      expect(
        result.intruders,
        "page content is hit-testable inside the sticky bar's own band, i.e. it is showing through",
      ).toEqual([]);
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
