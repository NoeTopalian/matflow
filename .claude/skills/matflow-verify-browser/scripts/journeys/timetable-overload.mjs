// Timetable overload: a busy day, overlapping sessions, a duplicate (synthetic data only).
//   node run-journeys.mjs timetable-overload
// Seeds the plan's busy-gym Monday (14 sessions, five overlap groups, a staggered trio, a three-way
// clash with one duplicate) and a quiet Tuesday through the app's own create API from the signed-in page,
// then checks the week grid (overlapping sessions side by side in lanes, nothing cut, the duplicate flag, no
// sideways scroll of the page), keyboard reach in time order, the form's refusal of an identical slot with typed
// values kept, and the phone's day (the same grid for one day) at 375 px.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, weekDay, gridInvariants, noSidewaysScroll } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-overload");
const errors = [];

const SEED = [
  ["Beginners Course Gi", "Mat 1", [[1, "06:30", "07:20"], [1, "12:00", "12:50"], [1, "18:40", "19:30"], [2, "17:50", "18:40"]]],
  ["Morning No-Gi", "Mat 2", [[1, "07:00", "08:00"]]],
  ["Open Mat", null, [[1, "09:30", "11:00"]]],
  ["Lunch No-Gi", "Mat 2", [[1, "12:00", "12:50"]]],
  ["Little Champs", "Mat 1", [[1, "16:30", "17:15"]]],
  ["Kids BJJ", "Mat 2", [[1, "17:00", "17:45"]]],
  ["Teens", "Mat 1", [[1, "17:30", "18:30"]]],
  ["Beginners Course Gi", "Mat 2", [[1, "18:40", "19:30"]]],
  ["Beginners Course Gi", "Mat 1", [[1, "18:40", "19:30"]]],
  ["Advanced Gi Comp Class", "Mat 1", [[1, "19:30", "21:00"], [2, "19:00", "20:30"]]],
  ["No-Gi All Levels", "Mat 2", [[1, "19:30", "20:30"]]],
  ["Comp Team", null, [[1, "21:00", "22:00"]]],
];
const MONDAY = SEED.flatMap(([, , slots]) => slots.filter(([d]) => d === 1)).length; // 14
const TUESDAY = SEED.flatMap(([, , slots]) => slots.filter(([d]) => d === 2)).length; // 2

