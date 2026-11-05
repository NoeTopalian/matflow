// A three-mat club on the staff phone and the members' day (synthetic data only).
//   node run-journeys.mjs timetable-day-columns-three-mats
// Seeds a club with three mats (one named "Competition Mat Upstairs", 24 characters), a class on no mat with a typed
// place ("Sports hall") and two classes sharing a mat, and turns the typed places into mats. At 320, 360, 375 and 390
// px, as staff and as a member: Saturday's three single mats are three columns with nothing cut and the long name
// readable in full in its header; Monday (three mats, a class on no mat and a shared mat) is too much to show by mat
// on a phone, so it is drawn by time with the sentence, every chip naming its mat and the Sports hall class its place.
import { createRequire } from "node:module";
import { state, q, ledger, shot, context, ownerSignIn, gridInvariants, phoneNoSidewaysScroll, memberLogin, memberSignIn } from "../lib.mjs";
import { THREE_MATS, seedWeek, countOn } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
// Assertions wait 20 s (see timetable-mats.mjs: the slow path to the test branch measured 5 Nov 2026).
const { chromium } = require("@playwright/test");
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-day-columns-three-mats");
const errors = [];
const LONG = "Competition Mat Upstairs";
const FELL_BACK = "Too much on at once to show by mat on this screen. Each class shows its mat.";
const SAT = countOn(THREE_MATS, 5);
const MON = countOn(THREE_MATS, 0);

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
  }
}

/** The long mat's header in full: not cut either way, and its whole name on show. */
const longHeader = (grid) => grid.evaluate((g, long) => {
  const head = [...g.querySelectorAll("[data-mat-head]")].find((h) => (h.textContent ?? "").trim() === long);
  if (!head) return { found: false };
  const span = head.querySelector(".pg-mat-pill > span");
  return { found: true, cut: span.scrollWidth > span.clientWidth + 1 || span.scrollHeight > span.clientHeight + 1, lines: Math.round(span.getBoundingClientRect().height / parseFloat(getComputedStyle(span).lineHeight)) };
}, LONG);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.96.1.1", { viewport: { width: 1440, height: 900 } });
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");
  const member = await memberLogin(club);

  await section("seed", `three mats from the typed places (the long one included), a Sports hall class on no mat, ${THREE_MATS.rows.length} sessions`, async () => {
    const made = await seedWeek(main, THREE_MATS, { adopt: true });
    const mats = await q(`select name from "Mat" where "tenantId" = $1 order by "sortOrder"`, [club.tenantId]);
    expect(mats.map((m) => m.name)).toEqual(["Competition Mat Upstairs", "Mat 1", "Mat 2"].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
    return made;
  });
  const owner = await ctx.storageState();

  for (const width of [320, 360, 375, 390]) {
    await section(`staff-${width}`, `${width} px staff phone: Saturday is three mat columns, nothing cut, the long mat name whole in its header; Monday is by time with the sentence, each chip naming its mat and the Sports hall class its place; no sideways scroll`, async () => {
      const pctx = await context(browser, `10.96.2.${width % 250}`, { viewport: { width, height: 800 }, isMobile: true, hasTouch: true, storageState: owner });
      try {
        const page = await pctx.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto("/dashboard/timetable");
        await page.getByRole("tab", { name: /^Sat/ }).click();
        const grid = page.getByTestId("phone-day-grid");
        await expect(grid).toHaveAttribute("data-day", "sat");
        await expect(grid).toHaveAttribute("data-mats", "true");
        expect(await grid.locator("[data-mat-head]").count()).toBe(3);
        const sat = await gridInvariants(page, { sessions: SAT, grid: "phone-day-grid" });
        expect(sat.problems).toEqual([]);
        const head = await longHeader(grid);
        expect(head).toMatchObject({ found: true, cut: false });
        expect((await phoneNoSidewaysScroll(page)).ok).toBe(true);
        await shot(page, `timetable-three-mats-staff-sat-${width}`);
        await page.getByRole("tab", { name: /^Mon/ }).click();
        await expect(grid).toHaveAttribute("data-day", "mon");
        await expect(page.getByTestId("phone-day-fallback")).toHaveText(FELL_BACK);
        await expect(grid).not.toHaveAttribute("data-mats", "true");
        const mon = await gridInvariants(page, { sessions: MON, grid: "phone-day-grid" });
        expect(mon.problems).toEqual([]);
        const places = await grid.locator("[data-cell-key] button").evaluateAll((els) => els.map((b) => [b.getAttribute("aria-label"), b.querySelector('[data-chip-part="place"]')?.textContent ?? null]));
        expect(places.filter(([, p]) => !p)).toEqual([]);
        expect(places.find(([l]) => /^Edit Yoga for BJJ,/.test(l))?.[1]).toBe("Sports hall");
        expect((await phoneNoSidewaysScroll(page)).ok).toBe(true);
        await shot(page, `timetable-three-mats-staff-mon-${width}`);
        return { satNarrowest: sat.narrowestChip, longHeaderLines: head.lines, monNarrowest: mon.narrowestChip };
      } finally {
        await pctx.close();
      }
    });
  }

  for (const width of [320, 360, 375, 390]) {
    await section(`member-${width}`, `${width} px member: Saturday is three mat columns, nothing cut, the long mat name whole; Monday is by time with the sentence and the Sports hall class shows its place`, async () => {
      const mctx = await context(browser, `10.96.3.${width % 250}`, { viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
      try {
        const page = await mctx.newPage();
        page.on("pageerror", (e) => errors.push(e.message));
        await memberSignIn(page, club, member);
        await page.goto("/member/schedule");
        const pane = page.getByTestId("schedule-pane");
        await page.getByRole("button", { name: /^Sat\s*\d/ }).click();
        const day = pane.getByTestId("schedule-day");
        await expect(day).toHaveAttribute("data-mats", "true", { timeout: 30_000 });
        expect(await day.locator("[data-mat-head]").count()).toBe(3);
        const sat = await gridInvariants(page, { sessions: SAT, grid: "schedule-day", within: '[data-testid="schedule-pane"]' });
        expect(sat.problems).toEqual([]);
        expect(await longHeader(day)).toMatchObject({ found: true, cut: false });
        await shot(page, `timetable-three-mats-member-sat-${width}`);
        await page.getByRole("button", { name: /^Mon\s*\d/ }).click();
        await expect(pane.getByTestId("schedule-fallback")).toHaveText(FELL_BACK);
        await expect(day).not.toHaveAttribute("data-mats", "true");
        const mon = await gridInvariants(page, { sessions: MON, grid: "schedule-day", within: '[data-testid="schedule-pane"]' });
        expect(mon.problems).toEqual([]);
        await expect(pane.getByRole("button", { name: /^Yoga for BJJ,/ }).getByTestId("schedule-cell-place")).toHaveText("Sports hall");
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        expect(sideways).toBe(false);
        await shot(page, `timetable-three-mats-member-mon-${width}`);
        return { satNarrowest: sat.narrowestChip, monNarrowest: mon.narrowestChip };
      } finally {
        await mctx.close();
      }
    });
  }

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-three-mats-failure").catch(() => {});
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
