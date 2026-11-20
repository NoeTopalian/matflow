// Classes on at once are drawn level, and nothing shows between the pinned day header and the pinned mat names
// (synthetic data only).
//   node run-journeys.mjs timetable-level
// Seeds the printed week of a two-mat club, split by mat. Saturday has Juniors Squad 11:00-12:00 on Mat 2 and
// Beginners Course Gi 11:20-12:10 on Mat 1; Tuesday has 17:45 and 17:50; Monday has a 19:00 that follows an 18:40
// on its own mat and must NOT be pulled up. Then: the week at 1440 px (level pairs, own times kept, no 11:20 line),
// the pinned band with the box scrolled, measured and read pixel by pixel at 100 % and 125 % scaling (with the old
// CSS put back first, to show the check sees the gap), the Day view, and a 390 px phone.
// The clock is frozen at Thursday 5 November 2026 18:45.
import { createRequire } from "node:module";
import { state, ledger, shot, context, ownerSignIn, launchWithScrollbars, gridInvariants, phoneNoSidewaysScroll, weekGrid, weekOnFrozenClock } from "../lib.mjs";
import { POSTER, FROZEN, seedWeek } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
const { PNG } = require("playwright-core/lib/utilsBundle");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-level");
const errors = [];
let hydration = 0;
const watch = (page) => page.on("pageerror", (e) => {
  // Staff pages: the server renders on the real clock, the browser on the frozen one; React reports #418 and re-renders.
  if (/#418|Hydration failed|hydrat/i.test(e.message)) hydration += 1;
  else errors.push(e.message);
});

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) await shot(main, `timetable-level-fail-${id}`).catch(() => {});
  }
}

const OLD_CSS = `.pg-grid[data-mats] .pg-head{box-shadow:none !important}.pg-grid:not([data-one-day]) .pg-day > .pg-mat{top:44px !important}`;

/** Top, bottom and shown time of the chip whose accessible name contains `text`, inside `scope`. */
const chipBox = (scope, text) => scope.locator(`[data-cell-key] button[aria-label*="${text}"]`).first().evaluate((b) => {
  const r = b.getBoundingClientRect();
  return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left), time: (b.querySelector('[data-chip-part="time"]')?.textContent ?? "").trim() };
});

/**
 * Scrolls the week's box so a Tuesday class is under the pinned band, then reads the
 * pixels of the band's seam on Tuesday: the three CSS pixels from 42 to 45 below the box's top, between the day
 * card's side borders. Returns the measured gap between header and mat names and how many of those pixels are not
 * the header's own colour.
 */
