// The Day view, the staff phone and the members' day on the poster grid, split by mat (synthetic data only).
//   node run-journeys.mjs timetable-day-columns
// Seeds the printed week of a two-mat club and turns its typed places into mats, so the club is split by mat.
// Then: the staff Day view in mat columns on the clock scale, in its own box with the mat names pinned; the staff
// phone's Monday (two mat columns, nothing cut, the 20-minute class clear of the next, 13 px names, the mat on every
// chip, the day tabs marked without the club colour); the members' Monday on the default dark shell and a light one
// (mat columns, pinned opaque names, every block reachable above the bottom navigation, a swipe to Tuesday, the class
// sheet, booking and cancelling); the owner choosing By time on a phone and everyone following; five at once as two
// classes and "+3 more" for staff and members; and measured contrast on the members' day under three accents.
// The clock is frozen at Thursday 5 November 2026 18:45 except where a section says otherwise.
import { createRequire } from "node:module";
import {
  state, q, ledger, shot, context, ownerSignIn, launchWithScrollbars, gridInvariants, phoneNoSidewaysScroll,
  setAccent, accentOf, contrast, memberLogin, memberSignIn,
} from "../lib.mjs";
import { POSTER, FROZEN, seedWeek, countOn } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
// Assertions wait 20 s (see timetable-mats.mjs: the slow path to the test branch measured 5 Nov 2026).
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-day-columns");
const errors = [];
let hydration = 0;
const watch = (page) => page.on("pageerror", (e) => {
  // Staff pages: the server renders on the real clock, the browser on the frozen one; React reports #418 and re-renders.
  if (/#418|Hydration failed|hydrat/i.test(e.message)) hydration += 1;
  else errors.push(e.message);
});


const MONDAY_N = countOn(POSTER, 0);
const TUESDAY_N = countOn(POSTER, 1);
const ACCENTS = ["#ffffff", "#ffe14d", "#111111"];
const LIGHT_SHELL = "#f5f5f4";
const STRESS = ["Stress A", "Stress B", "Stress C", "Stress D", "Stress E"];
const storedLayout = async () => (await q(`select "timetableLayout" v from "Tenant" where id = $1`, [club.tenantId]))[0].v;

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-day-columns-fail-${id}`).catch(() => {});
      await main.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      for (let i = 0; i < 4 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

/** A staff phone page on the frozen clock, signed in as the owner, on the timetable with Monday chosen. */
async function staffPhone(browser, width, ip, storageState) {
  const ctx = await context(browser, ip, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, storageState, timezoneId: "Europe/London" });
  await ctx.clock.setFixedTime(new Date(FROZEN));
  const page = await ctx.newPage();
  watch(page);
  await page.goto("/dashboard/timetable");
  // The browser's own render (frozen clock: Thursday) has replaced the server's before anything is pressed.
  await expect(page.getByRole("tab", { name: /^Thu/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await page.getByRole("tab", { name: /^Mon/ }).click();
  await expect(page.getByTestId("phone-day-grid")).toHaveAttribute("data-day", "mon");
  return { ctx, page };
}

/** A member page on the frozen clock, signed in afresh (the shell colours ride in the session), on Monday. */
async function memberPage(browser, width, ip, member) {
  const ctx = await context(browser, ip, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  await ctx.clock.setFixedTime(new Date(FROZEN));
  const page = await ctx.newPage();
  watch(page);
  await memberSignIn(page, club, member);
  await page.goto("/member/schedule");
  await page.getByRole("button", { name: /^Mon\s*2/ }).click();
  const pane = page.getByTestId("schedule-pane");
  await expect(pane.getByTestId("schedule-day")).toBeVisible({ timeout: 30_000 });
  return { ctx, page, pane };
}

/**
 * The staff Day view on Monday. A press before the page has hydrated is lost on the slow test link, so "Day" is
 * pressed again until it reports pressed.
 */
async function openMondayDayView(page) {
  const day = page.getByTestId("timetable-view-day");
  await expect(async () => {
    await day.click();
    await expect(day).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await page.getByRole("button", { name: /^Monday 2, / }).click();
}

/** Pinned header check: after scrolling `scroller` down, the element at the middle of each mat name is that name. */
const pinnedAfterScroll = (scrollerLoc) => scrollerLoc.evaluate((scroller) => {
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  return new Promise((done) => requestAnimationFrame(() => {
    const heads = [...scroller.querySelectorAll("[data-mat-head]")];
    const out = heads.map((h) => {
      const r = h.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const bg = getComputedStyle(h).backgroundColor;
      const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number)[3] ?? 1;
      return { name: (h.textContent ?? "").trim(), onTop: !!hit && h.contains(hit), alpha, top: Math.round(r.top - scroller.getBoundingClientRect().top) };
    });
    done({ scrolled: scroller.scrollTop, heads: out });
  }));
});

const browser = await launchWithScrollbars();
let owner;
try {
  const ctx = await context(browser, "10.95.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");
  const member = await memberLogin(club);

  await section("seed", `the poster week, its typed places turned into Mat 1 and Mat 2: ${POSTER.rows.length} sessions, split by mat with nothing saved`, async () => {
    const made = await seedWeek(main, POSTER, { adopt: true });
    expect(await storedLayout()).toBeNull();
    const mats = await q(`select name from "Mat" where "tenantId" = $1 order by "sortOrder"`, [club.tenantId]);
    expect(mats.map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
    return made;
  });
  owner = await ctx.storageState();
  await ctx.clock.setFixedTime(new Date(FROZEN));

  await section("day-view", "1440 px: Monday in the Day view is one column per mat on the clock scale, every block inside its own mat's column; scrolled to the end the mat names are still at the top and on top; Shift+Tab back through Mat 2 never leaves a block under them", async () => {
    await main.goto("/dashboard/timetable");
    await openMondayDayView(main);
    const box = main.getByTestId("day-scroller");
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute("aria-label", "Day timetable");
    const geometry = await box.evaluate((el) => {
      const heads = [...el.querySelectorAll("[data-mat-head]")];
      const cols = [...el.querySelectorAll("[data-day-grid-column]")];
      const blocks = [...el.querySelectorAll("[data-day-grid-block]")].map((b) => {
        const col = b.closest("[data-day-grid-column]");
        const head = heads[cols.indexOf(col)];
        const r = b.getBoundingClientRect(), h = head?.getBoundingClientRect();
        return { label: b.getAttribute("aria-label"), inside: !!h && r.left >= h.left - 1 && r.right <= h.right + 1 };
      });
      return { heads: heads.map((h) => h.textContent), blocks: blocks.length, outside: blocks.filter((b) => !b.inside).map((b) => b.label) };
    });
    expect(geometry.heads).toEqual(["Mat 1", "Mat 2"]);
    expect(geometry.blocks).toBe(MONDAY_N);
    expect(geometry.outside).toEqual([]);
    const pinned = await pinnedAfterScroll(box);
    expect(pinned.scrolled).toBeGreaterThan(0);
    expect(pinned.heads.every((h) => h.onTop)).toBe(true);
    // Keyboard: from Mat 2's last block back to its 18:40 Free Mat Space; each stop clear of the pinned names.
    const blocks = box.locator('[data-day-grid-column="' + (await box.locator("[data-mat-head]").nth(1).getAttribute("data-mat-head")) + '"] [data-day-grid-block]');
    await blocks.last().focus();
    const stops = [];
    for (let i = 0; i < 12; i++) {
      const at = await main.evaluate(() => {
        const a = document.activeElement;
        const box = document.querySelector('[data-testid="day-scroller"]');
        const head = box.querySelector("[data-mat-head]").getBoundingClientRect();
        return { label: a.getAttribute("aria-label") ?? "", top: a.getBoundingClientRect().top, headBottom: head.bottom };
      });
      stops.push(at);
      if (/^Edit Free Mat Space, 18:40/.test(at.label)) break;
      await main.keyboard.press("Shift+Tab");
    }
    expect(stops.at(-1).label).toMatch(/^Edit Free Mat Space, 18:40 to 19:00, Mat 2/);
    expect(stops.filter((s) => s.top < s.headBottom - 1)).toEqual([]);
    await shot(main, "timetable-day-columns-day-view-1440");
    await main.getByTestId("timetable-view-week").click();
    return { heads: geometry.heads, blocks: geometry.blocks, stops: stops.length, pinned: pinned.heads };
  });

  for (const width of [375, 390]) {
    await section(`phone-staff-${width}`, `${width} px staff phone, Monday: two mat columns; the 18:40 pair on one top edge; the 20-minute Free Mat Space clear of the 19:00 class; nothing cut; class names 13 px where a day has one or two lanes; every chip names its mat; no sideways scroll`, async () => {
      const { ctx: pctx, page } = await staffPhone(browser, width, `10.95.2.${width === 375 ? 1 : 2}`, owner);
      try {
        const grid = page.getByTestId("phone-day-grid");
        await expect(grid).toHaveAttribute("data-mats", "true");
        const heads = await grid.locator("[data-mat-head]").allTextContents();
        expect(heads.map((h) => h.trim())).toEqual(["Mat 1", "Mat 2"]);
        const inv = await gridInvariants(page, { sessions: MONDAY_N, grid: "phone-day-grid" });
        expect(inv.problems).toEqual([]);
        const geo = await grid.evaluate((g) => {
          const cell = (re) => [...g.querySelectorAll("[data-cell-key] button")].find((b) => re.test(b.getAttribute("aria-label") ?? ""));
          const pairA = cell(/^Edit Beginners Course Gi, Monday 18:40/), pairB = cell(/^Edit Free Mat Space, Monday 18:40/);
          const next = cell(/^Edit Advanced Gi \+ Sparring, Monday 19:00/);
          const sizes = [...g.querySelectorAll('[data-cell-key] button[data-chip-size="phone"] [data-chip-part="name"]')].map((n) => getComputedStyle(n).fontSize);
          const places = [...g.querySelectorAll("[data-cell-key] button")].map((b) => b.querySelector('[data-chip-part="place"]')?.textContent ?? null);
          return {
            pairTops: [pairA, pairB].map((b) => Math.round(b.getBoundingClientRect().top)),
            freeBottom: pairB.getBoundingClientRect().bottom, nextTop: next.getBoundingClientRect().top,
            sizes: [...new Set(sizes)], places,
          };
        });
        expect(geo.pairTops[0]).toBe(geo.pairTops[1]);
        expect(geo.freeBottom).toBeLessThanOrEqual(geo.nextTop + 1);
        expect(geo.sizes).toEqual(["13px"]);
        expect(geo.places.every((p) => p === "Mat 1" || p === "Mat 2")).toBe(true);
        const fit = await phoneNoSidewaysScroll(page);
        expect(fit.ok).toBe(true);
        await shot(page, `timetable-day-columns-phone-staff-${width}`);
        return { narrowestChip: inv.narrowestChip, shortestChip: inv.shortestChip, sizes: geo.sizes, fit };
      } finally {
        await pctx.close();
      }
    });
  }

  await section("phone-tabs", "390 px staff phone under accents #ffffff, #ffe14d and #111111: the selected tab and today's tab are told apart without the club colour (selected: a darker border and bold; today: underlined)", async () => {
    const out = {};
    for (const [i, hex] of ACCENTS.entries()) {
      await setAccent(club, hex);
      const actx = await context(browser, `10.95.3.${i + 1}`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
      try {
        await actx.clock.setFixedTime(new Date(FROZEN));
        const page = await actx.newPage();
        watch(page);
        await ownerSignIn(page, club);
        await page.goto("/dashboard/timetable");
        await expect(page.getByRole("tab", { name: /^Thu/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
        await page.getByRole("tab", { name: /^Mon/ }).click();
        out[hex] = await page.getByRole("tab").evaluateAll((tabs) => tabs.map((t) => {
          const day = t.querySelector("span");
          return { selected: t.getAttribute("aria-selected") === "true", today: t.hasAttribute("data-today"), border: getComputedStyle(t).borderTopColor, weight: getComputedStyle(day).fontWeight, underline: getComputedStyle(day).textDecorationLine };
        }));
        const accent = await accentOf(page);
        const sel = out[hex].find((t) => t.selected), today = out[hex].find((t) => t.today), plain = out[hex].find((t) => !t.selected && !t.today);
        expect(sel.border).not.toBe(plain.border);
        expect(Number(sel.weight)).toBeGreaterThan(Number(plain.weight));
        expect(today.underline).toContain("underline");
        expect(plain.underline).not.toContain("underline");
        // Neither mark is the club colour.
        expect(sel.border.replace(/\s/g, "")).not.toContain(`(${accent})`);
        await shot(page, `timetable-day-columns-tabs-${hex.slice(1)}`);
      } finally {
        await actx.close();
      }
    }
    await setAccent(club, "#3b82f6");
    return out;
  });

  for (const [shell, bg] of [["dark", null], ["light", LIGHT_SHELL]]) {
    for (const width of [375, 390]) {
      await section(`member-${shell}-${width}`, `${width} px, member, ${shell} shell: Monday in two mat columns; nothing cut, nothing overlapping, the 20-minute block clear of the 19:00 one; scrolled, the pinned mat names are on top on an opaque band; the last class scrolls fully above the bottom navigation; a swipe goes to Tuesday; a block opens its sheet; booking and cancelling work`, async () => {
        if (bg) await q(`update "Tenant" set "bgColor" = $2 where id = $1`, [club.tenantId, bg]);
        const { ctx: mctx, page, pane } = await memberPage(browser, width, `10.95.4.${(shell === "dark" ? 0 : 2) + (width === 375 ? 1 : 2)}`, member);
        try {
          const day = pane.getByTestId("schedule-day");
          await expect(day).toHaveAttribute("data-mats", "true");
          expect((await day.locator("[data-mat-head]").allTextContents()).map((t) => t.trim())).toEqual(["Mat 1", "Mat 2"]);
          const inv = await gridInvariants(page, { sessions: MONDAY_N, grid: "schedule-day", within: '[data-testid="schedule-pane"]' });
          expect(inv.problems).toEqual([]);
          const clear = await day.evaluate((g) => {
            const b = (re) => [...g.querySelectorAll("[data-cell-key] button")].find((x) => re.test(x.getAttribute("aria-label") ?? ""));
            return b(/^Free Mat Space, 18:40/).getBoundingClientRect().bottom <= b(/^Advanced Gi \+ Sparring, 19:00/).getBoundingClientRect().top + 1;
          });
          expect(clear).toBe(true);
          const scroller = pane.locator(":scope > div").first();
          const pinned = await pinnedAfterScroll(scroller);
          expect(pinned.heads.every((h) => h.onTop && h.alpha === 1)).toBe(true);
          const above = await page.evaluate(() => {
            const pane = document.querySelector('[data-testid="schedule-pane"]');
            const blocks = [...pane.querySelectorAll("[data-cell-key] button")];
            const last = blocks.reduce((a, b) => (b.getBoundingClientRect().bottom > a.getBoundingClientRect().bottom ? b : a));
            const nav = document.querySelector('nav[aria-label="Member navigation"]');
            const scroller = pane.firstElementChild;
            const r = (el) => (el ? Math.round(el.getBoundingClientRect().bottom) : null);
            return {
              lastBottom: r(last), navTop: nav ? Math.round(nav.getBoundingClientRect().top) : window.innerHeight,
              headerBottom: r(document.querySelector("header")), paneBottom: r(pane),
              scroll: scroller ? { top: Math.round(scroller.scrollTop), height: scroller.scrollHeight, client: scroller.clientHeight } : null,
            };
          });
          expect(above.lastBottom, JSON.stringify(above)).toBeLessThanOrEqual(above.navTop);
          await shot(page, `timetable-day-columns-member-${shell}-${width}`);
          // A swipe right-to-left: Tuesday.
          await page.evaluate(() => {
            const outer = document.querySelector('[data-testid="schedule-pane"]').parentElement.parentElement;
            const r = outer.getBoundingClientRect();
            const y = r.top + r.height / 2;
            const touch = (x) => new Touch({ identifier: 1, target: outer, clientX: x, clientY: y });
            outer.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(r.right - 40)], changedTouches: [touch(r.right - 40)], bubbles: true, cancelable: true }));
            for (let x = r.right - 60; x > r.left + 40; x -= 30) outer.dispatchEvent(new TouchEvent("touchmove", { touches: [touch(x)], changedTouches: [touch(x)], bubbles: true, cancelable: true }));
            outer.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [touch(r.left + 40)], bubbles: true, cancelable: true }));
          });
          await expect(page.getByText(/^Tuesday/).first()).toBeVisible({ timeout: 5000 });
          await expect(pane.getByTestId("schedule-day").locator("[data-cell-key]")).toHaveCount(TUESDAY_N);
          // The sheet, booking and cancelling, on Tuesday's Juniors Squad.
          await pane.getByRole("button", { name: /^Juniors Squad, 16:45/ }).click();
          const subscribe = page.getByRole("button", { name: "Subscribe to class" });
          await expect(subscribe).toBeVisible();
          const post = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/api/member/class-subscriptions/"));
          await subscribe.click();
          expect((await post).status()).toBeLessThan(300);
          const booked = Number((await q(`select count(*)::int n from "ClassSubscription" cs join "Class" c on c.id = cs."classId" where c."tenantId" = $1 and cs."memberId" = $2 and c.name = 'Juniors Squad'`, [club.tenantId, member.id]))[0].n);
          expect(booked).toBe(1);
          const del = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/member/class-subscriptions/"));
          await page.getByRole("button", { name: /Unsubscribe|Subscribed/ }).first().click();
          expect((await del).status()).toBeLessThan(300);
          const after = Number((await q(`select count(*)::int n from "ClassSubscription" cs join "Class" c on c.id = cs."classId" where c."tenantId" = $1 and cs."memberId" = $2 and c.name = 'Juniors Squad'`, [club.tenantId, member.id]))[0].n);
          expect(after).toBe(0);
          return { narrowestBlock: inv.narrowestChip, shortestBlock: inv.shortestChip, pinned: pinned.heads, above, booked, after };
        } finally {
          await mctx.close();
          if (bg) await q(`update "Tenant" set "bgColor" = '#111111' where id = $1`, [club.tenantId]);
        }
      });
    }
  }

  await section("everyone-sees-it", "the owner presses By time on a phone, once: 'Saved for the whole club.'; the member's Monday is then lanes by time, as are the staff phone and the Day view", async () => {
    const { ctx: pctx, page } = await staffPhone(browser, 390, "10.95.5.1", owner);
    try {
      const patches = [];
      page.on("request", (r) => { if (r.method() === "PATCH" && r.url().endsWith("/api/timetable/layout")) patches.push(r.url()); });
      await page.getByTestId("timetable-split-time").click();
      await expect(page.getByText("Saved for the whole club.")).toBeVisible();
      expect(patches).toHaveLength(1);
      expect(await storedLayout()).toBe("time");
      await page.reload();
      await page.getByRole("tab", { name: /^Mon/ }).click();
      await expect(page.getByTestId("phone-day-grid")).not.toHaveAttribute("data-mats", "true");
    } finally {
      await pctx.close();
    }
    const { ctx: mctx, pane } = await memberPage(browser, 390, "10.95.5.2", member);
    try {
      await expect(pane.getByTestId("schedule-day")).not.toHaveAttribute("data-mats", "true");
    } finally {
      await mctx.close();
    }
    await main.goto("/dashboard/timetable");
    await openMondayDayView(main);
    await expect(main.getByTestId("day-scroller")).toHaveCount(0);
    await main.getByTestId("timetable-view-week").click();
    return { stored: await storedLayout(), patches: 1 };
  });

  await section("more", "five classes at Monday 09:00: on the staff phone and for the member, two classes and '+3 more'; it lists all five inside the pane; a member opens one and its sheet appears; Escape closes the list and gives focus back; 'Show fewer' does too", async () => {
    for (const name of STRESS) {
      const status = await main.evaluate(async (body) => (await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status,
        { name, location: null, duration: 45, schedules: [{ dayOfWeek: 1, startTime: "09:00", endTime: "09:45" }] });
      expect(status).toBe(201);
    }
    const out = {};
    const { ctx: pctx, page } = await staffPhone(browser, 390, "10.95.6.1", owner);
    try {
      const grid = page.getByTestId("phone-day-grid");
      const more = grid.getByTestId("week-more");
      await expect(more).toHaveAttribute("aria-label", "3 more sessions, 09:00 to 09:45. Show them.");
      await more.click();
      const panel = grid.getByTestId("more-panel");
      await expect(panel.getByTestId("more-row")).toHaveCount(5);
      const inside = await panel.evaluate((p) => { const r = p.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
      expect(inside).toBe(true);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(more).toBeFocused();
      await shot(page, "timetable-day-columns-more-staff");
      out.staff = { rows: 5, inside };
    } finally {
      await pctx.close();
    }
    const { ctx: mctx, page: mp, pane } = await memberPage(browser, 390, "10.95.6.2", member);
    try {
      const more = pane.getByTestId("schedule-more");
      await expect(more).toHaveAttribute("aria-label", "3 more classes, 09:00 to 09:45. Show them.");
      await more.click();
      const panel = pane.getByTestId("more-panel");
      const names = await panel.getByRole("button", { name: /^Stress [A-E],/ }).count();
      expect(names).toBe(5);
      await panel.getByRole("button", { name: "Show fewer" }).click();
      await expect(panel).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.click();
      await pane.getByTestId("more-panel").getByRole("button", { name: /^Stress D,/ }).click();
      await expect(mp.getByRole("button", { name: "Subscribe to class" })).toBeVisible();
      await expect(mp.getByText("Stress D").last()).toBeVisible();
      await shot(mp, "timetable-day-columns-more-member");
      out.member = { names };
    } finally {
      await mctx.close();
    }
    return out;
  });

  await section("member-themes", "the members' day by mat on the dark shell and a light one, under accents #ffffff, #ffe14d and #111111: mat names, time labels, a break row, '+N more', panel rows and block text all measure at least 4.5:1", async () => {
    await main.evaluate(async () => (await fetch("/api/timetable/layout", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: "mat" }) })).status);
    expect(await storedLayout()).toBe("mat");
    const out = {};
    const booked = {};
    let n = 0;
    // One Monday class booked, so a filled block is measured too.
    const [{ id: bookId }] = await q(`select id from "Class" where "tenantId" = $1 and name = 'Advanced Gi + Sparring'`, [club.tenantId]);
    {
      const { ctx: bctx, page } = await memberPage(browser, 390, "10.95.7.99", member);
      try {
        const status = await page.evaluate(async (id) => (await fetch(`/api/member/class-subscriptions/${id}`, { method: "POST" })).status, bookId);
        expect(status).toBeLessThan(300);
        const held = await q(`select count(*)::int n from "ClassSubscription" where "classId" = $1 and "memberId" = $2`, [bookId, member.id]);
        expect(held[0].n).toBe(1);
      } finally {
        await bctx.close();
      }
    }
    for (const [shell, bg] of [["dark", null], ["light", LIGHT_SHELL]]) {
      if (bg) await q(`update "Tenant" set "bgColor" = $2 where id = $1`, [club.tenantId, bg]);
      for (const hex of ACCENTS) {
        await setAccent(club, hex);
        const { ctx: mctx, pane } = await memberPage(browser, 390, `10.95.7.${++n}`, member);
        try {
          const day = pane.getByTestId("schedule-day");
          const worst = {};
          const measure = async (what, loc) => {
            const count = await loc.count();
            for (let i = 0; i < count; i++) {
              const c = await contrast(loc.nth(i));
              worst[what] = Math.min(worst[what] ?? 99, c);
            }
          };
          await measure("matName", day.locator("[data-mat-head] .pg-mat-pill > span"));
          await measure("timeLabel", day.locator(".pg-tick"));
          await measure("breakRow", day.locator(".pg-break > span"));
          await measure("blockTime", day.locator('button:not([data-booked]) [data-block-part="time"]'));
          await measure("blockName", day.locator('button:not([data-booked]) [data-block-part="name"]'));
          await measure("blockLast", day.locator('button:not([data-booked]) [data-block-part="place"]'));
          // A booked block is filled with its class colour and its ink comes from the shared readableText (not
          // changed here): measured and recorded, not held to the 4.5:1 line.
          const filled = day.locator("button[data-booked] [data-block-part]");
          const seen = async () => ({
            subs: await pane.page().evaluate(async () => (await (await fetch("/api/member/me/subscriptions")).json()).classIds),
            booked: await day.locator("button[data-booked]").count(),
            named: await day.getByRole("button", { name: /^Advanced Gi \+ Sparring,/ }).count(),
          });
          await expect.poll(async () => (await seen()).booked, { message: JSON.stringify({ bookId, ...(await seen()) }) }).toBeGreaterThan(0);
          for (let i = 0; i < (await filled.count()); i++) booked[`${shell} ${hex}`] = Math.min(booked[`${shell} ${hex}`] ?? 99, await contrast(filled.nth(i)));
          // The fallen-back Monday (five at 09:00 sit beside two mats) is by time: its '+N more' and panel.
          const more = pane.getByTestId("schedule-more");
          if (await more.count()) {
            await measure("more", more.locator("span"));
            await more.click();
            await measure("panelRow", pane.getByTestId("more-panel").locator('[data-block-part="name"]'));
            await pane.getByTestId("more-panel").getByRole("button", { name: "Show fewer" }).click();
          }
          out[`${shell} ${hex}`] = worst;
          const low = Object.entries(worst).filter(([, c]) => c < 4.5);
          expect(low).toEqual([]);
        } finally {
          await mctx.close();
        }
      }
      if (bg) await q(`update "Tenant" set "bgColor" = '#111111' where id = $1`, [club.tenantId]);
    }
    await setAccent(club, "#3b82f6");
    L.note("member-booked", "the booked (filled) block's text on the members' day, lowest contrast per shell and accent", booked);
    return out;
  });

  L.note("errors", "React hydration mismatches (#418) while the browser clock was frozen and the server clock was not", hydration);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-day-columns-failure").catch(() => {});
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await q(`update "Tenant" set "bgColor" = '#111111' where id = $1`, [club.tenantId]).catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
