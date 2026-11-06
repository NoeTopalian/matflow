// Timetable Day view: one day as the poster grid, on a desktop as on a phone (synthetic data only).
//   node run-journeys.mjs timetable-day-view
// Seeds the busy-gym week (a staggered trio and a three-way clash on Monday, a four-way clash on
// Saturday) through the app's create API from the signed-in page, then checks the Week ⇄ Day toggle,
// that the day starts at its first class and says its gaps in words, placement by measured geometry,
// the four-way clash behind "+2 more", that each chip opens its own class, keyboard reach, and the
// phone (no toggle; the same day).
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, gridInvariants } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-day-view");
const errors = [];

const SEED = [
  ["Beginners Course Gi", "Mat 1", [[1, "06:30", "07:20"], [1, "12:00", "12:50"], [1, "18:40", "19:30"], [2, "17:50", "18:40"]]],
  ["Open Mat", null, [[1, "09:30", "11:00"]]],
  ["Little Champs", "Mat 1", [[1, "16:30", "17:15"], [6, "10:00", "10:45"]]],
  ["Kids BJJ", "Mat 2", [[1, "17:00", "17:45"], [6, "10:00", "10:45"]]],
  ["Teens", "Mat 3", [[1, "17:30", "18:30"], [6, "10:00", "10:45"]]],
  ["Juniors Comp", "Mat 4", [[6, "10:00", "10:45"]]],
  ["Beginners Course Gi", "Mat 2", [[1, "18:40", "19:30"]]],
  ["Beginners Course Gi", "Mat 1", [[1, "18:40", "19:30"]]],
  ["Advanced Gi Comp Class", "Mat 1", [[1, "19:30", "21:00"]]],
];
const MONDAY = SEED.flatMap(([, , s]) => s.filter(([d]) => d === 1)).length; // 10