async function seam(page, tag) {
  const box = page.getByTestId("week-scroller");
  const geo = await box.evaluate((el) => {
    const within = (n) => n.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    // The first Tuesday class tall enough to reach from above the band to below it, that the box can scroll to.
    const room = el.scrollHeight - el.clientHeight;
    const cells = [...el.querySelectorAll('[data-day="tue"] [data-cell-key] button')].filter((b) => b.getBoundingClientRect().height >= 70 && within(b) - 20 > 0 && within(b) - 20 <= room).slice(0, 1);
    if (cells.length !== 1) return { error: `no Tuesday class the box can bring under the band (it scrolls ${room} px)` };
    el.scrollTop = within(cells[0]) - 20;
    return new Promise((done) => requestAnimationFrame(() => {
      const b = el.getBoundingClientRect();
      const head = el.querySelector('[data-day-head="tue"]').getBoundingClientRect();
      const mats = [...el.querySelectorAll('[data-day="tue"] [data-mat-head]')].map((m) => m.getBoundingClientRect());
      const under = cells.map((c) => c.getBoundingClientRect()).every((r) => r.top < head.bottom && r.bottom > mats[0].bottom);
      done({
        scrolled: el.scrollTop, under,
        gap: Math.round((Math.min(...mats.map((m) => m.top)) - head.bottom) * 100) / 100,
        clip: { x: head.left + 4, y: b.top + 42, width: head.width - 8, height: 3 },
        ref: { x: head.left + 4, y: b.top + 3, width: 4, height: 4 },
      });
    }));
  });
  if (geo.error) throw new Error(geo.error);
  const read = async (clip) => PNG.sync.read(await page.screenshot({ clip }));
  const ref = await read(geo.ref);
  const bg = [ref.data[0], ref.data[1], ref.data[2]];
  const strip = await read(geo.clip);
  let off = 0;
  for (let i = 0; i < strip.data.length; i += 4) {
    if (Math.abs(strip.data[i] - bg[0]) > 3 || Math.abs(strip.data[i + 1] - bg[1]) > 3 || Math.abs(strip.data[i + 2] - bg[2]) > 3) off += 1;
  }
  await page.screenshot({ path: `${L.path.replace(/ledger-.*$/, "")}timetable-level-seam-${tag}.png`, clip: { x: geo.clip.x - 4, y: geo.clip.y - 42, width: geo.clip.width + 8, height: 120 } }).catch(() => {});
  return { scrolled: geo.scrolled, classesUnderBand: geo.under, gapPx: geo.gap, pixelsRead: strip.data.length / 4, pixelsNotHeaderColour: off };
}

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.95.7.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the poster week on Mat 1 and Mat 2: ${POSTER.rows.length} sessions, split by mat`, () => seedWeek(main, POSTER, { adopt: true }));
  const owner = await ctx.storageState();
  await ctx.clock.setFixedTime(new Date(FROZEN));

  await section("week-level", "1440 px week: Saturday's 11:00 and 11:20 start and end on one line, Tuesday's 17:45 and 17:50 start on one line, each chip still shows its own time, no 11:20 in the gutter, and the grid's invariants hold", async () => {
    await main.goto("/dashboard/timetable");
    await weekOnFrozenClock(main, "thu", "18:40");
    const sat = weekGrid(main).locator('[data-day="sat"]');
    const tue = weekGrid(main).locator('[data-day="tue"]');
    const juniors = await chipBox(sat, "Juniors Squad, Saturday 11:00 to 12:00");
    const beginners = await chipBox(sat, "Beginners Course Gi, Saturday 11:20 to 12:10");
    expect(Math.abs(juniors.top - beginners.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(juniors.bottom - beginners.bottom)).toBeLessThanOrEqual(1);
    expect(beginners.left).toBeLessThan(juniors.left);
    expect(beginners.time).toContain("11:20");
    expect(juniors.time).toContain("11:00");
    const kids = await chipBox(tue, "Kids Comp Team Gi, Tuesday 17:45 to 18:40");
    const tueBeginners = await chipBox(tue, "Beginners Course Gi, Tuesday 17:50 to 18:40");
    expect(Math.abs(kids.top - tueBeginners.top)).toBeLessThanOrEqual(1);
    expect(tueBeginners.time).toContain("17:50");
    const ticks = (await weekGrid(main).locator(".pg-tick").allTextContents()).map((t) => t.trim());
    expect(ticks).toContain("11:00");
    expect(ticks).not.toContain("11:20");
    const inv = await gridInvariants(main, { sessions: POSTER.rows.length });
    if (inv.problems.length) throw new Error(inv.problems.join("; "));
    await shot(main, "timetable-level-week");
    return { juniors, beginners, kids, tueBeginners, chips: inv.chips };
  });

  await section("week-not-level", "1440 px week: Monday's 19:00 on Mat 2 follows the 18:40-19:00 on Mat 2, so it stays below the 18:40 on Mat 1 and is not drawn over the class before it", async () => {
    const mon = weekGrid(main).locator('[data-day="mon"]');
    const early = await chipBox(mon, "Beginners Course Gi, Monday 18:40 to 19:30");
    const free = await chipBox(mon, "Free Mat Space, Monday 18:40 to 19:00");
    const late = await chipBox(mon, "Advanced Gi + Sparring, Monday 19:00 to 20:30");
    expect(late.top).toBeGreaterThan(early.top + 10);
    expect(late.top).toBeGreaterThanOrEqual(free.bottom - 1);
    return { early, free, late };
  });

  for (const [tag, scale, viewport] of [["100", 1, { width: 1440, height: 640 }], ["125", 1.25, { width: 1100, height: 640 }]]) {
    await section(`seam-${tag}`, `${tag} % scaling, ${viewport.width} px: with the box scrolled so a class is under the pinned band, the old CSS shows it through the seam and the new CSS does not`, async () => {
      const sctx = await context(browser, "10.95.7.2", { viewport, deviceScaleFactor: scale, storageState: owner, timezoneId: "Europe/London" });
      try {
        await sctx.clock.setFixedTime(new Date(FROZEN));
        const page = await sctx.newPage();
        watch(page);
        await page.goto("/dashboard/timetable");
        await weekOnFrozenClock(page, "thu", "18:40");
        const style = await page.addStyleTag({ content: OLD_CSS });
        const before = await seam(page, `${tag}-old`);
        await style.evaluate((el) => el.remove());
        const after = await seam(page, `${tag}-new`);
        if (!before.classesUnderBand || !after.classesUnderBand) throw new Error(`no class under the band: ${JSON.stringify({ before, after })}`);
        expect(before.pixelsNotHeaderColour).toBeGreaterThan(0);
        expect(after.pixelsNotHeaderColour).toBe(0);
        expect(after.gapPx).toBeLessThanOrEqual(0);
        return { before, after };
      } finally {
        await sctx.close();
      }
    });
  }

  await section("day-view", "1440 px Day view, Saturday: the 11:00 and 11:20 start and end on one line under their own mats, with one 11:00 label and no 11:20 label", async () => {
    await main.goto("/dashboard/timetable");
    await weekOnFrozenClock(main, "thu", "18:40");
    const dayButton = main.getByTestId("timetable-view-day");
    await expect(async () => {
      await dayButton.click();
      await expect(dayButton).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    const view = main.getByTestId("day-view");
    await view.getByRole("tab", { name: /^Saturday 7, / }).click();
    const grid = view.getByTestId("phone-day-grid");
    await expect(grid).toHaveAttribute("data-day", "sat");
    const juniors = await chipBox(grid, "Juniors Squad, Saturday 11:00 to 12:00");
    const beginners = await chipBox(grid, "Beginners Course Gi, Saturday 11:20 to 12:10");
    expect(Math.abs(juniors.top - beginners.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(juniors.bottom - beginners.bottom)).toBeLessThanOrEqual(1);
    expect(beginners.time).toContain("11:20");
    const ticks = (await grid.locator(".pg-tick").allTextContents()).map((t) => t.trim());
    expect(ticks).toContain("11:00");
    expect(ticks).not.toContain("11:20");
    const inv = await gridInvariants(main, { sessions: 7, grid: "phone-day-grid" });
    expect(inv.problems).toEqual([]);
    await shot(main, "timetable-level-day");
    return { juniors, beginners, ticks };
  });

  await section("phone", "390 px phone, Saturday: the 11:00 and 11:20 start on one line, each showing its own time, and nothing scrolls sideways", async () => {
    const pctx = await context(browser, "10.95.7.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: owner, timezoneId: "Europe/London" });
    try {
      await pctx.clock.setFixedTime(new Date(FROZEN));
      const page = await pctx.newPage();
      watch(page);
      await page.goto("/dashboard/timetable");
      await expect(page.getByRole("tab", { name: /^Thu/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await page.getByRole("tab", { name: /^Sat/ }).click();
      const grid = page.getByTestId("phone-day-grid");
      await expect(grid).toHaveAttribute("data-day", "sat");
      const juniors = await chipBox(grid, "Juniors Squad, Saturday 11:00 to 12:00");
      const beginners = await chipBox(grid, "Beginners Course Gi, Saturday 11:20 to 12:10");
      expect(Math.abs(juniors.top - beginners.top)).toBeLessThanOrEqual(1);
      expect(beginners.time).toContain("11:20");
      const sideways = await phoneNoSidewaysScroll(page);
      expect(sideways.ok).toBe(true);
      const inv = await gridInvariants(page, { sessions: 7, grid: "phone-day-grid" });
      expect(inv.problems).toEqual([]);
      await shot(page, "timetable-level-phone");
      return { juniors, beginners };
    } finally {
      await pctx.close();
    }
  });

  L.note("errors", "React hydration mismatches (#418) while the browser clock was frozen and the server clock was not", hydration);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-level-failure").catch(() => {});
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
