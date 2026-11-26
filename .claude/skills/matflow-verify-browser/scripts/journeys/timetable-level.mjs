// Every class on its own time's line, by mat and by time (synthetic data only). Noe, 25 Nov 2026: "the 19:00 classes
// which start at that time should all be under the same axis" (the 21 Nov levelling drew a 19:00 on an 18:40 line).
//   node run-journeys.mjs timetable-level
// Seeds the printed week of a two-mat club, split by mat. Saturday has Juniors Squad 11:00-12:00 on Mat 2 and
// Beginners Course Gi 11:20-12:10 on Mat 1; Tuesday has 17:45 and 17:50; the week has 19:00 classes on several days.
// Then: the week at 1440 px (each class on its own line, every 19:00 on one line with its label, no labels drawn over
// each other), the Day view, a 390 px phone, the members' day at 390 px, and the same week split by time.
// The pinned band's seam has its own journey, timetable-seam. The clock is frozen at Thursday 5 November 2026 18:45
// for staff; the members' day runs on the real clock.
import { createRequire } from "node:module";
import { state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, launchWithScrollbars, OUT, gridInvariants, phoneNoSidewaysScroll, weekGrid, weekOnFrozenClock } from "../lib.mjs";
import { POSTER, FROZEN, seedWeek, removeWeek } from "./data/timetable-weeks.mjs";

const seededIds = [];

const require = createRequire(import.meta.url);
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
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

/** Top, bottom and shown time of the chip whose accessible name contains `text`, inside `scope`. */
const chipBox = (scope, text) => scope.locator(`[data-cell-key] button[aria-label*="${text}"]`).first().evaluate((b) => {
  const r = b.getBoundingClientRect();
  return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left), time: (b.querySelector('[data-chip-part="time"]')?.textContent ?? "").trim() };
});

/** A picture of `grid` from its time gutter across, around the two Saturday classes. Returns their boxes, measured after scrolling. */
async function pairShot(page, grid, name, measure) {
  await grid.locator("[data-cell-key] button[aria-label*='11:00 to 12:00']").first().evaluate((b) => b.scrollIntoView({ block: "center" }));
  const [a, b] = await measure();
  const g = await grid.boundingBox();
  const top = Math.max(0, Math.min(a.top, b.top) - 90);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: Math.max(0, g.x), y: top, width: Math.min(g.width, page.viewportSize().width - Math.max(0, g.x)), height: Math.max(a.bottom, b.bottom) - top + 30 } });
}
const setLayout = (page, layout) => page.evaluate(async (l) => (await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: l }) })).status, layout);
const SAT = ["Juniors Squad, Saturday 11:00 to 12:00", "Beginners Course Gi, Saturday 11:20 to 12:10"];

