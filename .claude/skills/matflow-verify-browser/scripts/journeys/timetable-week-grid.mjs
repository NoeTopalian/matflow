// Timetable week as a poster grid, split by time (synthetic data only).
//   node run-journeys.mjs timetable-week-grid
// Seeds the printed week of a two-mat club (51 sessions, six days, same-time pairs every day) through the create
// API of the app, then proves on the staff week: every session is on the grid and nothing is cut; classes at the same
// time sit side by side and a class alone takes the whole day; the week fits a 1440 px window with scrollbars on show
// and says so when it does not; the day names and the time gutter stay pinned while the box scrolls; the wide page;
// keyboard order, focus rings and contrast under three club accents; a coach who cannot edit; the layout without
// subgrid; and that the phone list is as it was. The clock is frozen at Thursday 5 November 2026 18:45 for the
// geometry, so Ended, Live and Next are on show; each surface is also loaded once on the real clock.
import { createRequire } from "node:module";
import {
  state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, launchWithScrollbars,
  weekGrid, weekDay, weekChips, gridInvariants, noSidewaysScroll, spare, setAccent, accentOf, contrast, focusRing, weekOnFrozenClock,
  keepServerHtml, hydrationDiff,
} from "../lib.mjs";
import { POSTER, DAY, FROZEN, FROZEN_DAY, FROZEN_MIN, seedWeek, sessionsOn, countOn, chipName, classesOf } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-week-grid");
const errors = [];
let hydration = 0;
let frozen = false;
const watch = (page) => page.on("pageerror", (e) => {
  // The server renders on the real clock and the browser on the frozen one, so React reports a text mismatch
  // (#418) and re-renders. Only that error, only while the clock is frozen, is counted instead of failed.
  if (frozen && /#418|Hydration failed|hydrat/i.test(e.message)) hydration += 1;
  else errors.push(`${new URL(page.url()).pathname}: ${e.message}`);
});

const SESSIONS = POSTER.rows.length;
const MONDAY = sessionsOn(POSTER, 0);
const ACCENTS = [["#ffffff", "255,255,255"], ["#ffe14d", "255,225,77"], ["#111111", "17,17,17"]];
const SIZES = { 1440: 900, 1366: 768, 1280: 800, 1024: 768, 1920: 1080 };
const size = (page, width) => page.setViewportSize({ width, height: SIZES[width] });
const wider = (page) => page.getByTestId("week-wider");
const box = (page) => page.getByTestId("week-scroller");
const freeze = async (ctx) => { await ctx.clock.setFixedTime(new Date(FROZEN)); frozen = true; };
const openWeek = async (page) => {
  await page.goto("/dashboard/timetable");
  await expect(weekChips(weekGrid(page))).toHaveCount(SESSIONS, { timeout: 30_000 });
  // On the frozen clock, wait for the browser's own render (Thursday 18:40 is live) before touching anything.
  if (frozen) await weekOnFrozenClock(page, "thu", "18:40");
};

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    const at = /timetable-week-grid\.mjs:(\d+)/.exec(String(e.stack ?? ""))?.[1];
    L.check(id, desc, false, [at ? `line ${at}` : null, lines[0], ...lines.filter((l) => /waiting for|Expected|Received/.test(l)).slice(0, 3).map((l) => l.trim())].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-week-grid-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.94.6.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  {
    // The first load, before any class exists, is a real-clock load too: if React reports a mismatch here, say where.
    const kept = await keepServerHtml(main, "/dashboard/timetable");
    await main.goto("/dashboard/timetable");
    await kept.stop();
    await main.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await main.waitForTimeout(3000); // a hydration error is reported a moment after the page settles
    if (errors.length > 0) L.note("first-load-hydration", "server HTML against the browser's render on the empty timetable", await hydrationDiff(main, await kept.html()));
  }

  await section("seed", `the poster week is created through the create API: ${SESSIONS} sessions in ${classesOf(POSTER).length} classes`, async () => {
    const made = await seedWeek(main, POSTER);
    const rows = await q(`select count(*)::int n from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1 and s."isActive" = true`, [club.tenantId]);
    expect(rows[0].n).toBe(SESSIONS);
    return { ...made, scheduleRows: rows[0].n };
  });

  await section("real-clock", "on the real clock the week loads with every session and no browser error", async () => {
    const before = errors.length;
    const kept = await keepServerHtml(main, "/dashboard/timetable");
    const html = await kept.load();
    await kept.stop();
    await expect(weekChips(weekGrid(main))).toHaveCount(SESSIONS, { timeout: 30_000 });
    await main.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // A mismatch between the server's HTML and the browser's first render: say where before measuring.
    if (errors.length > before) L.note("real-clock-hydration", "server HTML against the browser render: what only one of them has", await hydrationDiff(main, html));
    expect(errors.map((e) => e.slice(0, 160))).toEqual([]);
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems.slice(0, 5)).toEqual([]);
    return { chips: inv.chips, errors: errors.length };
  });

  await freeze(ctx);
  await openWeek(main);

  await section("invariants", `1440 px, Thursday 18:45: all ${SESSIONS} sessions on the grid, same start same height, nothing cut or overlapping, chips at least 44 px; the week opens on the live class under the pinned day names without moving focus`, async () => {
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems).toEqual([]);
    expect(inv.dayDisplay).toBe("grid");
    const live = weekDay(main, "thu").locator('[data-session-state="live"]').first();
    await expect(live).toBeVisible();
    const where = await main.evaluate(() => {
      const scroller = document.querySelector('[data-testid="week-scroller"]');
      const head = document.querySelector('[data-day-head="thu"]').getBoundingClientRect();
      const chip = document.querySelector('[data-day="thu"] [data-session-state="live"]').getBoundingClientRect();
      const b = scroller.getBoundingClientRect();
      return { belowBand: chip.top >= head.bottom - 1, insideBox: chip.bottom <= b.bottom + 1, scrollTop: scroller.scrollTop, focusOnBody: document.activeElement === document.body };
    });
    expect(where.belowBand).toBe(true);
    expect(where.insideBox).toBe(true);
    expect(where.focusOnBody).toBe(true);
    // The week is taller than its box, so being on the 18:40 class means the box did scroll.
    expect(where.scrollTop).toBeGreaterThan(0);
    const labels = await weekChips(weekDay(main, "thu")).evaluateAll((els) => els.map((e) => e.dataset.sessionState ?? ""));
    const expected = sessionsOn(POSTER, FROZEN_DAY).map((s) => (s.end <= FROZEN_MIN ? "ended" : s.start <= FROZEN_MIN ? "live" : ""));
    expect(labels.map((s) => (s === "next" || s === "upcoming" ? "" : s))).toEqual(expected);
    expect(labels.filter((s) => s === "next").length).toBeGreaterThanOrEqual(1);
    return { ...inv, problems: inv.problems.length, ...where, thursday: labels };
  });

  await section("stays-put", "the box is positioned once: scrolled back to the morning, it stays there when the clock passes 19:00 (another class is now live) and the page re-renders", async () => {
    const scroller = box(main);
    await scroller.evaluate((el) => { el.scrollTop = 0; el.scrollLeft = 0; });
    const hide = main.getByTestId("timetable-hide-menu");
    await ctx.clock.setFixedTime(new Date("2026-11-05T19:05:00Z"));
    await hide.click(); // any state change re-renders the page on the new time
    await expect(hide).toHaveText("Show menu");
    const liveNow = weekDay(main, "thu").locator('[data-session-state="live"]');
    await expect(liveNow.first()).toHaveAccessibleName(/Thursday 19:00 to 20:30/);
    const at = await scroller.evaluate((el) => ({ top: el.scrollTop, left: el.scrollLeft }));
    expect(at).toEqual({ top: 0, left: 0 });
    // Back to 18:45 for the steps that follow, and the menu back on show.
    await ctx.clock.setFixedTime(new Date(FROZEN));
    await hide.click();
    await expect(hide).toHaveText("Hide menu");
    await expect(liveNow.first()).toHaveAccessibleName(/Thursday 18:40 to 19:00/);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(0);
    return { scrollAfterTheClockMovedOn: at };
  });

  await section("side-by-side","Monday 06:30: the two classes share a top edge and do not overlap; the class alone at 07:20 is as wide as the day", async () => {
    const mon = weekDay(main, "mon");
    const pair = MONDAY.filter((s) => s.startTime === "06:30");
    const alone = MONDAY.filter((s) => MONDAY.every((o) => o === s || o.end <= s.start || o.start >= s.end));
    expect(pair).toHaveLength(2);
    expect(alone[0]?.startTime).toBe("07:20");
    const rect = async (s) => (await mon.getByRole("button", { name: new RegExp(`^Edit ${chipName(s, 0).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).boundingBox());
    const [a, b] = [await rect(pair[0]), await rect(pair[1])];
    expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1).toBe(true);
    const head = await main.locator('[data-day-head="mon"]').boundingBox();
    const solo = await rect(alone[0]);
    expect(head.width - solo.width).toBeLessThanOrEqual(6);
    expect(solo.width).toBeGreaterThan(a.width + b.width - 2);
    return { pair: pair.map((s) => chipName(s, 0)), pairTops: [a.y, b.y], pairWidths: [a.width, b.width], alone: chipName(alone[0], 0), aloneWidth: solo.width, dayWidth: head.width };
  });

  await section("fits", "scrollbars on show: at 1440 the week fits and says nothing; at 1366, 1280 and 1024 the box scrolls, says so, and the page does not scroll sideways; Hide menu makes it fit at 1366 and 1280; a reload brings the menu back", async () => {
    const out = {};
    await size(main, 1440);
    await expect.poll(async () => (await noSidewaysScroll(main)).boxScrolls).toBe(false);
    await expect(wider(main)).toHaveText("");
    out[1440] = { ...(await noSidewaysScroll(main)), spare: await spare(main) };
    expect(out[1440].ok).toBe(true);
    L.note("fits", "pixels to spare at 1440 with scrollbars on show", out[1440].spare);
    await shot(main, "timetable-week-grid-1440");
    for (const width of [1366, 1280, 1024]) {
      await size(main, width);
      await expect(wider(main)).toHaveText("Wider than this window. Scroll sideways, or hide the menu.");
      out[width] = { ...(await noSidewaysScroll(main)), spare: await spare(main) };
      expect(out[width].boxScrolls).toBe(true);
      expect(out[width].ok).toBe(true);
      if (width !== 1024) await shot(main, `timetable-week-grid-${width}`);
    }
    const hide = main.getByTestId("timetable-hide-menu");
    for (const width of [1366, 1280]) {
      await size(main, width);
      await expect(hide).toHaveText("Hide menu");
      await hide.click();
      await expect(hide).toHaveText("Show menu");
      await expect(main.locator(".dash-sidebar")).toBeHidden();
      await expect(wider(main)).toHaveText("");
      out[`${width} menu hidden`] = { ...(await noSidewaysScroll(main)), spare: await spare(main) };
      expect(out[`${width} menu hidden`].boxScrolls).toBe(false);
      expect(out[`${width} menu hidden`].ok).toBe(true);
      const inv = await gridInvariants(main, { sessions: SESSIONS });
      expect(inv.problems).toEqual([]);
      if (width === 1366) await shot(main, "timetable-week-grid-1366-menu-hidden");
      await hide.click();
      await expect(main.locator(".dash-sidebar")).toBeVisible();
    }
    await size(main, 1366);
    await hide.click();
    await expect(main.locator(".dash-sidebar")).toBeHidden();
    await main.reload();
    await expect(weekChips(weekGrid(main))).toHaveCount(SESSIONS, { timeout: 30_000 });
    await expect(main.locator(".dash-sidebar")).toBeVisible();
    await expect(main.getByTestId("timetable-hide-menu")).toHaveText("Hide menu");
    return out;
  });

  await section("pinned", "1366 x 768, menu showing: the box scrolls to its end with Mon still at its top edge and on top; scrolled sideways the time gutter has not moved; at page scroll 0 the box ends inside the window", async () => {
    await size(main, 1366);
    await expect(wider(main)).toHaveText(/Wider than this window/);
    const out = await main.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scroller = document.querySelector('[data-testid="week-scroller"]');
      const mainEl = document.querySelector("main");
      mainEl.scrollTop = 0;
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      await frame();
      const chip = document.querySelector('[data-day="mon"] [data-cell-key] button');
      const head = document.querySelector('[data-day-head="mon"]');
      const tick = document.querySelector(".pg-tick");
      const before = { chipTop: chip.getBoundingClientRect().top, headTop: head.getBoundingClientRect().top, boxTop: scroller.getBoundingClientRect().top, boxBottom: scroller.getBoundingClientRect().bottom, tickLeft: tick.getBoundingClientRect().left };
      scroller.scrollTop = scroller.scrollHeight;
      await frame();
      const h = head.getBoundingClientRect();
      const at = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2);
      const down = { scrollTop: scroller.scrollTop, chipTop: chip.getBoundingClientRect().top, headTop: h.top, headOnTop: !!at && head.contains(at), headText: head.textContent };
      scroller.scrollLeft = scroller.scrollWidth;
      await frame();
      const gutter = document.querySelector(".pg-gutter-bg").getBoundingClientRect();
      const across = { scrollLeft: scroller.scrollLeft, tickLeft: tick.getBoundingClientRect().left, gutterLeft: gutter.left, boxLeft: scroller.getBoundingClientRect().left, headLeft: head.getBoundingClientRect().left, headLeftBefore: h.left };
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      return { before, down, across, windowHeight: window.innerHeight, mainScrollTop: mainEl.scrollTop };
    });
    expect(out.down.scrollTop).toBeGreaterThan(50);
    expect(out.before.chipTop - out.down.chipTop).toBeGreaterThan(50);
    expect(Math.abs(out.down.headTop - out.before.headTop)).toBeLessThanOrEqual(1);
    expect(out.down.headTop - out.before.boxTop).toBeLessThanOrEqual(2);
    expect(out.down.headOnTop).toBe(true);
    expect(out.down.headText).toContain("Mon");
    expect(out.across.scrollLeft).toBeGreaterThan(10);
    expect(Math.abs(out.across.tickLeft - out.before.tickLeft)).toBeLessThanOrEqual(1);
    expect(out.across.headLeftBefore - out.across.headLeft).toBeGreaterThan(10);
    expect(out.before.boxBottom).toBeLessThanOrEqual(out.windowHeight + 1);
    return out;
  });

  await section("wide", "1920 px: a lane is over 110 px and at most 220 px wide; the class cards under the grid are no wider than 1,152 px", async () => {
    await size(main, 1920);
    await expect(wider(main)).toHaveText("");
    const lanes = await weekGrid(main).locator('[data-cell-key]').evaluateAll((cells) => cells.filter((c) => c.closest("[data-day]").querySelectorAll(`[data-cell-key][data-row-start="${c.dataset.rowStart}"]`).length === 2).map((c) => c.getBoundingClientRect().width));
    expect(lanes.length).toBeGreaterThan(10);
    expect(Math.min(...lanes)).toBeGreaterThan(110);
    expect(Math.max(...lanes)).toBeLessThanOrEqual(220);
    const cards = await main.locator('main div[class*="max-w-[72rem]"]').first().boundingBox();
    expect(cards.width).toBeLessThanOrEqual(1152);
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems).toEqual([]);
    const fit = await noSidewaysScroll(main);
    expect(fit.ok).toBe(true);
    expect(fit.boxScrolls).toBe(false);
    await shot(main, "timetable-week-grid-1920");
    await size(main, 1440);
    return { laneMin: Math.min(...lanes), laneMax: Math.max(...lanes), cardsWidth: cards.width, narrowestChip: inv.narrowestChip };
  });

  await section("keyboard", "Tab walks Monday in time, then column order; Shift+Tab back from the end of the box never lands a chip under the pinned day names; Enter opens the right class and focus comes back to the chip", async () => {
    await size(main, 1366);
    const mon = weekDay(main, "mon");
    const expected = MONDAY.map((s) => `Edit ${chipName(s, 0)}`);
    await weekChips(mon).first().focus();
    const seen = [];
    for (let i = 0; i < expected.length; i++) {
      seen.push(await main.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null));
      if (i < expected.length - 1) await main.keyboard.press("Tab");
    }
    expect(seen).toEqual(expected);
    // From the far end of the box, back through Monday: the box scrolls each chip clear of the pinned band.
    await box(main).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const stops = [];
    for (let i = expected.length - 1; i >= 0; i--) {
      if (i < expected.length - 1) await main.keyboard.press("Shift+Tab");
      else await weekChips(mon).last().focus();
      stops.push(await main.evaluate(() => {
        const el = document.activeElement;
        const head = document.querySelector('[data-day-head="mon"]').getBoundingClientRect();
        const scroller = document.querySelector('[data-testid="week-scroller"]').getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute("aria-label"), clearOfBand: r.top >= head.bottom - 1, insideBox: r.bottom <= scroller.bottom + 1 };
      }));
    }
    expect(stops.map((s) => s.label)).toEqual([...expected].reverse());
    expect(stops.filter((s) => !s.clearOfBand).map((s) => s.label)).toEqual([]);
    expect(stops.filter((s) => !s.insideBox).map((s) => s.label)).toEqual([]);
    // Enter on the first Monday chip opens that class; closing the form puts focus back on the chip.
    const first = weekChips(mon).first();
    await first.focus();
    await main.keyboard.press("Enter");
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue(MONDAY[0].name);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => main.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null)).toBe(expected[0]);
    await size(main, 1440);
    return { tabStops: seen.length, backStops: stops.length, focusBackOn: expected[0] };
  });

  const coach = await seedStaff(club, "coach");
  for (const [i, [hexValue, rgb]] of ACCENTS.entries()) {
    await section(`accent-${hexValue}`, `club accent ${hexValue}: the focus ring on a chip is solid and at least 3:1; "Today" and the day name read at 4.5:1 or better; Ended, Live and Next on a near-black class read at 4.5:1 or better; a coach finds every chip disabled, and the box itself takes focus with a visible ring and scrolls with the arrow keys`, async () => {
      await setAccent(club, hexValue);
      const octx = await context(browser, `10.94.6.${10 + i}`, { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
      const out = {};
      try {
        const page = await octx.newPage();
        watch(page);
        await ownerSignIn(page, club);
        await octx.clock.setFixedTime(new Date(FROZEN));
        await openWeek(page);
        expect(await accentOf(page)).toBe(rgb);
        const thu = weekDay(page, "thu");
        await page.keyboard.press("Tab");
        const chip = weekChips(thu).first();
        await chip.focus();
        out.chipRing = await focusRing(chip);
        expect(out.chipRing.focused).toBe(true);
        expect(out.chipRing.focusVisible).toBe(true);
        expect(out.chipRing.style).toBe("solid");
        expect(out.chipRing.width).toBeGreaterThanOrEqual(2);
        expect(out.chipRing.contrast).toBeGreaterThanOrEqual(3);
        const head = page.locator('[data-day-head="thu"]');
        await expect(head.getByText("Today", { exact: true })).toBeVisible();
        out.today = await contrast(head.getByText("Today", { exact: true }));
        out.dayName = await contrast(head.locator("span").first());
        expect(out.today).toBeGreaterThanOrEqual(4.5);
        expect(out.dayName).toBeGreaterThanOrEqual(4.5);
        out.pills = {};
        for (const pill of ["Ended", "Live", "Next"]) {
          const dark = thu.locator(`[data-session-state="${pill.toLowerCase()}"]`).filter({ hasText: "Mat 1" }).first();
          await expect(dark).toBeVisible();
          const text = dark.getByText(pill, { exact: true });
          await text.scrollIntoViewIfNeeded();
          out.pills[pill] = await contrast(text);
          expect(out.pills[pill]).toBeGreaterThanOrEqual(4.5);
          out[`name on ${pill.toLowerCase()} chip`] = await contrast(dark.locator('[data-chip-part="name"]'));
          expect(out[`name on ${pill.toLowerCase()} chip`]).toBeGreaterThanOrEqual(4.5);
        }
        if (i === 0) await shot(page, "timetable-week-grid-accent-white");
      } finally {
        await octx.close();
      }
      const cctx = await context(browser, `10.94.6.${20 + i}`, { viewport: { width: 1366, height: 768 }, timezoneId: "Europe/London" });
      try {
        const page = await cctx.newPage();
        watch(page);
        await staffSignIn(page, club, coach);
        await cctx.clock.setFixedTime(new Date(FROZEN));
        await openWeek(page);
        expect(await accentOf(page)).toBe(rgb);
        const chips = await weekChips(weekGrid(page)).evaluateAll((els) => els.map((e) => ({ disabled: e.disabled, edit: (e.getAttribute("aria-label") ?? "").startsWith("Edit "), opacity: getComputedStyle(e).opacity })));
        expect(chips).toHaveLength(SESSIONS);
        expect(chips.filter((c) => !c.disabled || c.edit || c.opacity !== "1")).toEqual([]);
        const scroller = box(page);
        await page.keyboard.press("Tab");
        await scroller.focus();
        out.boxRing = await focusRing(scroller);
        expect(out.boxRing.focused).toBe(true);
        expect(out.boxRing.focusVisible).toBe(true);
        expect(out.boxRing.style).toBe("solid");
        expect(out.boxRing.contrast).toBeGreaterThanOrEqual(3);
        await scroller.evaluate((el) => { el.scrollTop = 0; });
        for (let k = 0; k < 4; k++) await page.keyboard.press("ArrowDown");
        await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
        out.coachArrowScroll = await scroller.evaluate((el) => el.scrollTop);
        out.coachChipsDisabled = chips.length;
        if (i === 0) await shot(page, "timetable-week-grid-coach");
      } finally {
        await cctx.close();
      }
      return out;
    });
  }

  await section("fallback", "without subgrid (the @supports block switched off) every invariant still holds and the pairs still sit side by side", async () => {
    await main.addStyleTag({ content: `
      .pg-day { display: contents !important; }
      .pg-day > .pg-head, .pg-day > .pg-empty { grid-column: calc(var(--d) + 1) / span var(--dt) !important; }
      .pg-day > .pg-mat, .pg-day > .pg-cell { grid-column: calc(var(--d) + var(--c)) / span var(--s) !important; }
    ` });
    await expect.poll(async () => (await gridInvariants(main, { sessions: SESSIONS })).dayDisplay).toBe("contents");
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems).toEqual([]);
    const fit = await noSidewaysScroll(main);
    expect(fit.ok).toBe(true);
    expect(fit.boxScrolls).toBe(false);
    await shot(main, "timetable-week-grid-fallback");
    await main.reload();
    await expect(weekChips(weekGrid(main))).toHaveCount(SESSIONS, { timeout: 30_000 });
    return { ...inv, problems: inv.problems.length, ...fit };
  });

  for (const width of [375, 390]) {
    await section(`phone-${width}`, `${width} px on the real clock: the day tabs and the list work as before, every Monday session is listed, rows are at least 44 px, and the page does not scroll sideways`, async () => {
      const mobile = await context(browser, `10.94.6.${width === 375 ? 30 : 31}`, { viewport: { width, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState(), timezoneId: "Europe/London" });
      const phone = await mobile.newPage();
      const before = errors.length;
      const wasFrozen = frozen;
      frozen = false;
      phone.on("pageerror", (e) => errors.push(`${new URL(phone.url()).pathname}: ${e.message}`));
      try {
        await phone.goto("about:blank");
        const kept = await keepServerHtml(phone, "/dashboard/timetable");
        await phone.goto("/dashboard/timetable");
        await kept.stop();
        await phone.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        if (errors.length > before) L.note(`phone-${width}-hydration`, "server HTML against the browser render: what only one of them has", await hydrationDiff(phone, await kept.html()));
        await phone.getByRole("tab", { name: /^Mon/ }).click();
        const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
        const rows = agenda.getByRole("button", { name: /^Edit / });
        await expect(rows).toHaveCount(countOn(POSTER, 0));
        await expect(weekGrid(phone)).toBeHidden();
        const counts = await phone.getByRole("tab").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[2]?.textContent));
        expect(counts).toEqual(DAY.map((_, d) => (countOn(POSTER, d) ? String(countOn(POSTER, d)) : "—")));
        const heights = await rows.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
        expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
        const sideways = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        expect(sideways).toBe(false);
        await rows.first().click();
        await expect(phone.getByLabel("Class Name", { exact: true })).toHaveValue(/.+/);
        await phone.keyboard.press("Escape");
        await expect(phone.getByRole("dialog")).toHaveCount(0);
        await shot(phone, `timetable-week-grid-phone-${width}`);
        expect(errors.slice(before)).toEqual([]);
        return { rows: heights.length, minRowHeight: Math.min(...heights), counts, sideways };
      } finally {
        frozen = wasFrozen;
        await mobile.close();
      }
    });
  }

  L.note("errors", "React hydration mismatches (#418) while the browser clock was frozen and the server clock was not", hydration);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-week-grid-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await setAccent(club, "#3b82f6").catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
