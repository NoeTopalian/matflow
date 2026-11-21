// Nothing shows between the pinned day header and the pinned mat names of the week timetable (synthetic data only).
//   node run-journeys.mjs timetable-seam
// Seeds the printed week of a two-mat club, split by mat, scrolls the week's box so a class is under the pinned band,
// and reads the seam pixel by pixel at 100 % and 125 % scaling: with the old CSS put back first, to show the check
// sees the gap, then with the CSS as shipped. The clock is frozen at Thursday 5 November 2026 18:45.
import { createRequire } from "node:module";
import { state, ledger, shot, context, ownerSignIn, launchWithScrollbars, weekOnFrozenClock } from "../lib.mjs";
import { POSTER, FROZEN, seedWeek } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("playwright-core/lib/utilsBundle");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-seam");
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
    if (main && !main.isClosed()) await shot(main, `timetable-seam-fail-${id}`).catch(() => {});
  }
}

const OLD_CSS = `html.old-seam .pg-grid[data-mats] .pg-head{box-shadow:none !important}html.old-seam .pg-grid:not([data-one-day]) .pg-day > .pg-mat{top:44px !important}`;

/**
 * Scrolls the week's box so a Tuesday class is under the pinned band, then reads the
 * pixels of the band's seam on Tuesday: the two CSS pixels from 42 to 44 below the box's top, between the day
 * card's side borders. Returns the measured gap between header and mat names and how many of those pixels are neither
 * the header's own colour nor the mat names' pill.
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
        css: { matTop: getComputedStyle(el.querySelector('[data-day="tue"] [data-mat-head]')).top, headShadow: getComputedStyle(el.querySelector('[data-day-head="tue"]')).boxShadow },
        rects: { box: b.top, head: [head.top - b.top, head.bottom - b.top], mats: mats.map((m) => [m.top - b.top, m.bottom - b.top]), pill: [...el.querySelectorAll('[data-day="tue"] .pg-mat-pill')].map((m) => m.getBoundingClientRect().top - b.top), cell: cells.map((c) => [c.getBoundingClientRect().top - b.top, c.getBoundingClientRect().bottom - b.top]) },
        gap: Math.round((Math.min(...mats.map((m) => m.top)) - head.bottom) * 100) / 100,
        // 42 to 44: the header's last pixel and the old gap. The mat names' own pill starts at 45.
        clip: { x: head.left + 4, y: b.top + 42, width: head.width - 8, height: 2 },
        ref: { x: head.left + 4, y: b.top + 3, width: 4, height: 4 },
        pillRef: (() => { const p = el.querySelector('[data-day="tue"] .pg-mat-pill').getBoundingClientRect(); return { x: p.left + 3, y: p.top + p.height / 2 - 2, width: 4, height: 4 }; })(),
      });
    }));
  });
  if (geo.error) throw new Error(geo.error);
  const read = async (clip) => PNG.sync.read(await page.screenshot({ clip }));
  const ref = await read(geo.ref);
  const bg = [ref.data[0], ref.data[1], ref.data[2]];
  // On a scaled display the strip's last device row can land on the top edge of the mat names' own pill: its colour is not a leak.
  const pillPng = await read(geo.pillRef);
  const pill = [pillPng.data[0], pillPng.data[1], pillPng.data[2]];
  // Header colour, pill colour, or a blend of the two (the pill's rounded corners).
  const between = (i) => [0, 1, 2].every((k) => strip.data[i + k] >= Math.min(bg[k], pill[k]) - 3 && strip.data[i + k] <= Math.max(bg[k], pill[k]) + 3);
  const strip = await read(geo.clip);
  let off = 0;
  const offRows = {};
  for (let i = 0; i < strip.data.length; i += 4) {
    if (!between(i)) {
      off += 1;
      const row = Math.floor(i / 4 / strip.width);
      offRows[row] = (offRows[row] ?? 0) + 1;
    }
  }
  await page.screenshot({ path: `${L.path.replace(/ledger-.*$/, "")}timetable-seam-seam-${tag}.png`, clip: { x: geo.clip.x - 4, y: geo.clip.y - 42, width: geo.clip.width + 8, height: 120 } }).catch(() => {});
  return { scrolled: geo.scrolled, classesUnderBand: geo.under, gapPx: geo.gap, pixelsRead: strip.data.length / 4, pixelsNotHeaderColour: off, headerColour: bg, pillColour: pill, offByImageRow: offRows, imageRows: strip.height, css: geo.css, rects: geo.rects };
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

  for (const [tag, scale, viewport] of [["100", 1, { width: 1440, height: 640 }], ["125", 1.25, { width: 1100, height: 640 }]]) {
    await section(`seam-${tag}`, `${tag} % scaling, ${viewport.width} px: with the box scrolled so a class is under the pinned band, the old CSS shows it through the seam and the new CSS does not`, async () => {
      const sctx = await context(browser, "10.95.7.2", { viewport, deviceScaleFactor: scale, storageState: owner, timezoneId: "Europe/London" });
      try {
        await sctx.clock.setFixedTime(new Date(FROZEN));
        const page = await sctx.newPage();
        watch(page);
        await page.goto("/dashboard/timetable");
        await weekOnFrozenClock(page, "thu", "18:40");
        await page.addStyleTag({ content: OLD_CSS });
        await page.evaluate(() => document.documentElement.classList.add("old-seam"));
        const before = await seam(page, `${tag}-old`);
        await page.evaluate(() => document.documentElement.classList.remove("old-seam"));
        const after = await seam(page, `${tag}-new`);
        if (!before.classesUnderBand || !after.classesUnderBand) throw new Error(`no class under the band: ${JSON.stringify({ before, after })}`);
        if (!(before.pixelsNotHeaderColour > 0) || after.pixelsNotHeaderColour !== 0 || after.gapPx > 0) throw new Error(`seam: ${JSON.stringify({ before, after })}`);
        return { before, after };
      } finally {
        await sctx.close();
      }
    });
  }

  L.note("errors", "React hydration mismatches (#418) while the browser clock was frozen and the server clock was not", hydration);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-seam-failure").catch(() => {});
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
