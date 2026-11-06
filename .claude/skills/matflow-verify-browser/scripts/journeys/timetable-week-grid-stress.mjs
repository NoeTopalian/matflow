// Timetable week as a poster grid: the hard shapes (synthetic data only).
//   node run-journeys.mjs timetable-week-grid-stress
// Seeds a busy club with no mats (23 sessions): a staggered trio, exactly three classes at once, and five at once on
// Saturday. Proves on the staff week that the trio takes two lanes with the first reused, that three at once are
// three lanes with nothing folded, that five at once show two classes and "+3 more", and that pressing it opens the
// Day view on Saturday with that group open, focus on its first class and all five names on show. Also: the "+N
// more" focus ring under three club accents, and the header of an empty day that is today.
import { createRequire } from "node:module";
import {
  state, q, ledger, shot, context, ownerSignIn, launchWithScrollbars,
  weekGrid, weekDay, weekChips, gridInvariants, noSidewaysScroll, setAccent, accentOf, focusRing, weekOnFrozenClock,
} from "../lib.mjs";
import { STRESS, FROZEN, seedWeek, sessionsOn, countOn, classesOf } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-week-grid-stress");
const errors = [];
let hydration = 0;
let frozen = false;
const watch = (page) => page.on("pageerror", (e) => {
  // Server on the real clock, browser on the frozen one: React reports the mismatch (#418) and re-renders.
  if (frozen && /#418|Hydration failed|hydrat/i.test(e.message)) hydration += 1;
  else errors.push(e.message);
});

const SESSIONS = STRESS.rows.length;
const SATURDAY = sessionsOn(STRESS, 5);
const FIVE = SATURDAY.filter((s) => s.startTime === "10:00");
const FOLDED = FIVE.length - 2;
const ACCENTS = [["#ffffff", "255,255,255"], ["#ffe14d", "255,225,77"], ["#111111", "17,17,17"]];
const onGrid = SESSIONS - FOLDED;
/** `thursday`: the page is on the frozen Thursday 18:45, so wait for the browser's own render (18:40 is live) first. */
const openWeek = async (page, { thursday = frozen } = {}) => {
  await page.goto("/dashboard/timetable");
  await expect(weekChips(weekGrid(page))).toHaveCount(onGrid, { timeout: 30_000 });
  if (thursday) await weekOnFrozenClock(page, "thu", "18:40");
};
const cellsAt = (page, day, start) => weekDay(page, day).locator("[data-cell-key]").filter({ has: page.locator('[data-chip-part="time"]', { hasText: `${start}–` }) });
const geometry = (loc) => loc.evaluateAll((cells) => cells.map((c) => {
  const r = c.getBoundingClientRect();
  return { name: c.querySelector('[data-chip-part="name"]').textContent, lane: Number(c.dataset.lane), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
}));

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    const at = /timetable-week-grid-stress\.mjs:(\d+)/.exec(String(e.stack ?? ""))?.[1];
    L.check(id, desc, false, [at ? `line ${at}` : null, lines[0], ...lines.filter((l) => /waiting for|Expected|Received/.test(l)).slice(0, 3).map((l) => l.trim())].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-week-grid-stress-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.94.7.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the stress week is created through the create API: ${SESSIONS} sessions in ${classesOf(STRESS).length} classes, none with a place`, async () => {
    const made = await seedWeek(main, STRESS);
    const rows = await q(`select count(*)::int n from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1 and s."isActive" = true`, [club.tenantId]);
    expect(rows[0].n).toBe(SESSIONS);
    return { ...made, scheduleRows: rows[0].n };
  });

  await section("real-clock", "on the real clock the week loads with no browser error", async () => {
    await main.reload();
    await expect(weekChips(weekGrid(main))).toHaveCount(onGrid, { timeout: 30_000 });
    expect(errors).toEqual([]);
    return { chips: onGrid, errors: errors.length };
  });

  await ctx.clock.setFixedTime(new Date(FROZEN));
  frozen = true;
  await openWeek(main);

  await section("invariants", `1440 px: ${onGrid} chips and ${FOLDED} behind "+${FOLDED} more" make the ${SESSIONS} seeded; same start same height, nothing cut or overlapping; the page does not scroll sideways`, async () => {
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems).toEqual([]);
    expect(inv.chips).toBe(onGrid);
    expect(inv.folded).toBe(FOLDED);
    const fit = await noSidewaysScroll(main);
    expect(fit.ok).toBe(true);
    await shot(main, "timetable-week-grid-stress-1440");
    return { ...inv, problems: inv.problems.length, ...fit };
  });

  await section("trio", "Monday 16:30, 17:00, 17:30 (each overlapping the next): two lanes, the third class back in the first lane under the first", async () => {
    const [a] = await geometry(cellsAt(main, "mon", "16:30"));
    const [b] = await geometry(cellsAt(main, "mon", "17:00"));
    const [c] = await geometry(cellsAt(main, "mon", "17:30"));
    expect([a.name, b.name, c.name]).toEqual(["Little Champs", "Kids BJJ", "Teens"]);
    expect([a.lane, b.lane, c.lane]).toEqual([0, 1, 0]);
    expect(Math.abs(a.left - c.left)).toBeLessThanOrEqual(1);
    expect(b.left).toBeGreaterThan(a.left + a.width - 2);
    expect(b.top).toBeGreaterThan(a.top);
    expect(c.top).toBeGreaterThan(b.top);
    return { a, b, c };
  });

  await section("three", "Monday 18:40, exactly three at once: three chips side by side on one top edge, and nothing folded on Monday", async () => {
    const three = await geometry(cellsAt(main, "mon", "18:40"));
    expect(three).toHaveLength(3);
    expect(new Set(three.map((x) => x.top)).size).toBe(1);
    expect(new Set(three.map((x) => x.lane)).size).toBe(3);
    const lefts = three.map((x) => x.left).sort((x, y) => x - y);
    expect(lefts[1]).toBeGreaterThan(lefts[0] + 40);
    expect(lefts[2]).toBeGreaterThan(lefts[1] + 40);
    expect([...three.map((x) => x.name)].sort()).toEqual(["Beginners Gi", "No-Gi All Levels", "Womens Class"]);
    await expect(weekDay(main, "mon").getByTestId("week-more")).toHaveCount(0);
    await expect(weekChips(weekDay(main, "mon"))).toHaveCount(countOn(STRESS, 0));
    return { three };
  });

  await section("five", `Saturday 10:00, five at once: two classes and "+${FOLDED} more" on show; pressing it opens the Day view on Saturday with that group open, focus on its first class and all five names visible`, async () => {
    const sat = weekDay(main, "sat");
    const shown = await geometry(cellsAt(main, "sat", "10:00"));
    expect(shown).toHaveLength(2);
    // The longer class is placed first; which of the four equal ones takes the second lane is theirs to settle.
    expect(shown[0].name).toBe("Parents Class");
    expect(FIVE.map((s) => s.name)).toContain(shown[1].name);
    const more = sat.getByTestId("week-more");
    await expect(more).toHaveCount(1);
    await expect(more).toHaveAccessibleName(`${FOLDED} more sessions, Saturday 10:00 to 10:45. Open the day.`);
    await expect(more).toContainText(`+${FOLDED} more`);
    const moreBox = await more.boundingBox();
    expect(moreBox.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(moreBox.y - (await sat.locator("[data-cell-key]").first().boundingBox()).y)).toBeLessThanOrEqual(3);
    await more.focus();
    await main.keyboard.press("Enter");
    const day = main.getByTestId("day-view");
    await expect(day).toBeVisible();
    await expect(main.getByTestId("timetable-view-day")).toHaveAttribute("aria-pressed", "true");
    await expect(day.getByRole("tab", { name: new RegExp(`^Saturday \\d+, ${countOn(STRESS, 5)} sessions$`) })).toHaveAttribute("aria-selected", "true");
    // The day opens with that clash listed over its grid.
    const blocks = day.getByTestId("more-panel").getByTestId("more-row");
    await expect(blocks).toHaveCount(FIVE.length);
    const names = await blocks.evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/^Edit /, "").split(",")[0]));
    expect([...names].sort()).toEqual(FIVE.map((s) => s.name).sort());
    for (let i = 0; i < FIVE.length; i++) await expect(blocks.nth(i)).toBeVisible();
    const focusOnFirst = await blocks.first().evaluate((el) => document.activeElement === el);
    expect(focusOnFirst).toBe(true);
    await shot(main, "timetable-week-grid-stress-more-opened");
    await main.getByTestId("timetable-view-week").click();
    await expect(weekChips(weekGrid(main))).toHaveCount(onGrid);
    return { shown: shown.map((s) => s.name), more: await more.getAttribute("aria-label"), opened: names, focusOnFirst };
  });

  for (const [i, [hexValue, rgb]] of ACCENTS.entries()) {
    await section(`more-ring-${hexValue}`, `club accent ${hexValue}: "+${FOLDED} more" shows a solid focus ring of at least 3:1`, async () => {
      await setAccent(club, hexValue);
      const octx = await context(browser, `10.94.7.${10 + i}`, { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
      try {
        const page = await octx.newPage();
        watch(page);
        await ownerSignIn(page, club);
        await octx.clock.setFixedTime(new Date(FROZEN));
        await openWeek(page);
        expect(await accentOf(page)).toBe(rgb);
        const more = weekDay(page, "sat").getByTestId("week-more");
        await page.keyboard.press("Tab");
        await more.focus();
        const ring = await focusRing(more);
        expect(ring.focused).toBe(true);
        expect(ring.focusVisible).toBe(true);
        expect(ring.style).toBe("solid");
        expect(ring.width).toBeGreaterThanOrEqual(2);
        expect(ring.contrast).toBeGreaterThanOrEqual(3);
        return ring;
      } finally {
        await octx.close();
      }
    });
  }

  await section("empty-today", "Sunday (no classes) as today: the Today pill takes the dash line, is at most 36 px wide and stays inside its 40 px column; no header spills", async () => {
    const sctx = await context(browser, "10.94.7.30", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London", storageState: await ctx.storageState() });
    try {
      const page = await sctx.newPage();
      watch(page);
      await sctx.clock.setFixedTime(new Date("2026-11-08T12:00:00Z"));
      await openWeek(page, { thursday: false });
      const sun = weekDay(page, "sun");
      // The browser's own render, on its Sunday: only then is Sunday the day marked as today.
      await expect(sun).toHaveAttribute("data-today", "true");
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const inv = await gridInvariants(page, { sessions: SESSIONS });
      expect(inv.problems).toEqual([]);
      await expect(sun).toHaveAccessibleName(/^Sunday 8 November, no sessions, today$/);
      const pill = sun.getByText("Today", { exact: true });
      await expect(pill).toBeVisible();
      const [p, column] = [await pill.boundingBox(), await page.locator('[data-day-head="sun"]').boundingBox()];
      expect(p.width).toBeLessThanOrEqual(36);
      expect(p.x).toBeGreaterThanOrEqual(column.x - 1);
      expect(p.x + p.width).toBeLessThanOrEqual(column.x + column.width + 1);
      expect(column.width).toBeLessThanOrEqual(41);
      await expect(sun.getByText("—")).toHaveCount(0);
      await shot(page, "timetable-week-grid-stress-empty-today");
      return { pillWidth: p.width, columnWidth: column.width, problems: inv.problems.length };
    } finally {
      await sctx.close();
    }
  });

  L.note("errors", "React hydration mismatches (#418) while the browser clock was frozen and the server clock was not", hydration);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-week-grid-stress-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await setAccent(club, "#3b82f6").catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
