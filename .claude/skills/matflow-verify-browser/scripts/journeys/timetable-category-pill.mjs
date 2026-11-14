// A class's category pill never widens its chip past its mat column (synthetic data only).
//   node run-journeys.mjs timetable-category-pill
// Reported 14 Nov 2026 on the live week at full-screen width: "Beginners Course Gi" with its "Fundamentals" pill ran
// under the next mat's class. The pill truncates by design (components/schedule/WeekChip.tsx CategoryPill), but the
// chip, a grid item, kept the pill's whole width as its minimum, so it grew past its lane.
// Seeds the printed two-mat week split by mat, puts every class on the club's starting Fundamentals category (as the
// club in the report has it), then measures the week at five desktop widths and the staff phone's day with the
// shared layout check (lib.mjs gridInvariants: no chip outside its mat column, no two chips intersecting, nothing
// cut). Then the same category renamed (in this synthetic club's own row) to a 31-character name, near the 32
// maximum: every pill stays inside its chip and carries the whole name as its title.
import { createRequire } from "node:module";
import { state, q, ledger, shot, context, ownerSignIn, launchWithScrollbars, gridInvariants, weekGrid, weekChips, weekOnFrozenClock } from "../lib.mjs";
import { POSTER, FROZEN, seedWeek, countOn } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-category-pill");
const errors = [];
const watch = (page) => page.on("pageerror", (e) => { if (!/#418|Hydration failed|hydrat/i.test(e.message)) errors.push(e.message); });

const SESSIONS = POSTER.rows.length;
const MONDAY_N = countOn(POSTER, 0);
const WIDTHS = [[1280, 800], [1440, 900], [1680, 1050], [1920, 1080], [2560, 1440]];
const LONG = "Fundamentals and Drilling Class";

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — ").slice(0, 600));
    process.exitCode = 1;
    if (main && !main.isClosed()) await shot(main, `timetable-category-pill-fail-${id}`).catch(() => {});
  }
}

/** Every category pill on the grid: inside its chip, and its title carries the whole name. */
const pills = (page, testId) => page.evaluate((testId) => {
  const grid = document.querySelector(`[data-testid="${testId}"]`);
  return [...(grid?.querySelectorAll('[data-testid="class-chip-category"]') ?? [])].map((p) => {
    const chip = p.closest("button").getBoundingClientRect();
    const r = p.getBoundingClientRect();
    return { inside: r.left >= chip.left - 1 && r.right <= chip.right + 1, title: p.getAttribute("title"), cut: p.scrollWidth > p.clientWidth + 1 };
  });
}, testId);

const openWeek = async (page) => {
  await page.goto("/dashboard/timetable");
  await expect(weekChips(weekGrid(page))).toHaveCount(SESSIONS, { timeout: 30_000 });
  await expect(weekGrid(page)).toHaveAttribute("data-mats", "true");
  // The clock is frozen: wait for the browser's own render (Thursday 18:40 live) before measuring, as
  // timetable-week-grid does; measuring the server's render mid-swap read chips as 0 px tall.
  await weekOnFrozenClock(page, "thu", "18:40");
};

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.96.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the poster week split into Mat 1 and Mat 2 (${SESSIONS} sessions), every class on the club's starting Fundamentals category`, async () => {
    const made = await seedWeek(main, POSTER, { adopt: true });
    const cat = await q(`select id, name from "ClassCategory" where "tenantId" = $1 and "legacyKey" = 'fundamentals'`, [club.tenantId]);
    expect(cat.map((c) => c.name)).toEqual(["Fundamentals"]);
    await q(`update "Class" set "categoryId" = $2 where "tenantId" = $1`, [club.tenantId, cat[0].id]);
    const on = await q(`select count(*)::int n from "Class" where "tenantId" = $1 and "categoryId" = $2`, [club.tenantId, cat[0].id]);
    expect(on[0].n).toBe(made.classes);
    return { ...made, onFundamentals: on[0].n };
  });
  await ctx.clock.setFixedTime(new Date(FROZEN));

  for (const name of ["Fundamentals", LONG]) {
    if (name === LONG) {
      await section("rename", `this synthetic club's own Fundamentals row renamed to a ${LONG.length}-character name`, async () => {
        await q(`update "ClassCategory" set name = $2, "nameKey" = lower($2) where "tenantId" = $1 and "legacyKey" = 'fundamentals'`, [club.tenantId, LONG]);
        return LONG;
      });
    }
    for (const [width, height] of WIDTHS) {
      await section(`week-${width}-${name.length}`, `${width} px week, pill "${name}": every chip inside its own mat column, no two chips intersect, nothing cut; every pill inside its chip with the whole name as its title`, async () => {
        await main.setViewportSize({ width, height });
        await openWeek(main);
        const inv = await gridInvariants(main, { sessions: SESSIONS });
        if (inv.problems.length) L.note(`week-${width}-${name.length}-problems`, "what the layout check found", inv.problems.slice(0, 8));
        const p = await pills(main, "week-grid");
        expect(inv.problems).toEqual([]);
        expect(p.length).toBeGreaterThan(0);
        expect(p.filter((x) => !x.inside)).toEqual([]);
        expect(p.filter((x) => x.title !== name)).toEqual([]);
        // Review: prove the overflow condition was really met: at 1280 px the long name cannot fit, so pills truncate.
        if (name === LONG && width === 1280) expect(p.filter((x) => x.cut).length).toBeGreaterThan(0);
        if (width === 1920) await shot(main, `timetable-category-pill-1920-${name.length}`);
        return { pills: p.length, truncated: p.filter((x) => x.cut).length };
      });
    }
  }

  await section("phone-390", `390 px staff phone, Monday, pill "${LONG}": two mat columns, nothing outside its column or cut, every pill inside its chip`, async () => {
    const pctx = await context(browser, "10.96.1.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState(), timezoneId: "Europe/London" });
    await pctx.clock.setFixedTime(new Date(FROZEN));
    const page = await pctx.newPage();
    watch(page);
    try {
      await page.goto("/dashboard/timetable");
      await expect(page.getByRole("tab", { name: /^Thu/ })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      await page.getByRole("tab", { name: /^Mon/ }).click();
      const grid = page.getByTestId("phone-day-grid");
      await expect(grid).toHaveAttribute("data-day", "mon");
      const inv = await gridInvariants(page, { sessions: MONDAY_N, grid: "phone-day-grid" });
      const p = await pills(page, "phone-day-grid");
      expect(inv.problems).toEqual([]);
      // Review: without these the section would pass if the phone day stopped showing category pills at all.
      expect(p.length).toBeGreaterThan(0);
      expect(p.filter((x) => !x.inside)).toEqual([]);
      expect(p.filter((x) => x.title !== LONG)).toEqual([]);
      await shot(page, "timetable-category-pill-phone-390");
      return { pills: p.length, truncated: p.filter((x) => x.cut).length };
    } finally { await pctx.close(); }
  });

  await section("errors", "no uncaught page errors (the frozen clock's hydration notice excepted)", async () => {
    expect(errors.map((e) => e.slice(0, 160))).toEqual([]);
    return "none";
  });
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-category-pill-failure").catch(() => {});
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