const gridDay = (page, day) => weekDay(page, day.toLowerCase());
const chips = (loc) => loc.getByRole("button", { name: /^Edit / });
// Monday's sessions in the order the grid places them (start, then the longer, then the place), with the lane each
// takes: a pair, a class alone, a pair, the staggered trio (two lanes, the first reused), three at once, a pair, alone.
const MONDAY_LANES = [0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 0, 1, 0];
const stripped = (l) => l?.replace(/ \((?:live|next|ended|cancelled)\)/, "").replace(/ \(possible duplicate\)$/, "");
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-overload-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
let main;
try {
  const ctx = await context(browser, "10.94.4.1", { viewport: { width: 1280, height: 900 } });
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `the busy-gym week is created through the app's create API: ${MONDAY} Monday sessions, ${TUESDAY} on Tuesday`, async () => {
    const statuses = [];
    for (const [name, location, slots] of SEED) {
      const status = await main.evaluate(async (body) => {
        const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return r.status;
      }, { name, location, duration: 60, schedules: slots.map(([dayOfWeek, startTime, endTime]) => ({ dayOfWeek, startTime, endTime })) });
      statuses.push(status);
    }
    expect(statuses.every((s) => s === 201)).toBe(true);
    const rows = await q(`select count(*)::int n from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1 and s."isActive" = true`, [club.tenantId]);
    expect(rows[0].n).toBe(MONDAY + TUESDAY);
    await main.reload();
    await expect(chips(gridDay(main, "Mon"))).toHaveCount(MONDAY, { timeout: 20_000 });
    return { created: statuses.length, slots: rows[0].n };
  });

  await section("grid", "the busy Monday is all on the grid: 14 sessions counted in its header, nothing cut, overlapping or shorter than 44 px; at 1280, 1440 and 1600 neither the page nor the week scrolls sideways", async () => {
    const mon = gridDay(main, "Mon");
    await expect(mon).toHaveAccessibleName(new RegExp(`^Monday \\d+ [A-Z][a-z]+, ${MONDAY} sessions(, today)?$`));
    await expect(mon.locator("[data-day-head]")).toContainText(`${MONDAY} sessions`);
    await expect(gridDay(main, "Tue").locator("[data-day-head]")).toContainText(`${TUESDAY} sessions`);
    // At md+ the shell's scrollport is <main>, so that is measured, not only the document.
    const scroll = {};
    for (const width of [1280, 1440, 1600]) {
      await main.setViewportSize({ width, height: 900 });
      const inv = await gridInvariants(main, { sessions: MONDAY + TUESDAY });
      expect(inv.problems).toEqual([]);
      scroll[width] = { ...(await noSidewaysScroll(main)), narrowestChip: inv.narrowestChip };
      expect(scroll[width].ok).toBe(true);
      expect(scroll[width].boxScrolls).toBe(false);
    }
    await main.setViewportSize({ width: 1280, height: 900 });
    return { scroll };
  });

  await section("lanes", "Monday's overlaps sit side by side: pairs in two lanes on one top edge, the staggered trio in two lanes with the first reused, three at once in three; a class alone is as wide as the day; no bracket groups; chips show start–end and the place", async () => {
    const mon = gridDay(main, "Mon");
    const cells = await mon.locator("[data-cell-key]").evaluateAll((els) => els.map((c) => {
      const r = c.getBoundingClientRect();
      return { lane: Number(c.dataset.lane), start: c.querySelector('[data-chip-part="time"]').textContent.slice(0, 5), text: c.textContent, label: c.querySelector("button").getAttribute("aria-label"), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) };
    }));
    expect(cells.map((c) => c.lane)).toEqual(MONDAY_LANES);
    const at = (start) => cells.filter((c) => c.start === start);
    for (const start of ["12:00", "18:40", "19:30"]) {
      expect(new Set(at(start).map((c) => c.top)).size).toBe(1);
      expect(new Set(at(start).map((c) => c.left)).size).toBe(at(start).length);
    }
    expect(at("18:40")).toHaveLength(3);
    const [champs, kids, teens] = [at("16:30")[0], at("17:00")[0], at("17:30")[0]];
    expect(Math.abs(champs.left - teens.left)).toBeLessThanOrEqual(1);
    expect(kids.left).toBeGreaterThan(champs.left + champs.width - 2);
    expect(champs.text).toContain("16:30–17:15");
    expect(champs.text).toContain("Mat 1");
    expect(teens.text).toContain("17:30–18:30");
    const head = await mon.locator("[data-day-head]").boundingBox();
    const alone = cells.filter((c) => /^Edit (Open Mat|Comp Team),/.test(c.label));
    expect(alone.map((c) => stripped(c.label))).toEqual(["Edit Open Mat, Monday 09:30 to 11:00", "Edit Comp Team, Monday 21:00 to 22:00"]);
    for (const c of alone) expect(head.width - c.width).toBeLessThanOrEqual(4);
    await expect(mon.getByRole("group")).toHaveCount(0);
    return { lanes: cells.map((c) => c.lane), dayWidth: Math.round(head.width), aloneWidths: alone.map((c) => c.width), pairWidths: at("12:00").map((c) => c.width), trioWidths: at("18:40").map((c) => c.width) };
  });

  await section("duplicate", "the two 'Beginners Course Gi' at 18:40 on Mat 1 are flagged 'Duplicate?'; the Mat 2 one is not; all three stay on the grid and each opens its own class", async () => {
    const clash = gridDay(main, "Mon").locator("[data-cell-key]").filter({ has: main.locator('[data-chip-part="time"]', { hasText: "18:40–" }) });
    await expect(clash).toHaveCount(3);
    const labels = (await chips(clash).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => l.replace(/ \((?:live|next|ended|cancelled)\)/, ""));
    // Same name and start sort by place, so the two Mat 1 entries sit together.
    expect(labels).toEqual([
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1 (possible duplicate)",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 1 (possible duplicate)",
      "Edit Beginners Course Gi, Monday 18:40 to 19:30, Mat 2",
    ]);
    await expect(clash.getByText("Duplicate?")).toHaveCount(2);
    const ids = [];
    for (let i = 0; i < 3; i++) {
      await chips(clash).nth(i).click();
      await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Beginners Course Gi");
      ids.push(await main.getByLabel("Day of the week").count());
      await main.keyboard.press("Escape");
      await expect(main.getByRole("dialog")).toHaveCount(0);
    }
    // Three distinct classes: one with four days, two with one (the Mat 1 pair's order within itself is by id).
    expect([...ids].sort()).toEqual([1, 1, 4]);
    expect(ids[2]).toBe(1); // the Mat 2 class is last
    return { labels, dayRowsPerClass: ids };
  });

  await section("keyboard", "Tab walks every Monday chip in time order, into and out of groups; Enter opens the class", async () => {
    const mon = gridDay(main, "Mon");
    await chips(mon).first().focus();
    const seen = [];
    for (let i = 0; i < MONDAY; i++) {
      seen.push(await main.evaluate(() => document.activeElement?.textContent?.match(/\d\d:\d\d/)?.[0] ?? null));
      if (i < MONDAY - 1) await main.keyboard.press("Tab");
    }
    const expected = SEED.flatMap(([name, , slots]) => slots.filter(([d]) => d === 1).map(([, s]) => [s, name])).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([s]) => s);
    expect(seen).toEqual(expected);
    await main.keyboard.press("Enter");
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Comp Team");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return { tabStops: seen.length };
  });

  await section("form-refusal", "the same day and start twice in one class is refused with the typed values kept; changing the day clears it; Escape saves nothing", async () => {
    await main.getByRole("button", { name: "Add class", exact: true }).first().click();
    await main.getByLabel("Class Name", { exact: true }).fill("Wrestling");
    await main.getByRole("button", { name: "Add day", exact: true }).click();
    await main.getByRole("button", { name: "Add day", exact: true }).click();
    await expect(main.getByText(/Monday 18:00 is already in this class/)).toBeVisible();
    await expect(main.getByRole("button", { name: "Create class", exact: true })).toBeDisabled();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Wrestling");
    await main.getByLabel("Day of the week").nth(1).selectOption("2");
    await expect(main.getByText(/already in this class/)).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Create class", exact: true })).toBeEnabled();
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    const rows = await q(`select count(*)::int n from "Class" where "tenantId" = $1 and name = 'Wrestling'`, [club.tenantId]);
    expect(rows[0].n).toBe(0);
    return { wrestlingSaved: rows[0].n };
  });

  await shot(main, "timetable-overload-desktop");

  await section("phone", "375 x 812: the phone's Monday is the poster grid: 14 chips, the 18:40 clash side by side on one top edge with its places and the duplicate flag, picker reads 14, nothing cut, no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.4.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      const rows = chips(agenda);
      await expect(rows).toHaveCount(MONDAY);
      const counts = await phone.getByRole("tab").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[2]?.textContent));
      const clash = agenda.locator("[data-cell-key]").filter({ hasText: /^18:40–/ });
      const clashTexts = await clash.allTextContents();
      const clashTops = await clash.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      const inv = await gridInvariants(phone, { sessions: MONDAY, grid: "phone-day-grid" });
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-overload-phone");
      expect(counts).toEqual(["14", "2", "—", "—", "—", "—", "—"]);
      expect(clashTexts).toHaveLength(3);
      expect(new Set(clashTops).size).toBe(1);
      expect(clashTexts[0]).toContain("Mat 1");
      expect(clashTexts[0]).toContain("Duplicate?");
      expect(clashTexts[1]).toContain("Duplicate?");
      expect(clashTexts[2]).toContain("Mat 2");
      expect(clashTexts[2]).not.toContain("Duplicate?");
      expect(inv.problems).toEqual([]);
      expect(noSideScroll).toBe(true);
      return { counts, narrowestChip: inv.narrowestChip, shortestChip: inv.shortestChip, noSideScroll };
    } catch (e) {
      await shot(phone, "timetable-overload-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-overload-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
