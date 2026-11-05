// Mats, the same-time split and the staff week by mat (synthetic data only).
//   node run-journeys.mjs timetable-mats
// Seeds the printed week of a two-mat club with its mats TYPED as places (as a club has them before mats exist),
// then walks what an owner does: adds a mat by hand and sees nothing change; turns the typed places into mats in one
// press (with a forced failure first); reads the week by mat at 1440 with scrollbars on show; the choice, saved for the
// club, by a manager and read by a coach, with forced failed saves; renames, moves, removes and re-adds a mat; the
// class form's Mat select with a forced failed save; classes sharing a mat; and the Mats sheet by keyboard and on a
// phone. The clock is frozen at Thursday 5 November 2026 18:45 for the geometry.
import { createRequire } from "node:module";
import {
  state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, launchWithScrollbars,
  weekGrid, weekDay, weekChips, gridInvariants, noSidewaysScroll, spare, weekOnFrozenClock,
} from "../lib.mjs";
import { POSTER, FROZEN, seedWeek, sessionsOn, classesOf, daysWithClasses, DAY, chipName } from "./data/timetable-weeks.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-mats");
const errors = [];
let hydration = 0;
let frozen = false;
const watch = (page) => page.on("pageerror", (e) => {
  // Server on the real clock, browser on the frozen one: React reports the mismatch (#418) and re-renders.
  if (frozen && /#418|Hydration failed|hydrat/i.test(e.message)) hydration += 1;
  else errors.push(e.message);
});

const SESSIONS = POSTER.rows.length;
const CLASSES = classesOf(POSTER);
const ON = { 1: CLASSES.filter((c) => c.mat === 1).length, 2: CLASSES.filter((c) => c.mat === 2).length };
const MONDAY = sessionsOn(POSTER, 0);
const LONG = "Competition Mat Upstairs";
const SIZES = { 1440: 900, 1366: 768 };
const size = (page, width) => page.setViewportSize({ width, height: SIZES[width] });
const wider = (page) => page.getByTestId("week-wider");
const sheetOf = (page) => page.getByRole("dialog", { name: "Mats" });
const matHeads = (page, day) => weekDay(page, day).locator("[data-mat-head]").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
const chips = (page, n = SESSIONS) => expect(weekChips(weekGrid(page))).toHaveCount(n, { timeout: 30_000 });
/** After a load on the frozen clock: the browser's own render has replaced the server's (which is on the real clock). */
const settled = (page) => weekOnFrozenClock(page, "thu", "18:40");
const classesOnMats = async () => (await q(`select count(*)::int n from "Class" where "tenantId" = $1 and "matId" is not null`, [club.tenantId]))[0].n;
const matRows = () => q(`select id, name, "sortOrder" from "Mat" where "tenantId" = $1 order by "sortOrder", "createdAt"`, [club.tenantId]);
const storedLayout = async () => (await q(`select "timetableLayout" v from "Tenant" where id = $1`, [club.tenantId]))[0].v;
/** Requests the page sends to a path, counted from now. */
const count = (page, test) => {
  const seen = [];
  const on = (r) => { if (test(r)) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); };
  page.on("request", on);
  return { seen, stop: () => page.off("request", on) };
};
async function openMats(page) {
  await page.getByTestId("timetable-mats").click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Loading your mats…")).toHaveCount(0);
  return sheet;
}
async function closeMats(page) {
  await sheetOf(page).getByRole("button", { name: "Close" }).click();
  await expect(sheetOf(page)).toHaveCount(0);
}

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-mats-fail-${id}`);
      await main.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      for (let i = 0; i < 4 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.94.8.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the poster week is created with its mats typed as places: ${SESSIONS} sessions, ${ON[1]} classes saying "Mat 1" and ${ON[2]} saying "Mat 2", none on a mat`, async () => {
    const made = await seedWeek(main, POSTER);
    expect(await classesOnMats()).toBe(0);
    expect(await matRows()).toEqual([]);
    await main.reload();
    await chips(main);
    expect(errors).toEqual([]);
    return made;
  });

  await ctx.clock.setFixedTime(new Date(FROZEN));
  frozen = true;
  await main.goto("/dashboard/timetable");
  await chips(main);
  await settled(main);

  await section("by-hand", `a mat added by hand changes nothing on the timetable: still by time, "By mat" cannot be pressed and says why, and the sheet offers the ${ON[1]} classes that already say its name; the mat is then removed`, async () => {
    let sheet = await openMats(main);
    await expect(sheet.getByRole("heading", { name: "Places typed on your classes" })).toBeVisible();
    await sheet.getByRole("button", { name: "Add a mat myself" }).click();
    await sheet.getByLabel("New mat name").fill("Mat 1");
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel("Mat 1 name")).toHaveValue("Mat 1");
    await expect(sheet.getByTestId("mats-stray")).toContainText(`${ON[1]} classes say “Mat 1” but are not on it.`);
    await closeMats(main);
    await chips(main);
    await expect(weekGrid(main)).not.toHaveAttribute("data-mats", "true");
    const byMat = main.getByTestId("timetable-split-mat");
    await expect(byMat).toHaveAttribute("aria-disabled", "true");
    await expect(main.getByTestId("timetable-split-hint")).toHaveText("Put a class on a mat first: open a class and choose its mat.");
    await expect(byMat).toHaveAttribute("aria-describedby", "timetable-split-hint");
    await byMat.click({ force: true });
    await expect(main.getByTestId("timetable-split-time")).toHaveAttribute("aria-pressed", "true");
    expect(await classesOnMats()).toBe(0);
    expect(await storedLayout()).toBeNull();
    // Remove it again: nothing uses it.
    sheet = await openMats(main);
    await sheet.getByRole("button", { name: "Remove Mat 1" }).click();
    const dialog = main.getByRole("dialog", { name: "Remove Mat 1?" });
    await expect(dialog).toContainText("No classes use it.");
    await dialog.getByRole("button", { name: "Remove mat" }).click();
    await expect(sheet.getByRole("heading", { name: "Places typed on your classes" })).toBeVisible();
    await closeMats(main);
    expect(await matRows()).toEqual([]);
    return { offered: ON[1], hint: "Put a class on a mat first: open a class and choose its mat." };
  });

  await section("first-run", `"Add these as mats": a forced failure keeps both boxes ticked and says so; one retry sends one request; then ${ON[1] + ON[2]} classes are on two mats, the sheet says the week is now split by mat, and it is, without anyone pressing the choice`, async () => {
    const sheet = await openMats(main);
    const boxes = sheet.getByRole("checkbox");
    await expect(boxes).toHaveCount(2);
    await expect(sheet.getByText(`Mat 1 · ${ON[1]} classes`)).toBeVisible();
    await expect(sheet.getByText(`Mat 2 · ${ON[2]} classes`)).toBeVisible();
    expect(await boxes.evaluateAll((els) => els.map((e) => e.getAttribute("aria-checked")))).toEqual(["true", "true"]);
    const adopts = count(main, (r) => r.method() === "POST" && r.url().endsWith("/api/mats/adopt"));
    await main.route("**/api/mats/adopt", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }), { times: 1 });
    await sheet.getByRole("button", { name: "Add these as mats" }).click();
    await expect(sheet.getByRole("alert")).toHaveText("Couldn't add the mats. Try again.");
    expect(await boxes.evaluateAll((els) => els.map((e) => e.getAttribute("aria-checked")))).toEqual(["true", "true"]);
    expect(await matRows()).toEqual([]);
    await sheet.getByRole("button", { name: "Add these as mats" }).click();
    const line = `2 mats added. ${ON[1] + ON[2]} classes are now on a mat. The week is now split by mat.`;
    await expect(sheet.getByTestId("mats-notice")).toHaveText(line);
    adopts.stop();
    expect(adopts.seen).toHaveLength(2); // the failed one and one retry
    // Focus is on the list's heading, so a screen reader starts from what changed.
    expect(await main.evaluate(() => document.activeElement?.textContent)).toBe("Your mats");
    await expect(sheet.getByLabel("Mat 1 name")).toHaveValue("Mat 1");
    await expect(sheet.getByLabel("Mat 2 name")).toHaveValue("Mat 2");
    await closeMats(main);
    await chips(main);
    await expect(weekGrid(main)).toHaveAttribute("data-mats", "true");
    await expect(main.getByTestId("timetable-split-mat")).toHaveAttribute("aria-pressed", "true");
    await expect(main.getByTestId("timetable-split-hint")).toHaveCount(0);
    expect((await matRows()).map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
    expect(await classesOnMats()).toBe(ON[1] + ON[2]);
    // Nothing chose it: the split is worked out from the mats, not saved.
    expect(await storedLayout()).toBeNull();
    return { line, adoptRequests: adopts.seen.length };
  });

  await section("by-mat", "1440 px, scrollbars on show: every chip is under its own mat header and nothing is cut; every day reads Mat 1 then Mat 2; Monday 07:20 is under Mat 2 with Mat 1 empty beside it; every 18:40 class shares a top edge; the week fits and says nothing; at 1366 the box scrolls and the page does not, and with the menu hidden it fits", async () => {
    await size(main, 1440);
    const inv = await gridInvariants(main, { sessions: SESSIONS });
    expect(inv.problems).toEqual([]);
    const heads = {};
    for (const d of daysWithClasses(POSTER)) heads[DAY[d]] = await matHeads(main, DAY[d]);
    expect(Object.values(heads)).toEqual(daysWithClasses(POSTER).map(() => ["Mat 1", "Mat 2"]));
    const lefts = await weekDay(main, "mon").locator("[data-mat-head]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left));
    expect(lefts[0]).toBeLessThan(lefts[1]);
    // A chip under a pinned mat header leaves its place line out, and keeps the mat in its name.
    const solo = MONDAY.find((s) => s.startTime === "07:20");
    const soloChip = weekDay(main, "mon").getByRole("button", { name: `Edit ${chipName(solo, 0)}` });
    await expect(soloChip).toHaveCount(1);
    await expect(soloChip.locator('[data-chip-part="place"]')).toHaveCount(0);
    const where = await main.evaluate(() => {
      const mon = document.querySelector('[data-day="mon"]');
      const [mat1, mat2] = [...mon.querySelectorAll("[data-mat-head]")].map((h) => h.getBoundingClientRect());
      const cells = [...mon.querySelectorAll("[data-cell-key]")].map((c) => ({ r: c.getBoundingClientRect(), time: c.querySelector('[data-chip-part="time"]').textContent }));
      const solo = cells.find((c) => c.time.startsWith("07:20"));
      const beside = cells.filter((c) => c !== solo && c.r.left < mat1.right - 1 && c.r.bottom > solo.r.top + 1 && c.r.top < solo.r.bottom - 1).length;
      const tops = [...document.querySelectorAll("[data-cell-key]")].filter((c) => c.querySelector('[data-chip-part="time"]').textContent.startsWith("18:40")).map((c) => Math.round(c.getBoundingClientRect().top));
      return { underMat2: solo.r.left >= mat2.left - 1 && solo.r.right <= mat2.right + 1, besideInMat1: beside, tops1840: [...new Set(tops)], n1840: tops.length };
    });
    expect(where.underMat2).toBe(true);
    expect(where.besideInMat1).toBe(0);
    expect(where.tops1840).toHaveLength(1);
    expect(where.n1840).toBe(POSTER.rows.filter((r) => r[1] === "18:40").length);
    // Fit.
    await expect.poll(async () => (await noSidewaysScroll(main)).boxScrolls).toBe(false);
    await expect(wider(main)).toHaveText("");
    const fit = { 1440: { ...(await noSidewaysScroll(main)), spare: await spare(main) } };
    expect(fit[1440].ok).toBe(true);
    L.note("by-mat", "pixels to spare at 1440 by mat, scrollbars on show", fit[1440].spare);
    // Today's column: the mat header is told apart from the tinted cell behind it.
    const thu = await main.evaluate(() => {
      const head = document.querySelector('[data-day="thu"] [data-mat-head]');
      return { pill: getComputedStyle(head.querySelector(".pg-mat-pill")).backgroundColor, cell: getComputedStyle(head).backgroundColor };
    });
    expect(thu.pill).not.toBe(thu.cell);
    // The toolbar is still one row at 1440 with the split control and its "(staff week)" label.
    const row = await main.evaluate(() => {
      const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top);
      return { arrows: top('button[aria-label="Previous week"]'), split: top('[data-testid="timetable-split-mat"]'), mats: top('[data-testid="timetable-mats"]'), hide: top('[data-testid="timetable-hide-menu"]') };
    });
    L.note("by-mat", "toolbar tops at 1440 (one row when they agree within a few px)", row);
    expect(Math.max(...Object.values(row)) - Math.min(...Object.values(row))).toBeLessThanOrEqual(8);
    await expect(main.getByText("Split same-time classes (staff week)")).toBeVisible();
    await shot(main, "timetable-mats-by-mat-1440");
    // 1366: the box scrolls sideways, the page does not; with the menu hidden it fits.
    await size(main, 1366);
    await expect(wider(main)).toHaveText("Wider than this window. Scroll sideways, or hide the menu.");
    fit[1366] = await noSidewaysScroll(main);
    expect(fit[1366].boxScrolls).toBe(true);
    expect(fit[1366].ok).toBe(true);
    await shot(main, "timetable-mats-by-mat-1366");
    const hide = main.getByTestId("timetable-hide-menu");
    await hide.click();
    await expect(wider(main)).toHaveText("");
    fit["1366 menu hidden"] = { ...(await noSidewaysScroll(main)), spare: await spare(main) };
    expect(fit["1366 menu hidden"].boxScrolls).toBe(false);
    expect((await gridInvariants(main, { sessions: SESSIONS })).problems).toEqual([]);
    await hide.click();
    return { narrowestChip: inv.narrowestChip, heads, where, fit, today: thu };
  });

  await section("pinned-mats", "1366 px: scrolled to the evening, Mon and its Mat 2 are still at the top of the box and on top; Shift+Tab back through Monday never lands a chip under the two-row header band", async () => {
    await size(main, 1366);
    const pinned = await main.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scroller = document.querySelector('[data-testid="week-scroller"]');
      scroller.scrollTop = scroller.scrollHeight;
      await frame();
      const box = scroller.getBoundingClientRect();
      const hit = (el) => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && el.contains(at); };
      const day = document.querySelector('[data-day-head="mon"]');
      const mat = document.querySelectorAll('[data-day="mon"] [data-mat-head]')[1];
      return { scrollTop: scroller.scrollTop, dayTop: Math.round(day.getBoundingClientRect().top - box.top), matTop: Math.round(mat.getBoundingClientRect().top - box.top), dayOnTop: hit(day), matOnTop: hit(mat), mat: mat.textContent.trim() };
    });
    expect(pinned.scrollTop).toBeGreaterThan(50);
    expect(pinned.dayTop).toBeLessThanOrEqual(2);
    expect(pinned.matTop).toBeGreaterThanOrEqual(43);
    expect(pinned.matTop).toBeLessThanOrEqual(47);
    expect(pinned.dayOnTop).toBe(true);
    expect(pinned.matOnTop).toBe(true);
    expect(pinned.mat).toBe("Mat 2");
    const mon = weekDay(main, "mon");
    const n = MONDAY.length;
    const under = [];
    for (let i = n - 1; i >= 0; i--) {
      if (i < n - 1) await main.keyboard.press("Shift+Tab");
      else await weekChips(mon).last().focus();
      const stop = await main.evaluate(() => {
        const el = document.activeElement;
        const band = Math.max(...[...document.querySelectorAll('[data-day="mon"] [data-mat-head]')].map((h) => h.getBoundingClientRect().bottom));
        return { label: el.getAttribute("aria-label"), clear: el.getBoundingClientRect().top >= band - 1 };
      });
      if (!stop.clear) under.push(stop.label);
    }
    expect(under).toEqual([]);
    await size(main, 1440);
    return { ...pinned, backStops: n };
  });

  const manager = await seedStaff(club, "manager");
  const coach = await seedStaff(club, "coach");
  await section("choice", "the manager presses By time and is told it is saved for the staff week; the owner sees by time after a reload, presses By mat and it is still by mat after a reload; a coach reads 'Split by mat'; a forced server error and then a dropped request each put the old choice back and say so; one retry sends one request", async () => {
    const out = {};
    const mctx = await context(browser, "10.94.8.2", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
    try {
      const page = await mctx.newPage();
      watch(page);
      await staffSignIn(page, club, manager);
      await mctx.clock.setFixedTime(new Date(FROZEN));
      await page.goto("/dashboard/timetable");
      await chips(page);
      await settled(page);
      await page.getByTestId("timetable-split-time").click();
      await expect(page.getByText("Saved. The staff week is now split by time.")).toBeVisible();
      await expect(weekGrid(page)).not.toHaveAttribute("data-mats", "true");
    } finally {
      await mctx.close();
    }
    expect(await storedLayout()).toBe("time");
    await main.reload();
    await chips(main);
    await settled(main);
    await expect(weekGrid(main)).not.toHaveAttribute("data-mats", "true");
    await expect(main.getByTestId("timetable-split-time")).toHaveAttribute("aria-pressed", "true");
    // By time, Mat 1 is still left of Mat 2 and every chip says its mat.
    const pair = await weekChips(weekDay(main, "mon")).evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute("aria-label")));
    expect(pair).toEqual(MONDAY.slice(0, 2).map((s) => `Edit ${chipName(s, 0)}`));
    await main.getByTestId("timetable-split-mat").click();
    await expect(main.getByText("Saved. The staff week is now split by mat.")).toBeVisible();
    await main.reload();
    await chips(main);
    await settled(main);
    await expect(weekGrid(main)).toHaveAttribute("data-mats", "true");
    expect(await storedLayout()).toBe("mat");
    // A coach reads it and changes nothing.
    const cctx = await context(browser, "10.94.8.3", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
    try {
      const page = await cctx.newPage();
      watch(page);
      await staffSignIn(page, club, coach);
      await cctx.clock.setFixedTime(new Date(FROZEN));
      await page.goto("/dashboard/timetable");
      await chips(page);
      await settled(page);
      await expect(page.getByTestId("timetable-split-text")).toHaveText("Split by mat");
      await expect(page.getByTestId("timetable-split-mat")).toHaveCount(0);
      await expect(page.getByTestId("timetable-mats")).toHaveCount(0);
      await expect(weekGrid(page)).toHaveAttribute("data-mats", "true");
      out.coach = await page.getByTestId("timetable-split-text").textContent();
    } finally {
      await cctx.close();
    }
    // Forced failures: the old choice comes back, and the reader is told.
    const saves = count(main, (r) => r.method() === "PATCH" && r.url().endsWith("/api/timetable/layout"));
    await main.route("**/api/timetable/layout", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }), { times: 1 });
    await main.getByTestId("timetable-split-time").click();
    await expect(main.getByText("Couldn't save that. Try again.").first()).toBeVisible();
    await expect(main.getByTestId("timetable-split-mat")).toHaveAttribute("aria-pressed", "true");
    await expect(weekGrid(main)).toHaveAttribute("data-mats", "true");
    await expect(main.getByText("Couldn't save that. Try again.")).toHaveCount(0, { timeout: 15_000 });
    await main.route("**/api/timetable/layout", (r) => r.abort(), { times: 1 });
    await main.getByTestId("timetable-split-time").click();
    await expect(main.getByText("Couldn't save that. Try again.").first()).toBeVisible();
    await expect(main.getByTestId("timetable-split-mat")).toHaveAttribute("aria-pressed", "true");
    expect(await storedLayout()).toBe("mat");
    const before = saves.seen.length;
    await main.getByTestId("timetable-split-time").click();
    await expect(main.getByText("Saved. The staff week is now split by time.")).toBeVisible();
    expect(saves.seen.length - before).toBe(1);
    expect(await storedLayout()).toBe("time");
    // Back to by mat for the steps that follow.
    await main.getByTestId("timetable-split-mat").click();
    await expect(main.getByText("Saved. The staff week is now split by mat.")).toBeVisible();
    saves.stop();
    expect(await storedLayout()).toBe("mat");
    return { ...out, layoutRequests: saves.seen.length };
  });

  await section("mats-edit", `rename Mat 2 and its column and its classes' place follow; move it first and the columns swap, announced; a forced failed rename keeps the text and says so, and Escape drops it; removing it asks first, naming its ${ON[2]} classes, which then sit under No mat with their place line; adding it again puts them back in one press`, async () => {
    let sheet = await openMats(main);
    await sheet.getByLabel("Mat 2 name").fill("Cage");
    await main.keyboard.press("Enter");
    await expect(sheet.getByTestId("mats-saved")).toBeVisible();
    await closeMats(main);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Mat 1", "Cage"]);
    expect((await q(`select distinct location from "Class" c join "Mat" m on m.id = c."matId" where c."tenantId" = $1 and m.name = 'Cage'`, [club.tenantId])).map((r) => r.location)).toEqual(["Cage"]);
    // The class cards under the grid print the place: it is the mat's new name.
    await expect(main.locator('main div[class*="max-w-[72rem]"]').getByText("Cage").first()).toBeVisible();
    // Move it first.
    sheet = await openMats(main);
    await sheet.getByRole("button", { name: "Move Cage up" }).click();
    await expect(sheet.getByTestId("mats-live")).toHaveText("Cage is now 1 of 2");
    expect(await main.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Move Cage up");
    await closeMats(main);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Cage", "Mat 1"]);
    // A failed rename keeps what was typed; Escape then drops it and the sheet stays open.
    sheet = await openMats(main);
    await main.route("**/api/mats/*", (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.fallback()), { times: 1 });
    await sheet.getByLabel("Cage name").fill("Octagon");
    await main.keyboard.press("Enter");
    await expect(sheet.getByRole("alert")).toHaveText("Couldn't save Cage. Try again.");
    await expect(sheet.getByLabel("Cage name")).toHaveValue("Octagon");
    await sheet.getByLabel("Cage name").focus();
    await main.keyboard.press("Escape");
    await expect(sheet.getByLabel("Cage name")).toHaveValue("Cage");
    await expect(sheet).toBeVisible();
    expect((await matRows()).map((m) => m.name)).toEqual(["Cage", "Mat 1"]);
    // Remove it: the dialog says what happens to its classes.
    await sheet.getByRole("button", { name: "Remove Cage" }).click();
    const dialog = main.getByRole("dialog", { name: "Remove Cage?" });
    await expect(dialog).toContainText(`Its ${ON[2]} classes stay on the timetable with no mat.`);
    await dialog.getByRole("button", { name: "Remove mat" }).click();
    await expect(sheet.getByLabel("Cage name")).toHaveCount(0);
    await closeMats(main);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Mat 1", "No mat"]);
    await chips(main);
    const under = await weekDay(main, "mon").locator('[data-cell-key][data-mat=""] button').evaluateAll((els) => els.map((e) => ({ label: e.getAttribute("aria-label"), place: e.querySelector('[data-chip-part="place"]')?.textContent ?? null })));
    expect(under.length).toBe(MONDAY.filter((s) => s.place === "Mat 2").length);
    expect(under.every((c) => c.place === "Cage" && c.label.includes(", Cage"))).toBe(true);
    expect(await classesOnMats()).toBe(ON[1]);
    expect((await q(`select count(*)::int n from "Class" where "tenantId" = $1`, [club.tenantId]))[0].n).toBe(CLASSES.length);
    await shot(main, "timetable-mats-no-mat-column");
    // Add it again: the classes that still say its name go back in one press.
    sheet = await openMats(main);
    await sheet.getByRole("button", { name: "Add a mat" }).click();
    await sheet.getByLabel("New mat name").fill("Cage");
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel("Cage name")).toBeFocused();
    await expect(sheet.getByTestId("mats-stray")).toContainText(`${ON[2]} classes say “Cage” but are not on it.`);
    await sheet.getByRole("button", { name: "Put them on Cage" }).click();
    await expect(sheet.getByTestId("mats-notice")).toHaveText(`${ON[2]} classes are now on Cage.`);
    await closeMats(main);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Mat 1", "Cage"]);
    expect(await classesOnMats()).toBe(ON[1] + ON[2]);
    return { noMatMonday: under.length };
  });

  await section("class-form", `the class form offers a Mat instead of a typed Location; No mat reveals a place box; a forced failed save keeps the chosen mat and one retry saves; with a third mat ("${LONG}") in use on Monday the box scrolls with the gutter and both header rows pinned`, async () => {
    const sheet = await openMats(main);
    await sheet.getByRole("button", { name: "Add a mat" }).click();
    await sheet.getByLabel("New mat name").fill(LONG);
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel(`${LONG} name`)).toHaveValue(LONG);
    await closeMats(main);
    await main.getByRole("button", { name: "Add class", exact: true }).first().click();
    await main.getByLabel("Class Name", { exact: true }).fill("Wrestling");
    await main.getByRole("button", { name: "Add day", exact: true }).click();
    const mat = main.getByLabel("Mat", { exact: true });
    await expect(main.getByLabel("Location", { exact: true })).toHaveCount(0);
    expect(await mat.locator("option").allTextContents()).toEqual(["No mat", "Mat 1", "Cage", LONG]);
    await expect(mat).toHaveValue("");
    await expect(main.getByLabel("Place (not on a mat)")).toBeVisible();
    await mat.selectOption({ label: LONG });
    await expect(main.getByLabel("Place (not on a mat)")).toHaveCount(0);
    const posts = count(main, (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/classes" && !r.url().includes("dryRun"));
    await main.route("**/api/classes", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to create class" }) }) : r.fallback()), { times: 1 });
    await main.getByRole("button", { name: "Create class", exact: true }).click();
    await expect(main.getByRole("dialog").getByRole("alert")).toBeVisible();
    expect(await mat.evaluate((el) => el.selectedOptions[0].textContent)).toBe(LONG);
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Wrestling");
    expect((await q(`select count(*)::int n from "Class" where "tenantId" = $1 and name = 'Wrestling'`, [club.tenantId]))[0].n).toBe(0);
    await main.getByRole("button", { name: "Create class", exact: true }).click();
    await expect(main.getByRole("dialog")).toHaveCount(0);
    posts.stop();
    expect(posts.seen).toHaveLength(2);
    const saved = await q(`select c.location, m.name mat from "Class" c left join "Mat" m on m.id = c."matId" where c."tenantId" = $1 and c.name = 'Wrestling'`, [club.tenantId]);
    expect(saved).toEqual([{ location: LONG, mat: LONG }]);
    await chips(main, SESSIONS + 1);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Mat 1", "Cage", LONG]);
    const inv = await gridInvariants(main, { sessions: SESSIONS + 1 });
    expect(inv.problems).toEqual([]);
    // Wider than a 1440 window now: the box scrolls, the page does not, and the pinned cells stay put.
    const wide = await noSidewaysScroll(main);
    expect(wide.boxScrolls).toBe(true);
    expect(wide.ok).toBe(true);
    const pinned = await main.evaluate(async () => {
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const scroller = document.querySelector('[data-testid="week-scroller"]');
      const tick = document.querySelector(".pg-tick");
      const before = tick.getBoundingClientRect().left;
      scroller.scrollLeft = scroller.scrollWidth;
      scroller.scrollTop = scroller.scrollHeight;
      await frame();
      const box = scroller.getBoundingClientRect();
      const head = document.querySelector('[data-day-head="sat"]').getBoundingClientRect();
      const out = { scrollLeft: scroller.scrollLeft, tickMoved: Math.abs(tick.getBoundingClientRect().left - before), headTop: Math.round(head.top - box.top) };
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
      return out;
    });
    expect(pinned.scrollLeft).toBeGreaterThan(10);
    expect(pinned.tickMoved).toBeLessThanOrEqual(1);
    expect(pinned.headTop).toBeLessThanOrEqual(2);
    await shot(main, "timetable-mats-three-mats-1440");
    return { options: 4, posts: posts.seen.length, pinned, narrowestChip: inv.narrowestChip };
  });

  await section("shared-mat", "classes sharing a mat sit side by side inside its column: two, then three; a fourth gives two and '+2 more', which opens the Day view on that day with the group open and all four names on show", async () => {
    const mat1 = (await matRows()).find((m) => m.name === "Mat 1").id;
    const add = (name) => main.evaluate(async (body) => (await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status,
      { name, matId: mat1, duration: 50, schedules: [{ dayOfWeek: 0, startTime: "18:40", endTime: "19:30" }] });
    const sunday = async (n) => {
      await main.reload();
      await chips(main, SESSIONS + 1 + Math.min(n, n > 3 ? 2 : n));
      await settled(main);
      return main.evaluate(() => {
        const sun = document.querySelector('[data-day="sun"]');
        const head = sun.querySelector("[data-mat-head]").getBoundingClientRect();
        const cells = [...sun.querySelectorAll("[data-cell-key]")].map((c) => c.getBoundingClientRect());
        return {
          heads: [...sun.querySelectorAll("[data-mat-head]")].map((h) => h.textContent.trim()),
          chips: cells.length,
          tops: [...new Set(cells.map((r) => Math.round(r.top)))].length,
          inside: cells.every((r) => r.left >= head.left - 1 && r.right <= head.right + 1),
          disjoint: cells.every((a, i) => cells.every((b, j) => i === j || a.right <= b.left + 1 || b.right <= a.left + 1)),
          more: sun.querySelector('[data-testid="week-more"]')?.getAttribute("aria-label") ?? null,
        };
      });
    };
    const out = {};
    expect(await add("Share A")).toBe(201);
    expect(await add("Share B")).toBe(201);
    out.two = await sunday(2);
    expect(out.two).toEqual({ heads: ["Mat 1"], chips: 2, tops: 1, inside: true, disjoint: true, more: null });
    expect(await add("Share C")).toBe(201);
    out.three = await sunday(3);
    expect(out.three).toEqual({ heads: ["Mat 1"], chips: 3, tops: 1, inside: true, disjoint: true, more: null });
    expect(await add("Share D")).toBe(201);
    out.four = await sunday(4);
    expect(out.four).toMatchObject({ heads: ["Mat 1"], chips: 2, inside: true, disjoint: true, more: "2 more sessions, Sunday 18:40 to 19:30. Open the day." });
    expect((await gridInvariants(main, { sessions: SESSIONS + 5 })).problems).toEqual([]);
    await shot(main, "timetable-mats-shared-mat");
    await weekDay(main, "sun").getByTestId("week-more").click();
    const open = main.getByTestId("day-view").getByTestId("day-grid-cluster-open");
    await expect(open).toBeVisible();
    const names = await open.locator("[data-day-grid-block]").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/^Edit /, "").split(",")[0]));
    expect([...names].sort()).toEqual(["Share A", "Share B", "Share C", "Share D"]);
    for (let i = 0; i < 4; i++) await expect(open.locator("[data-day-grid-block]").nth(i)).toBeVisible();
    await main.getByTestId("timetable-view-week").click();
    return out;
  });

  await section("keyboard", "the Mats sheet by keyboard alone: Enter on the button opens it; a name is saved with Enter; Escape drops an unsaved change and a second Escape closes the sheet with focus back on the Mats button; focus stays with a moved mat, goes to a new mat's name, and to Add a mat after the last is removed", async () => {
    const button = main.getByTestId("timetable-mats");
    await button.focus();
    await main.keyboard.press("Enter");
    const sheet = sheetOf(main);
    await expect(sheet.getByLabel("Mat 1 name")).toBeVisible();
    const field = sheet.getByLabel("Mat 1 name");
    await field.focus();
    await main.keyboard.press("Control+A");
    await main.keyboard.type("Main mat");
    await main.keyboard.press("Enter");
    await expect(sheet.getByTestId("mats-saved")).toBeVisible();
    await expect(sheet.getByLabel("Main mat name")).toHaveValue("Main mat");
    // A change, then Escape: dropped, sheet still open.
    await sheet.getByLabel("Main mat name").focus();
    await main.keyboard.press("Control+A");
    await main.keyboard.type("Half typed");
    await main.keyboard.press("Escape");
    await expect(sheet.getByLabel("Main mat name")).toHaveValue("Main mat");
    await expect(sheet).toBeVisible();
    // Move with the keyboard: focus stays on the button of the mat that moved.
    await sheet.getByRole("button", { name: "Move Main mat down" }).focus();
    await main.keyboard.press("Enter");
    await expect(sheet.getByTestId("mats-live")).toHaveText("Main mat is now 2 of 3");
    await expect(sheet.getByRole("button", { name: "Move Main mat down" })).toBeFocused();
    await sheet.getByRole("button", { name: "Move Main mat up" }).focus();
    await main.keyboard.press("Enter");
    await expect(sheet.getByTestId("mats-live")).toHaveText("Main mat is now 1 of 3");
    // Add: focus lands on the new mat's name. Remove it (the last row): focus lands on Add a mat.
    await sheet.getByRole("button", { name: "Add a mat" }).focus();
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel("New mat name")).toBeFocused();
    await main.keyboard.type("Spare");
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel("Spare name")).toBeFocused();
    await sheet.getByRole("button", { name: "Remove Spare" }).focus();
    await main.keyboard.press("Enter");
    const dialog = main.getByRole("dialog", { name: "Remove Spare?" });
    await expect(dialog).toContainText("No classes use it.");
    await dialog.getByRole("button", { name: "Remove mat" }).focus();
    await main.keyboard.press("Enter");
    await expect(sheet.getByLabel("Spare name")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Add a mat" })).toBeFocused();
    // Escape with nothing to drop closes the sheet and gives focus back to the button that opened it.
    await main.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(button).toBeFocused();
    expect((await matRows()).map((m) => m.name)).toEqual(["Main mat", "Cage", LONG]);
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Main mat", "Cage", LONG]);
    return { mats: (await matRows()).map((m) => m.name) };
  });

  for (const width of [375, 390]) {
    await section(`phone-${width}`, `${width} px on the real clock: the Mats button is on screen and opens a bottom sheet as wide as the screen, with name fields at least 44 px tall and buttons that take a tap 44 px tall; the page does not scroll sideways`, async () => {
      const mobile = await context(browser, `10.94.8.${width === 375 ? 30 : 31}`, { viewport: { width, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState(), timezoneId: "Europe/London" });
      const phone = await mobile.newPage();
      const before = errors.length;
      const wasFrozen = frozen;
      frozen = false;
      phone.on("pageerror", (e) => errors.push(e.message));
      try {
        await phone.goto("/dashboard/timetable");
        const button = phone.getByTestId("timetable-mats-phone");
        await expect(button).toBeVisible();
        await expect(phone.getByTestId("timetable-split")).toBeHidden();
        await button.tap();
        const sheet = sheetOf(phone);
        await expect(sheet.getByLabel("Main mat name")).toBeVisible();
        const m = await phone.evaluate(() => {
          const panel = document.querySelector('[role="dialog"]').getBoundingClientRect();
          const fields = [...document.querySelectorAll('[data-testid="mats-row"] input')].map((e) => Math.round(e.getBoundingClientRect().height));
          // A compact button is 32 px to look at and 44 px to tap: probe just inside the top and bottom of that reach.
          const taps = [...document.querySelectorAll('[data-testid="mats-row"] button')].map((b) => {
            const r = b.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            return [cy - 20, cy + 20].every((y) => b.contains(document.elementFromPoint(cx, y)));
          });
          return { left: Math.round(panel.left), width: Math.round(panel.width), bottom: Math.round(panel.bottom), viewport: [window.innerWidth, window.innerHeight], fields, taps, sideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
        });
        expect(m.left).toBe(0);
        expect(m.width).toBe(m.viewport[0]);
        expect(m.viewport[1] - m.bottom).toBeLessThanOrEqual(1);
        expect(Math.min(...m.fields)).toBeGreaterThanOrEqual(44);
        expect(m.taps.every(Boolean)).toBe(true);
        expect(m.sideways).toBe(false);
        await shot(phone, `timetable-mats-sheet-phone-${width}`);
        await sheet.getByRole("button", { name: "Close" }).tap();
        await expect(sheet).toHaveCount(0);
        expect(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
        expect(errors.slice(before)).toEqual([]);
        return m;
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
  if (main && !main.isClosed()) await shot(main, "timetable-mats-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
