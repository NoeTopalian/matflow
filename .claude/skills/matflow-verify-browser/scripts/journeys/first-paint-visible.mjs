// Speed quick wins (S1, 6 Nov 2026): the server-rendered first view is visible before React loads, the staff shell is
// not remounted on navigation, the session is not refetched on load or tab return, secondary sidebar links are not
// prefetched, and the service worker answers navigations with navigation preload and keeps one static cache.
// Desktop and phone width. Needs `fixture.mjs create` and `server.mjs start` (run-journeys.mjs does both).
//   node journeys/first-paint-visible.mjs
import { chromium, state, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("first-paint-visible");
const errors = [];

// Effective opacity of an element: the product of its own and every ancestor's computed opacity. 0 = invisible
// however much content is in it — the shape of the old app/template.tsx wrapper before hydration.
const visibility = (selector) => (page) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { found: false };
  let o = 1;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
  const r = el.getBoundingClientRect();
  return { found: true, opacity: o, height: Math.round(r.height), text: (el.innerText || "").trim().length };
}, selector);
const visible = (v) => v.found && v.opacity === 1 && v.height > 0 && v.text > 0;

const STAFF_PAGES = ["/dashboard", "/dashboard/members", "/dashboard/timetable"];
const SECONDARY = ["/dashboard/attendance", "/dashboard/ranks", "/dashboard/promotions", "/dashboard/notifications", "/dashboard/reports", "/dashboard/attribution", "/dashboard/memberships", "/dashboard/activity", "/dashboard/payments", "/dashboard/analysis", "/dashboard/settings", "/dashboard/account"];
const PRIMARY = ["/dashboard", "/dashboard/timetable", "/dashboard/checkin", "/dashboard/members"];