/** The time axis inside `scope`: every chip starting at `hhmm` on one line, level with its gutter label; no two labels overlap. */
const axisAt = (scope, hhmm) => scope.evaluate((el, t) => {
  const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chips = [...el.querySelectorAll("[data-cell-key] button")].filter(vis).filter((b) => (b.getAttribute("aria-label") ?? "").includes(` ${t} to `));
  // The grid cell sits on the row line; the chip inside it is inset 1.5 px (.pg-cell).
  const tops = chips.map((b) => Math.round((b.closest("[data-cell-key]") ?? b).getBoundingClientRect().top * 10) / 10);
  const ticks = [...el.querySelectorAll(".pg-tick")].filter(vis).map((x) => ({ text: x.textContent.trim(), top: x.getBoundingClientRect().top, bottom: x.getBoundingClientRect().bottom }));
  const label = ticks.find((x) => x.text === t);
  const sorted = [...ticks].sort((a, b) => a.top - b.top);
  const overlaps = [];
  for (let i = 0; i + 1 < sorted.length; i++) if (sorted[i].bottom > sorted[i + 1].top + 0.5) overlaps.push(`${sorted[i].text}/${sorted[i + 1].text}`);
  return { chips: chips.length, spread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0, labelTop: label ? Math.round(label.top * 10) / 10 : null, chipTop: tops[0] ?? null, overlaps };
}, hhmm);

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.95.7.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the poster week on Mat 1 and Mat 2: ${POSTER.rows.length} sessions, split by mat`, async () => { const r = await seedWeek(main, POSTER, { adopt: true, ids: seededIds }); return { classes: r.classes, sessions: r.sessions }; });
  const owner = await ctx.storageState();
  await ctx.clock.setFixedTime(new Date(FROZEN));

  await section("week-real-lines", "1440 px week: Saturday's 11:20 starts below the 11:00 under its own mat, Tuesday's 17:50 below the 17:45, every 19:00 class on the one 19:00 line level with its label, no two labels overlap, and the grid's invariants hold", async () => {
    await main.goto("/dashboard/timetable");
    await weekOnFrozenClock(main, "thu", "18:40");
    const sat = weekGrid(main).locator('[data-day="sat"]');
    const tue = weekGrid(main).locator('[data-day="tue"]');
    const juniors = await chipBox(sat, "Juniors Squad, Saturday 11:00 to 12:00");
    const beginners = await chipBox(sat, "Beginners Course Gi, Saturday 11:20 to 12:10");
    expect(beginners.top).toBeGreaterThan(juniors.top + 5);
    expect(beginners.left).toBeLessThan(juniors.left);
    expect(beginners.time).toContain("11:20");
    expect(juniors.time).toContain("11:00");
    const kids = await chipBox(tue, "Kids Comp Team Gi, Tuesday 17:45 to 18:40");
    const tueBeginners = await chipBox(tue, "Beginners Course Gi, Tuesday 17:50 to 18:40");
    expect(tueBeginners.top).toBeGreaterThan(kids.top + 1);
    expect(tueBeginners.time).toContain("17:50");
    const ticks = (await weekGrid(main).locator(".pg-tick").allTextContents()).map((t) => t.trim());
    expect(ticks).toContain("11:00");
    expect(ticks).toContain("11:20");
    const at1900 = await axisAt(weekGrid(main), "19:00");
    expect(at1900.chips).toBeGreaterThan(1);
    expect(at1900.spread).toBeLessThanOrEqual(1);
    expect(Math.abs(at1900.labelTop - at1900.chipTop)).toBeLessThanOrEqual(1);
    expect(at1900.overlaps).toEqual([]);
    const inv = await gridInvariants(main, { sessions: POSTER.rows.length });
    if (inv.problems.length) throw new Error(inv.problems.join("; "));
    await shot(main, "timetable-level-week");
    await pairShot(main, weekGrid(main), "pair-week-by-mat-1440", () => Promise.all(SAT.map((x) => chipBox(sat, x))));
    return { juniors, beginners, kids, tueBeginners, at1900, chips: inv.chips };
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

  await section("day-view", "1440 px Day view, Saturday: the 11:00 and the 11:20 each start on their own line under their own mats, each with its label", async () => {
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
    expect(beginners.top).toBeGreaterThan(juniors.top + 5);
    expect(beginners.time).toContain("11:20");
    const ticks = (await grid.locator(".pg-tick").allTextContents()).map((t) => t.trim());
    expect(ticks).toContain("11:00");
    expect(ticks).toContain("11:20");
    const dayAxis = await axisAt(grid, "11:20");
    expect(dayAxis.overlaps).toEqual([]);
    expect(Math.abs(dayAxis.labelTop - dayAxis.chipTop)).toBeLessThanOrEqual(1);
    const inv = await gridInvariants(main, { sessions: 7, grid: "phone-day-grid" });
    expect(inv.problems).toEqual([]);
    await shot(main, "timetable-level-day");
    await pairShot(main, grid, "pair-day-by-mat-1440", () => Promise.all(SAT.map((x) => chipBox(grid, x))));
    return { juniors, beginners, ticks };
  });

  await section("phone", "390 px phone, Saturday: the 11:00 and the 11:20 each on their own line, each showing its own time, and nothing scrolls sideways", async () => {
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
      expect(beginners.top).toBeGreaterThan(juniors.top + 5);
      expect(beginners.time).toContain("11:20");
      const phoneAxis = await axisAt(grid, "11:20");
      expect(phoneAxis.overlaps).toEqual([]);
      expect(Math.abs(phoneAxis.labelTop - phoneAxis.chipTop)).toBeLessThanOrEqual(1);
      const sideways = await phoneNoSidewaysScroll(page);
      expect(sideways.ok).toBe(true);
      const inv = await gridInvariants(page, { sessions: 7, grid: "phone-day-grid" });
      expect(inv.problems).toEqual([]);
      await shot(page, "timetable-level-phone");
      await pairShot(page, grid, "pair-phone-by-mat-390", () => Promise.all(SAT.map((x) => chipBox(grid, x))));
      return { juniors, beginners };
    } finally {
      await pctx.close();
    }
  });

  await section("member", "390 px members' day, Saturday, split by mat: the 11:00 and the 11:20 each on their own line under their own mats, each with its label, no labels overlapping, nothing scrolls sideways", async () => {
    const member = await memberLogin(club);
    const mctx = await context(browser, "10.95.7.5", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
    try {
      const page = await mctx.newPage();
      watch(page);
      await memberSignIn(page, club, member);
      await page.goto("/member/schedule");
      await page.getByRole("button", { name: /^sat\s*\d/i }).click();
      const grid = page.getByTestId("schedule-pane").getByTestId("schedule-day");
      await expect(grid).toHaveAttribute("data-day", "sat", { timeout: 30_000 });
      const block = (text) => grid.locator(`[data-cell-key] button[aria-label^="${text}"]`).first().evaluate((b) => {
        const r = b.getBoundingClientRect();
        return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left), time: (b.querySelector('[data-block-part="time"]')?.textContent ?? "").trim() };
      });
      const measure = () => Promise.all([block("Juniors Squad, 11:00 to 12:00"), block("Beginners Course Gi, 11:20 to 12:10")]);
      const [juniors, beginners] = await measure();
      expect(beginners.top).toBeGreaterThan(juniors.top + 5);
      expect(beginners.left).toBeLessThan(juniors.left);
      expect(beginners.time).toContain("11:20");
      expect(juniors.time).toContain("11:00");
      const ticks = (await grid.locator(".pg-tick").allTextContents()).map((x) => x.trim());
      expect(ticks).toContain("11:00");
      expect(ticks).toContain("11:20");
      const memberAxis = await axisAt(grid, "11:20");
      expect(memberAxis.overlaps).toEqual([]);
      expect(Math.abs(memberAxis.labelTop - memberAxis.chipTop)).toBeLessThanOrEqual(1);
      const wide = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
      expect(wide.scroll).toBeLessThanOrEqual(wide.width + 1);
      await shot(page, "timetable-level-member");
      await pairShot(page, grid, "pair-member-by-mat-390", measure);
      return { juniors, beginners, ticks, wide };
    } finally {
      await mctx.close();
    }
  });

  await section("by-time-exact", "split by time, 1440 px week and 390 px phone: Saturday's 11:20 starts and ends below the 11:00, the gutter has both labels, and the grid's invariants hold", async () => {
    expect(await setLayout(main, "time")).toBe(200);
    try {
      await main.goto("/dashboard/timetable");
      const weekButton = main.getByTestId("timetable-view-week");
      if (await weekButton.count()) await weekButton.click();
      await weekOnFrozenClock(main, "thu", "18:40");
      const sat = weekGrid(main).locator('[data-day="sat"]');
      const measure = () => Promise.all(SAT.map((x) => chipBox(sat, x)));
      const [juniors, beginners] = await measure();
      expect(beginners.top).toBeGreaterThan(juniors.top + 5);
      expect(beginners.bottom).toBeGreaterThan(juniors.bottom + 2);
      expect(beginners.time).toContain("11:20");
      const ticks = (await weekGrid(main).locator(".pg-tick").allTextContents()).map((x) => x.trim());
      expect(ticks).toContain("11:00");
      expect(ticks).toContain("11:20");
      const inv = await gridInvariants(main, { sessions: POSTER.rows.length });
      if (inv.problems.length) throw new Error(inv.problems.join("; "));
      await shot(main, "timetable-level-week-by-time");
      await pairShot(main, weekGrid(main), "pair-week-by-time-1440", measure);

      const pctx = await context(browser, "10.95.7.4", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: owner, timezoneId: "Europe/London" });
      try {
        await pctx.clock.setFixedTime(new Date(FROZEN));
        const page = await pctx.newPage();
        watch(page);
        await page.goto("/dashboard/timetable");
        await expect(page.getByRole("tab", { name: /^Thu/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
        await page.getByRole("tab", { name: /^Sat/ }).click();
        const grid = page.getByTestId("phone-day-grid");
        await expect(grid).toHaveAttribute("data-day", "sat");
        const phone = () => Promise.all(SAT.map((x) => chipBox(grid, x)));
        const [pj, pb] = await phone();
        expect(pb.top).toBeGreaterThan(pj.top + 5);
        expect(pb.bottom).toBeGreaterThan(pj.bottom + 2);
        const pticks = (await grid.locator(".pg-tick").allTextContents()).map((x) => x.trim());
        expect(pticks).toContain("11:20");
        await pairShot(page, grid, "pair-phone-by-time-390", phone);
        return { week: { juniors, beginners }, phone: { juniors: pj, beginners: pb }, ticks, pticks };
      } finally {
        await pctx.close();
      }
    } finally {
      const back = await setLayout(main, "mat");
      if (back !== 200) throw new Error(`could not put the club back to split by mat: ${back}`);
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
  await browser.close().catch(() => {});
  // The week this journey seeded goes, so the next journey in this club seeds into a club without it.
  const left = await removeWeek(q, club.tenantId, seededIds);
  L.check("cleanup", "the classes this journey created are removed", left === 0, { created: seededIds.length, left });
  if (left) process.exitCode = 1;
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
