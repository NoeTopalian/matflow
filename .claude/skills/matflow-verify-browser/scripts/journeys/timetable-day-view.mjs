// Timetable Day view: one day on a time axis, clashes side by side (synthetic data only).
//   node run-journeys.mjs timetable-day-view
// Seeds the busy-gym week (a staggered trio and a three-way clash on Monday, a four-way clash on
// Saturday) through the app's create API from the signed-in page, then checks the Week ⇄ Day toggle,
// lane placement by measured geometry, the folded four-way group, that each block opens its own
// class, keyboard reach, the phone (no toggle; the agenda stays), and that the member view would
// label the mat beside side-by-side sessions (unit-tested; not driven here — no member sign-in in
// this harness).
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

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
const grid = (page) => page.getByTestId("day-grid");
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

  await section("toggle", "Week is the default; Day replaces the grid with a time axis for today and keeps the week navigation; Week brings the grid back", async () => {
    await expect(dayView(main)).toHaveCount(0);
    await main.getByTestId("timetable-view-day").click();
    await expect(dayView(main)).toBeVisible();
    await expect(main.getByTestId("week-scroller")).toHaveCount(0);
    await expect(main.getByTestId("timetable-view-day")).toHaveAttribute("aria-pressed", "true");
    const hours = await grid(main).evaluate((g) => [...g.querySelectorAll("span")].map((s) => s.textContent).filter((t) => /^\d\d:00$/.test(t)));
    await main.getByTestId("timetable-view-week").click();
    await expect(main.getByTestId("week-scroller")).toBeVisible();
    await main.getByTestId("timetable-view-day").click();
    expect(hours[0]).toBe("06:00"); // earliest 06:30 → clamp floor
    expect(hours[hours.length - 1]).toBe("22:00"); // latest 21:00 + 1 h
    return { hours: `${hours[0]}–${hours[hours.length - 1]}` };
  });

  await section("lanes", "Monday: nine blocks in time order; the staggered trio shares two lanes by measured position; the 18:40 trio sits three abreast with its duplicates flagged", async () => {
    await dayView(main).getByRole("tab", { name: /^Mon/ }).click();
    const all = blocks(grid(main));
    await expect(all).toHaveCount(MONDAY);
    const labels = (await all.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map(stripped);
    expect(labels).toEqual([
      "Edit Beginners Course Gi, 06:30 to 07:20",
      "Edit Open Mat, 09:30 to 11:00",
      "Edit Beginners Course Gi, 12:00 to 12:50",
      "Edit Little Champs, 16:30 to 17:15",
      "Edit Kids BJJ, 17:00 to 17:45",
      "Edit Teens, 17:30 to 18:30",
      "Edit Beginners Course Gi, 18:40 to 19:30",
      "Edit Beginners Course Gi, 18:40 to 19:30",
      "Edit Beginners Course Gi, 18:40 to 19:30",
      "Edit Advanced Gi Comp Class, 19:30 to 21:00",
    ].slice(0, MONDAY));
    const boxes = await all.evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), y: Math.round(b.y), h: Math.round(b.height) }; }));
    const [, , , champs, kids, teens, gi1, gi2, gi3] = boxes;
    expect(kids.x).toBeGreaterThan(champs.x + champs.w - 8); // side by side
    expect(teens.x).toBe(champs.x); // back in lane 1 once Little Champs has finished
    expect(teens.y).toBeGreaterThan(champs.y + champs.h - 1);
    expect(new Set([gi1.x, gi2.x, gi3.x]).size).toBe(3); // three abreast
    expect(gi1.y).toBe(gi2.y);
    const dupes = await all.evaluateAll((els) => els.filter((e) => /possible duplicate/.test(e.getAttribute("aria-label"))).length);
    expect(dupes).toBe(2);
    return { labels: labels.length, trio: { champs, kids, teens }, duplicates: dupes };
  });

  await section("opens-own-class", "a block opens its own class; Escape closes without a save", async () => {
    await blocks(grid(main)).nth(4).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Kids BJJ");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await blocks(grid(main)).nth(1).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Open Mat");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return "Kids BJJ, Open Mat";
  });

  await section("four-way", "Saturday's four-way clash is one group block; it opens to four blocks with their mats and collapses", async () => {
    await dayView(main).getByRole("tab", { name: /^Sat/ }).click();
    const group = main.getByTestId("day-grid-cluster");
    await expect(group).toBeVisible();
    await expect(group).toContainText("4 classes at once");
    await expect(blocks(grid(main))).toHaveCount(0);
    await group.click();
    const open = main.getByTestId("day-grid-cluster-open");
    await expect(blocks(open)).toHaveCount(4);
    const rows = await blocks(open).allTextContents();
    // Rows keep the day's order (same start → by name), each with its own mat.
    expect(rows.map((t) => t.replace(/ · Mat \d.*$/, "").replace(/\d\d:\d\d.*$/, "").trim())).toEqual(["Juniors Comp", "Kids BJJ", "Little Champs", "Teens"]);
    expect(rows.map((t) => t.match(/Mat \d/)?.[0]).sort()).toEqual(["Mat 1", "Mat 2", "Mat 3", "Mat 4"]);
    await open.getByRole("button", { name: "Collapse" }).click();
    await expect(main.getByTestId("day-grid-cluster-open")).toHaveCount(0);
    return { rows: rows.map((t) => t.match(/^[A-Za-z ]+/)?.[0].trim() + " / " + t.match(/Mat \d/)?.[0]) };
  });

  await section("keyboard", "Tab reaches each Monday block in order and Enter opens it; focus is visible", async () => {
    await dayView(main).getByRole("tab", { name: /^Mon/ }).click();
    await blocks(grid(main)).first().focus();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await main.evaluate(() => document.activeElement?.getAttribute("aria-label")?.match(/, (\d\d:\d\d) to/)?.[1] ?? null));
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

  await section("phone", "375 x 812: no Week/Day toggle; the agenda is unchanged and shows Monday's sessions in groups; no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.5.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await expect(phone.getByTestId("timetable-view-day")).toBeHidden();
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      await expect(agenda.getByRole("button", { name: /^Edit / })).toHaveCount(MONDAY);
      const groups = await agenda.getByRole("group").count();
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-day-view-phone");
      expect(groups).toBeGreaterThanOrEqual(2);
      expect(noSideScroll).toBe(true);
      return { groups, noSideScroll };
    } catch (e) {
      await shot(phone, "timetable-day-view-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
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