const browser = await chromium.launch();
try {
  // ── Signed in once, with JavaScript, to get the session cookie. ─────────────────────────────────────────────
  const ctx = await context(browser, "10.93.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);
  const signedIn = await ctx.storageState();

  // ── Before hydration: the same pages with JavaScript OFF show the server's HTML, fully opaque. ──────────────
  for (const [label, opts] of [
    ["desktop", {}],
    ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }],
  ]) {
    const off = await context(browser, label === "desktop" ? "10.93.0.2" : "10.93.0.3", { ...opts, javaScriptEnabled: false });
    const anon = await off.newPage();
    await anon.goto("/login");
    const login = await visibility("form, main, body > div")(anon);
    L.check("before-hydration", `V1 ${label}: /login with JavaScript off shows its form, opacity 1`, visible(login), login);
    await off.close();

    const offIn = await context(browser, label === "desktop" ? "10.93.0.4" : "10.93.0.5", { ...opts, javaScriptEnabled: false, storageState: signedIn });
    const p = await offIn.newPage();
    for (const path of STAFF_PAGES) {
      const res = await p.goto(path);
      const html = (await res?.text()) ?? "";
      const v = await visibility(".dash-content")(p);
      L.check("before-hydration", `V2 ${label}: ${path} with JavaScript off shows the page content, opacity 1`, visible(v) && !/\/login/.test(p.url()), { ...v, at: new URL(p.url()).pathname });
      L.check("before-hydration", `V3 ${label}: ${path} server HTML has no hidden page-transition wrapper`, !html.includes("data-page-transition"), { length: html.length });
      if (label === "phone") {
        const m = await p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
        L.check("mobile", `M1 ${path} at 390 px with JavaScript off has no horizontal page scroll`, m.scroll <= m.width + 1, m);
      }
      await shot(p, `first-paint-nojs-${label}${path.replace(/\//g, "-")}`);
    }
    await offIn.close();
  }

  // Member area, JavaScript off: its shell is server-rendered too and must not be hidden.
  const member = await memberLogin(club);
  const mctx = await context(browser, "10.93.0.6", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(mp, club, member);
  const moff = await context(browser, "10.93.0.7", { viewport: { width: 390, height: 844 }, isMobile: true, javaScriptEnabled: false, storageState: await mctx.storageState() });
  const mpo = await moff.newPage();
  await mpo.goto("/member/home");
  const mv = await mpo.evaluate(() => {
    let min = 1;
    for (const el of document.body.querySelectorAll("*")) {
      const o = Number(getComputedStyle(el).opacity);
      if (o === 0 && el.getBoundingClientRect().height > 200) min = 0;
    }
    return { largeInvisibleBlock: min === 0, at: location.pathname };
  });
  L.check("before-hydration", "V4 phone: /member/home with JavaScript off has no large block held at opacity 0", !mv.largeInvisibleBlock && /\/member/.test(mv.at), mv);
  await moff.close();
  await mctx.close();

  // ── After hydration (desktop, JavaScript on). ──────────────────────────────────────────────────────────────
  const sessionCalls = [];
  const rscCalls = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/auth/session") sessionCalls.push(r.method());
    const h = r.headers();
    if (h["rsc"] || h["next-router-prefetch"]) rscCalls.push({ path: u.pathname, prefetch: !!h["next-router-prefetch"] });
  });
  await page.goto("/dashboard");
  await page.waitForLoadState("load");
  await page.waitForTimeout(4000); // viewport prefetches fire after idle
  const prefetched = [...new Set(rscCalls.filter((c) => c.prefetch).map((c) => c.path))];
  L.check("prefetch", "P1 secondary sidebar links are not prefetched on load", !prefetched.some((p) => SECONDARY.includes(p)), { prefetched });
  L.note("prefetch", "P2 main links prefetched on load", prefetched.filter((p) => PRIMARY.includes(p)));
  L.check("session", "S1 loading the dashboard makes no /api/auth/session request", sessionCalls.length === 0, { requests: sessionCalls.length });
  await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  await page.waitForTimeout(1500);
  L.check("session", "S2 returning to the tab makes no /api/auth/session request", sessionCalls.length === 0, { requests: sessionCalls.length });

  // Navigation keeps the shell: the sidebar element is the same node after a client-side move.
  await page.evaluate(() => { const a = document.querySelector("aside"); if (a) a.dataset.s1Mark = "kept"; });
  await page.locator("aside").getByRole("link", { name: "Members", exact: true }).click();
  await page.waitForURL(/\/dashboard\/members/);
  await page.locator(".dash-content").first().waitFor();
  const after = await page.evaluate(() => {
    let o = 1;
    for (let n = document.querySelector(".dash-content"); n && n.nodeType === 1; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return { kept: document.querySelector("aside")?.dataset.s1Mark === "kept", opacity: o };
  });
  L.check("navigation", "N1 moving Dashboard → Members keeps the sidebar (no full remount)", after.kept, after);
  L.check("navigation", "N2 the new page is fully visible straight after the move", after.opacity === 1, after);
  // Secondary links still work when clicked (prefetch off only).
  await page.locator("aside").getByRole("link", { name: "Reports", exact: true }).click();
  await page.waitForURL(/\/dashboard\/reports/);
  const rep = await visibility(".dash-content")(page);
  L.check("navigation", "N3 a secondary link (Reports) still opens its page when clicked", visible(rep), rep);
  await shot(page, "first-paint-desktop-reports");

  // ── Service worker (its own context: journeys block service workers by default). ───────────────────────────
  const swctx = await context(browser, "10.93.0.8", { serviceWorkers: "allow", storageState: signedIn });
  const sp = await swctx.newPage();
  sp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await sp.goto("/dashboard");
  const sw = await sp.evaluate(async () => {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 20000))]);
    if (!reg) return { ready: false };
    for (let i = 0; i < 40 && !reg.active; i++) await new Promise((r) => setTimeout(r, 250));
    const pre = reg.navigationPreload ? await reg.navigationPreload.getState() : null;
    return { ready: true, active: !!reg.active, preload: pre?.enabled ?? null, caches: await caches.keys() };
  });
  L.check("service-worker", "W1 the service worker enables navigation preload", sw.ready && sw.preload === true, sw);
  // A navigation answered by the service worker (with preload) still renders the page.
  const preloadHeader = [];
  sp.on("request", (r) => { if (r.isNavigationRequest()) preloadHeader.push(r.headers()["service-worker-navigation-preload"] ?? null); });
  await sp.reload();
  const swv = await visibility(".dash-content")(sp);
  L.check("service-worker", "W2 a reload through the service worker renders the page", visible(swv), swv);
  L.note("service-worker", "W3 navigation preload header seen on the reload", preloadHeader);
  const keys = await sp.evaluate(() => caches.keys());
  L.check("service-worker", "W4 only the current static cache exists", keys.every((k) => k === "matflow-static-v2"), keys);
  await swctx.close();

  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
