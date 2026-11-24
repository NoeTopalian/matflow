// Journey: three small staff fixes from the 24 Nov audit, each asserted in the browser.
//   F1 the dashboard opens at the top on a phone (owner and coach, fresh entry and Back), with today's pill
//      centred inside the week strip, which is the only thing that scrolls;
//   F14 the first Tab on a staff page is a visible "Skip to content" link, and Enter on it lands focus in the page's
//      content; pointer use never shows it or moves anything;
//   F15 the members search shows a clear keyboard focus ring (an outline of at least 2 px), and clicking into it
//      moves nothing.
// Synthetic club. Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/staff-safe-upgrades.mjs
import { chromium, state, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("staff-safe-upgrades");
const errors = [];

const where = (page) => page.evaluate(() => {
  const strip = document.querySelector("div.snap-x.snap-mandatory");
  // Today opens selected: the one pill whose fill differs from all the others.
  const pills = strip ? [...strip.children] : [];
  const today = pills.find((p) => getComputedStyle(p).backgroundColor !== getComputedStyle(pills.find((q) => q !== p) ?? p).backgroundColor && pills.filter((q) => getComputedStyle(q).backgroundColor === getComputedStyle(p).backgroundColor).length === 1) ?? null;
  const s = strip?.getBoundingClientRect(), t = today?.getBoundingClientRect();
  return {
    winY: Math.round(scrollY), mainTop: Math.round(document.querySelector("main")?.scrollTop ?? 0),
    stripScrollLeft: strip ? Math.round(strip.scrollLeft) : null,
    todayInStrip: !!s && !!t && t.left >= s.left - 1 && t.right <= s.right + 1,
    todayOffCentre: s && t ? Math.round(Math.abs((t.left + t.width / 2) - (s.left + s.width / 2))) : null,
    stripScrollable: strip ? strip.scrollWidth > strip.clientWidth + 1 : null,
  };
});

let browser;
try {
  browser = await chromium.launch();
  const coach = await seedStaff(club, "coach", { name: "Fixture Coach" });
  const sign = {};
  for (const [role, lane] of [["owner", 1], ["coach", 2]]) {
    const c = await context(browser, `10.95.5.${lane}`, { timezoneId: "Europe/London" });
    const p = await c.newPage();
    if (role === "owner") await ownerSignIn(p, club); else await staffSignIn(p, club, coach);
    sign[role] = await c.storageState();
    await c.close();
  }

  // F1
  for (const role of ["owner", "coach"]) {
    for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      const tag = `${role}@${vp.width}`;
      const ctx = await context(browser, `10.95.5.${role === "owner" ? 10 : 11}`, { viewport: vp, isMobile: true, hasTouch: true, storageState: sign[role], timezoneId: "Europe/London" });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`${tag}: ${String(e).slice(0, 200)}`));
      await page.goto("/dashboard");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200); // the strip's smooth scroll
      const fresh = await where(page);
      L.check(`F1@${tag}`, "fresh entry: the page opens at the top, and today's pill is inside the week strip", fresh.winY === 0 && fresh.mainTop === 0 && fresh.todayInStrip, fresh);
      if (role === "owner" && vp.width === 390) await shot(page, "f1-dashboard-owner-390");
      // Back: to Members by the bottom bar and back again.
      await page.locator('nav[aria-label="Main navigation"]').getByRole("link", { name: "Members", exact: true }).tap();
      await page.waitForURL(/\/dashboard\/members/, { timeout: 60000 });
      await page.goBack();
      await page.waitForURL((u) => u.pathname === "/dashboard", { timeout: 60000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);
      const back = await where(page);
      L.check(`F1@${tag}`, "after Back: the page is at the top again, today's pill inside the strip", back.winY === 0 && back.mainTop === 0 && back.todayInStrip, back);
      await ctx.close();
    }
  }

  // F14 and F15, desktop keyboard and pointer.
  const ctx = await context(browser, "10.95.5.20", { viewport: { width: 1280, height: 800 }, storageState: sign.owner, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`desktop: ${String(e).slice(0, 200)}`));
  for (const path of ["/dashboard", "/dashboard/members"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    const first = await page.evaluate(() => {
      const a = document.activeElement; const r = a?.getBoundingClientRect();
      return { text: a?.textContent?.trim() ?? null, tag: a?.tagName, visible: !!r && r.width > 20 && r.height > 10 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight };
    });
    L.check(`F14@${path}`, 'the first Tab lands on a visible "Skip to content" link', first.tag === "A" && first.text === "Skip to content" && first.visible, first);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ id: document.activeElement?.id ?? null, inMain: !!document.activeElement?.closest("main") }));
    await page.keyboard.press("Tab");
    const next = await page.evaluate(() => ({ inMain: !!document.activeElement?.closest("main"), text: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40) }));
    L.check(`F14@${path}`, "Enter on it moves focus to the content: the next Tab lands inside the page, past the sidebar and top bar", after.inMain && next.inMain, { after, next });
    if (path === "/dashboard") await shot(page, "f14-skip-link-desktop");
  }
  // Pointer: a click on the page neither reveals the link nor moves anything.
  await page.goto("/dashboard/members");
  await page.waitForLoadState("networkidle");
  const box = () => page.evaluate(() => { const h = document.querySelector("main h1, main h2"); const m = document.querySelector("main"); const r = h?.getBoundingClientRect(); return { h: r ? [Math.round(r.left), Math.round(r.top)] : null, main: m ? Math.round(m.getBoundingClientRect().top) : null, skipShown: [...document.querySelectorAll("a")].some((a) => a.textContent?.trim() === "Skip to content" && a.getBoundingClientRect().width > 20) }; });
  const b0 = await box();
  const search = page.getByPlaceholder("Search name, email, or phone");
  const s0 = await search.boundingBox();
  await search.click();
  await page.waitForTimeout(300);
  const b1 = await box();
  const s1 = await search.boundingBox();
  L.check("F14+F15@pointer", "clicking into the members search reveals no skip link and moves nothing (heading, content, search box)",
    !b1.skipShown && JSON.stringify(b0) === JSON.stringify(b1) && Math.abs(s0.x - s1.x) < 0.5 && Math.abs(s0.y - s1.y) < 0.5 && Math.abs(s0.height - s1.height) < 0.5, { b0, b1, s0, s1 });
  // F15 keyboard: Tab to the search box from the page's start; its focus ring must be a real outline.
  await page.goto("/dashboard/members");
  await page.waitForLoadState("networkidle");
  let reached = false;
  for (let i = 0; i < 60 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await search.evaluate((el) => document.activeElement === el);
  }
  const ring = reached ? await search.evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), color: s.outlineColor }; }) : null;
  L.check("F15@1280", "Tab reaches the members search and it shows a visible focus ring (outline at least 2 px)", reached && ring.style !== "none" && ring.width >= 2, { reached, ring });
  await shot(page, "f15-search-focus-desktop");
  await ctx.close();
} catch (e) {
  L.check("journey", "ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
