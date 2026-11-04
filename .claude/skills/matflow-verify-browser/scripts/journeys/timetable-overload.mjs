// Timetable overload: a busy day, overlapping sessions, a duplicate (synthetic data only).
//   node run-journeys.mjs timetable-overload
// Seeds the plan's busy-gym Monday (14 sessions, five overlap groups, a staggered trio, a three-way
// clash with one duplicate) and a quiet Tuesday through the app's own create API from the signed-in page,
// then checks the week grid (dense layout, compact chips, groups, duplicate flag, sideways scroll inside
// the week only), keyboard reach into a group, the form's refusal of an identical slot with typed values
// kept, and the phone agenda at 375 px.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

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

const gridDay = (page, day) => page.locator(".grid-cols-7 > div").filter({ has: page.getByText(day, { exact: true }) });
const chips = (loc) => loc.getByRole("button", { name: /^Edit / });
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

  await section("dense", "the week is dense: Monday compact two-line chips with '14 sessions', Tuesday's normal chips, the week scrolls sideways inside its own box only", async () => {
    const grid = main.locator(".grid-cols-7");
    await expect(grid).toHaveAttribute("data-dense", "true");
    const mon = gridDay(main, "Mon");
    const sizes = await chips(mon).evaluateAll((els) => els.map((e) => e.dataset.chipSize ?? "grid"));
    expect(sizes).toEqual(Array(MONDAY).fill("compact"));
    await expect(mon.getByText("14 sessions")).toBeVisible();
    const tue = gridDay(main, "Tue");
    expect(await chips(tue).evaluateAll((els) => els.map((e) => e.dataset.chipSize ?? "grid"))).toEqual(["grid", "grid"]);
    await expect(tue.getByText("2 sessions")).toBeVisible();
    // Every compact chip shows its whole name: no ellipsis on a 180 px column.
    const clipped = await chips(mon).evaluateAll((els) =>
      els.map((e) => [...e.querySelectorAll("span")].filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent)).flat());
    // The week scrolls sideways inside its own box (overflow-x: auto) and nothing
    // else does: at md+ the shell's scrollport is <main>, so measure that, not the
    // document. Checked at the common laptop widths and a wide desktop.
    const measure = () => main.evaluate(() => {
      const box = document.querySelector('[data-testid="week-scroller"]');
      const m = document.querySelector("main");
      return {
        boxOverflowX: box ? getComputedStyle(box).overflowX : null,
        weekScrollsSideways: !!box && box.scrollWidth > box.clientWidth,
        mainScrollsSideways: !!m && m.scrollWidth > m.clientWidth + 1,
        documentScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const scroll = {};
    for (const width of [1280, 1440, 1600]) {
      await main.setViewportSize({ width, height: 900 });
      scroll[width] = await measure();
    }
    await main.setViewportSize({ width: 1280, height: 900 });
    expect(clipped).toEqual([]);
    for (const width of [1280, 1440, 1600]) {
      expect(scroll[width].boxOverflowX).toBe("auto");
      expect(scroll[width].mainScrollsSideways).toBe(false);
      expect(scroll[width].documentScrollsSideways).toBe(false);
    }
    return { sizes: [...new Set(sizes)], scroll };
  });

  await section("groups", "Monday's overlaps sit in five groups labelled by how many run at once; the staggered trio reads 'Up to 2'; chips inside show start–end and mat", async () => {
    const mon = gridDay(main, "Mon");
    const labels = await mon.getByRole("group").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(labels).toEqual([
      "2 at once, 06:30 to 08:00",
      "2 at once, 12:00 to 12:50",
      "Up to 2 at once, 16:30 to 18:30",
      "3 at once, 18:40 to 19:30",
      "2 at once, 19:30 to 21:00",
    ]);
    const trio = mon.getByRole("group").nth(2);
    const rows = await chips(trio).allTextContents();
    expect(rows[0]).toContain("16:30–17:15");
    expect(rows[0]).toContain("Mat 1");
    expect(rows[2]).toContain("17:30–18:30");
    const outside = await chips(mon).evaluateAll((els) => els.filter((e) => !e.closest('[role="group"]')).map((e) => e.getAttribute("aria-label")));
    expect(outside.map(stripped)).toEqual(["Edit Open Mat", "Edit Comp Team"]);
    return { labels, outside };
  });

  await section("duplicate", "the two 'Beginners Course Gi' at 18:40 on Mat 1 are flagged 'Duplicate?'; the Mat 2 one is not; all three stay on the grid and each opens its own class", async () => {
    const clash = gridDay(main, "Mon").getByRole("group").nth(3);
    const labels = (await chips(clash).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => l.replace(/ \((?:live|next|ended|cancelled)\)/, ""));
    // Same name and start sort by place, so the two Mat 1 entries sit together.
    expect(labels).toEqual(["Edit Beginners Course Gi (possible duplicate)", "Edit Beginners Course Gi (possible duplicate)", "Edit Beginners Course Gi"]);
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

  await section("phone", "375 x 812: Monday's agenda lists 14 rows in five groups with mat labels, picker reads 14, no sideways scroll, rows ≥ 44 px", async () => {
    const mobile = await context(browser, "10.94.4.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      const rows = chips(agenda);
      await expect(rows).toHaveCount(MONDAY);
      const groups = await agenda.getByRole("group").count();
      const counts = await phone.getByRole("tab").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[2]?.textContent));
      const clashTexts = await chips(agenda.getByRole("group").nth(3)).allTextContents();
      const heights = [];
      for (let i = 0; i < MONDAY; i++) { const b = await rows.nth(i).boundingBox(); heights.push(b ? Math.round(b.height) : 0); }
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-overload-phone");
      expect(groups).toBe(5);
      expect(counts).toEqual(["14", "2", "—", "—", "—", "—", "—"]);
      expect(clashTexts[0]).toContain("18:40–19:30");
      expect(clashTexts[0]).toContain("Duplicate?");
      expect(clashTexts[1]).toContain("Duplicate?");
      expect(clashTexts[2]).toContain("Mat 2");
      expect(noSideScroll).toBe(true);
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
      return { groups, counts, minRowHeight: Math.min(...heights), noSideScroll };
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