const dayView = (page) => page.getByTestId("day-view");
const grid = (page) => dayView(page).getByTestId("phone-day-grid");
const dayTab = (page, name) => dayView(page).getByRole("tab", { name });
const blocks = (loc) => loc.getByRole("button", { name: /^Edit / });
const stripped = (l) => l?.replace(/ \((?:live|next|ended|cancelled)\)/, "").replace(/ \(possible duplicate\)$/, "");
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-day-view-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
let main;
try {
  const ctx = await context(browser, "10.94.5.1", { viewport: { width: 1280, height: 900 } });
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the busy week is created through the app's create API (${MONDAY} Monday sessions, a four-way Saturday clash)`, async () => {
    const statuses = [];
    for (const [name, location, slots] of SEED) {
      statuses.push(await main.evaluate(async (body) => {
        const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return r.status;
      }, { name, location, duration: 60, schedules: slots.map(([dayOfWeek, startTime, endTime]) => ({ dayOfWeek, startTime, endTime })) }));
    }
    expect(statuses.every((s) => s === 201)).toBe(true);
    await main.reload();
    await expect(main.getByTestId("week-scroller")).toBeVisible({ timeout: 20_000 });
    return { created: statuses.length };
  });

  await section("toggle", "Week is the default; Day replaces the week with one day and keeps the week navigation; Monday starts at its first class (06:30, not an empty 06:00) and says its gaps; Week brings the grid back", async () => {
    await expect(dayView(main)).toHaveCount(0);
    // A press before the page has hydrated is lost on the slow test link: press until it takes.
    await expect(async () => {
      await main.getByTestId("timetable-view-day").click();
      await expect(main.getByTestId("timetable-view-day")).toHaveAttribute("aria-pressed", "true", { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(dayView(main)).toBeVisible();
    await expect(main.getByTestId("week-scroller")).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Previous week" })).toBeVisible();
    await expect(main.getByRole("button", { name: "Next week" })).toBeVisible();
    await dayTab(main, /^Monday/).click();
    await expect(grid(main)).toHaveAttribute("data-day", "mon");
    const ticks = await grid(main).locator(".pg-tick").allTextContents();
    const gaps = await grid(main).locator(".pg-break > span").allTextContents();
    await main.getByTestId("timetable-view-week").click();
    await expect(main.getByTestId("week-scroller")).toBeVisible();
    await main.getByTestId("timetable-view-day").click();
    expect(ticks[0]).toBe("06:30");
    expect(ticks).not.toContain("06:00");
    expect(gaps).toContain("No classes 07:20 to 09:30");
    return { firstTime: ticks[0], gaps };
  });

  await section("lanes", `Monday: ${MONDAY} chips, nothing cut or overlapping; the staggered trio shares two lanes by measured position; the 18:40 trio sits three abreast with its duplicates flagged; the card stops at a readable width`, async () => {
    await dayTab(main, /^Monday/).click();
    const all = blocks(grid(main));
    await expect(all).toHaveCount(MONDAY);
    const inv = await gridInvariants(main, { sessions: MONDAY, grid: "phone-day-grid", within: '[data-testid="day-view"]' });
    expect(inv.problems).toEqual([]);
    const labels = (await all.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map(stripped);
    expect([...labels].sort()).toEqual([
      "Edit Advanced Gi Comp Class, Monday 19:30 to 21:00, Mat 1",
      "Edit Beginners Course Gi, Monday 06:30 to 07:20, Mat 1",
      "Edit Beginners Course Gi, Monday 12:00 to 12:50, Mat 1",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 2",
      "Edit Kids BJJ, Monday 17:00 to 17:45, Mat 2",
      "Edit Little Champs, Monday 16:30 to 17:15, Mat 1",
      "Edit Open Mat, Monday 09:30 to 11:00",
      "Edit Teens, Monday 17:30 to 18:30, Mat 3",
    ]);
    const boxOf = (re) => blocks(grid(main)).filter({ hasText: re }).evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), y: Math.round(b.y), h: Math.round(b.height) }; }));
    const [champs] = await boxOf(/Little Champs/), [kids] = await boxOf(/Kids BJJ/), [teens] = await boxOf(/Teens/);
    const trio = await boxOf(/18:40/);
    expect(kids.x).toBeGreaterThan(champs.x + champs.w - 8); // side by side
    expect(teens.x).toBe(champs.x); // back in lane 1 once Little Champs has finished
    expect(teens.y).toBeGreaterThan(champs.y + champs.h - 1);
    expect(trio).toHaveLength(3);
    expect(new Set(trio.map((b) => b.x)).size).toBe(3); // three abreast
    expect(new Set(trio.map((b) => b.y)).size).toBe(1);
    const dupes = await all.evaluateAll((els) => els.filter((e) => /possible duplicate/.test(e.getAttribute("aria-label"))).length);
    expect(dupes).toBe(2);
    const card = await dayView(main).getByTestId("phone-day").evaluate((el) => Math.round(el.getBoundingClientRect().width));
    // Three lanes at about 300 px each, never the whole window.
    expect(card).toBeLessThanOrEqual(961);
    return { labels: labels.length, trio: { champs, kids, teens }, duplicates: dupes, cardWidth: card };
  });

  await section("opens-own-class", "a chip opens its own class; Escape closes without a save", async () => {
    await blocks(grid(main)).filter({ hasText: /Kids BJJ/ }).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Kids BJJ");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await blocks(grid(main)).filter({ hasText: /Open Mat/ }).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Open Mat");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return "Kids BJJ, Open Mat";
  });

  await section("four-way", "Saturday's four-way clash is two chips and '+2 more'; from the keyboard it lists all four with their mats over the grid, and Escape gives focus back", async () => {
    await dayTab(main, /^Saturday/).click();
    await expect(blocks(grid(main))).toHaveCount(2);
    const more = grid(main).getByTestId("week-more");
    await expect(more).toHaveAttribute("aria-label", "2 more sessions, 10:00 to 10:45. Show them.");
    await more.focus();
    await main.keyboard.press("Enter");
    const panel = grid(main).getByTestId("more-panel");
    const rows = panel.getByTestId("more-row");
    await expect(rows).toHaveCount(4);
    expect(await main.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("more-row");
    const names = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(names.map((n) => n.replace(/^Edit /, "").split(",")[0]).sort()).toEqual(["Juniors Comp", "Kids BJJ", "Little Champs", "Teens"]);
    expect(names.map((n) => n.match(/Mat \d/)?.[0]).sort()).toEqual(["Mat 1", "Mat 2", "Mat 3", "Mat 4"]);
    await main.keyboard.press("Escape");
    await expect(grid(main).getByTestId("more-panel")).toHaveCount(0);
    expect(await main.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("week-more");
    return { rows: names.map((n) => n.replace(/^Edit /, "")) };
  });

  await section("keyboard", "Tab reaches each Monday chip in time order and Enter opens it; focus is visible", async () => {
    await dayTab(main, /^Monday/).click();
    await blocks(grid(main)).first().focus();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await main.evaluate(() => document.activeElement?.getAttribute("aria-label")?.match(/ (\d\d:\d\d) to/)?.[1] ?? null));
      if (i < 3) await main.keyboard.press("Tab");
    }
    const ring = await main.evaluate(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, shadow: s.boxShadow }; });
    await main.keyboard.press("Enter");
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Little Champs");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    expect(seen).toEqual(["06:30", "09:30", "12:00", "16:30"]);
    expect(ring.outline !== "none" || (ring.shadow && ring.shadow !== "none")).toBe(true);
    return { order: seen, focusRing: ring };
  });

  await shot(main, "timetable-day-view-desktop");

  await section("phone", "375 x 812: no Week/Day toggle; the phone's Monday is the same one-day poster grid with every session on it; no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.5.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await expect(phone.getByTestId("timetable-view-day")).toBeHidden();
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      const grid = agenda.getByTestId("phone-day-grid");
      await expect(grid).toHaveAttribute("data-day", "mon");
      // Every session is a chip on the grid, or counted behind a "+N more".
      const inv = await gridInvariants(phone, { sessions: MONDAY, grid: "phone-day-grid" });
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-day-view-phone");
      expect(inv.problems).toEqual([]);
      expect(noSideScroll).toBe(true);
      return { chips: inv.chips, folded: inv.folded, noSideScroll };
    } catch (e) {
      await shot(phone, "timetable-day-view-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
  });

  await section("by-mat-sets-up", "with no mats yet, By mat says what it will do and names the typed places; pressing it opens the set-up with the four places ticked; adding them splits the club by mat (saved), closes the sheet and says so; Monday then has a column per mat", async () => {
    await main.getByTestId("timetable-view-week").click();
    await expect(main.getByTestId("week-scroller")).toBeVisible();
    await expect(main.getByTestId("timetable-split-hint")).toHaveText(/^By mat gives each mat its own column\. Press it to set up your mats: your classes say .+ and 2 more\.$/);
    await main.getByTestId("timetable-split-mat").click();
    const sheet = main.getByRole("dialog");
    // The sheet reads the mats and the typed places first: slow on the test link.
    await expect(sheet.getByRole("checkbox")).toHaveCount(4, { timeout: 45_000 });
    await sheet.getByRole("button", { name: "Add these as mats" }).click();
    await expect(main.getByText("Your timetable is now split by mat. Saved for the whole club.")).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expect(main.getByTestId("week-grid")).toHaveAttribute("data-mats", "true", { timeout: 30_000 });
    await expect(main.getByTestId("timetable-split-mat")).toHaveAttribute("aria-pressed", "true");
    const stored = (await q(`select "timetableLayout" v from "Tenant" where id = $1`, [club.tenantId]))[0].v;
    expect(stored).toBe("mat");
    const heads = (await main.locator('[data-testid="week-grid"] [data-day="mon"] [data-mat-head]').allTextContents()).map((h) => h.trim());
    expect(heads.filter((h) => /^Mat \d$/.test(h)).sort()).toEqual(["Mat 1", "Mat 2", "Mat 3", "Mat 4"]);
    await shot(main, "timetable-day-view-by-mat-after-set-up");
    return { stored, mondayColumns: heads };
  });

  await section("database", "exactly the seeded sessions are stored", async () => {
    const rows = await q(`select count(*)::int n from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1 and s."isActive" = true`, [club.tenantId]);
    expect(rows[0].n).toBe(SEED.flatMap(([, , s]) => s).length);
    return rows[0];
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-day-view-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
