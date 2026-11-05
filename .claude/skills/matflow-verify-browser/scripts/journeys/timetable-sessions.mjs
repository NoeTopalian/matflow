// Timetable: a class that runs several times on one day shows every session (synthetic data only).
//   node run-journeys.mjs timetable-sessions
// Sean's shape: Beginners Gi on Mon 06:30 / 12:00 / 18:40, Tue 17:50, Wed 06:30, Sat 11:20, plus a
// second class interleaved on Monday. The week grid and the phone agenda show one chip per session
// in time order; each chip opens its own class; a failed save keeps the form and saves nothing;
// the retry sends one request; the class card's pill row reads chronologically after a reload.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-sessions");
const errors = [];
const DAY = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 0: "Sun" };

const gridDay = (page, day) => page.locator(".grid-cols-7 > div").filter({ has: page.getByText(day, { exact: true }) });
// On today's column a chip's name carries its state: "Edit Gi (live)". Match the class, whatever the day.
const chipName = (name) => new RegExp(`^Edit ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( \\([a-z]+\\))?$`);
const chips = (page, day, name) => gridDay(page, day).getByRole("button", { name: chipName(name) });
const allChips = (page, day) => gridDay(page, day).getByRole("button", { name: /^Edit / });
const times = async (loc) => (await loc.allTextContents()).map((t) => t.match(/\d\d:\d\d/)?.[0]);
const labels = async (loc) => (await loc.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).map((l) => l?.replace(/ \([a-z]+\)$/, ""));
const slots = async (classId) =>
  q(`select "dayOfWeek", "startTime" from "ClassSchedule" where "classId" = $1 and "isActive" = true order by "dayOfWeek", "startTime"`, [classId]);
const isPatch = (id) => (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${id}` && !r.url().includes("dryRun");

// rows: [day, start] in the order they are typed (deliberately not chronological).
async function create(page, name, rows, { keyboard = false } = {}) {
  const add = page.getByRole("button", { name: "Add class", exact: true }).first();
  if (keyboard) { await add.focus(); await page.keyboard.press("Enter"); } else await add.click();
  await page.getByLabel("Class Name", { exact: true }).fill(name);
  for (const [i, [day, start]] of rows.entries()) {
    await page.getByRole("button", { name: "Add day", exact: true }).click();
    await page.getByLabel("Day of the week").nth(i).selectOption(String(day));
    await page.getByLabel("Start time", { exact: true }).nth(i).fill(start);
  }
  const res = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST" && !r.url().includes("dryRun"));
  const submit = page.getByRole("button", { name: "Create class", exact: true });
  if (keyboard) { await submit.focus(); await page.keyboard.press("Enter"); } else await submit.click();
  expect((await res).status()).toBe(201);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return (await res).json();
}
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-sessions-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const GI = "Beginners Gi";
const ADV = "Advanced Gi";
const browser = await chromium.launch();
let main;
try {
  const ctx = await context(browser, "10.94.3.1");
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  let gi;
  await section("sessions", "Gi typed with Monday 18:40, 06:30, 12:00 + Tue/Wed/Sat shows three Monday chips in time order, after reload too", async () => {
    gi = await create(main, GI, [[1, "18:40"], [1, "06:30"], [1, "12:00"], [2, "17:50"], [3, "06:30"], [6, "11:20"]], { keyboard: true });
    const want = { Mon: ["06:30", "12:00", "18:40"], Tue: ["17:50"], Wed: ["06:30"], Sat: ["11:20"], Thu: [], Fri: [], Sun: [] };
    for (const [day, t] of Object.entries(want)) await expect.poll(() => times(chips(main, day, GI)), { timeout: 20_000 }).toEqual(t);
    await main.reload();
    for (const [day, t] of Object.entries(want)) await expect.poll(() => times(chips(main, day, GI)), { timeout: 20_000 }).toEqual(t);
    // The class card's pill row comes from the server: day, then start time.
    const card = main.locator("div").filter({ has: main.getByRole("button", { name: `Pause ${GI}`, exact: true }) }).filter({ hasText: /Mon \d\d:\d\d/ }).last();
    const pills = await card.locator("span").filter({ hasText: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d$/ }).allTextContents();
    expect(pills).toEqual(["Mon 06:30", "Mon 12:00", "Mon 18:40", "Tue 17:50", "Wed 06:30", "Sat 11:20"]);
    return { response: gi.schedules.map((s) => `${s.dayOfWeek} ${s.startTime}`), db: await slots(gi.id), pills };
  });

  let adv;
  await section("interleave", "a second class at Mon 19:30 sits after the three Gi chips; every chip opens its own class", async () => {
    adv = await create(main, ADV, [[1, "19:30"]]);
    await expect.poll(() => times(allChips(main, "Mon")), { timeout: 20_000 }).toEqual(["06:30", "12:00", "18:40", "19:30"]);
    const monday = await labels(allChips(main, "Mon"));
    expect(monday).toEqual([`Edit ${GI}`, `Edit ${GI}`, `Edit ${GI}`, `Edit ${ADV}`]);
    await allChips(main, "Mon").nth(1).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue(GI);
    await expect(main.getByLabel("Day of the week")).toHaveCount(6);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await allChips(main, "Mon").nth(3).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue(ADV);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return { monday };
  });

  await section("keyboard", "Tab moves through the three Monday Gi chips in order; Enter opens the class; focus is visible", async () => {
    await allChips(main, "Mon").nth(0).focus();
    const seen = [];
    for (let i = 0; i < 3; i++) {
      seen.push(await main.evaluate(() => ({ label: document.activeElement?.getAttribute("aria-label")?.replace(/ \([a-z]+\)$/, ""), time: document.activeElement?.textContent?.match(/\d\d:\d\d/)?.[0] })));
      if (i < 2) await main.keyboard.press("Tab");
    }
    expect(seen).toEqual([{ label: `Edit ${GI}`, time: "06:30" }, { label: `Edit ${GI}`, time: "12:00" }, { label: `Edit ${GI}`, time: "18:40" }]);
    const ring = await main.evaluate(() => { const s = getComputedStyle(document.activeElement); return { outline: s.outlineStyle, shadow: s.boxShadow }; });
    await main.keyboard.press("Enter");
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue(GI);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    expect(ring.outline !== "none" || (ring.shadow && ring.shadow !== "none")).toBe(true);
    return { order: seen.map((s) => s.time), focusRing: ring };
  });

  await section("failed-save", "moving the 12:00 session to 12:30: network and server failures keep the form and save nothing; one retry saves it", async () => {
    await allChips(main, "Mon").nth(1).click();
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue(GI);
    const starts = await main.getByLabel("Start time", { exact: true }).evaluateAll((els) => els.map((e) => e.value));
    const row = starts.indexOf("12:00");
    expect(row).toBeGreaterThanOrEqual(0);
    await main.getByLabel("Start time", { exact: true }).nth(row).fill("12:30");
    const url = `**/api/classes/${gi.id}`;
    await main.route(url, (r) => (r.request().method() === "PATCH" ? r.abort() : r.continue()));
    const aborted = main.waitForEvent("requestfailed", (r) => r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${gi.id}`);
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    await aborted;
    await expect(main.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
    await expect(main.getByRole("dialog")).toHaveCount(1);
    await expect(main.getByLabel("Start time", { exact: true }).nth(row)).toHaveValue("12:30");
    await main.unroute(url);
    await main.route(url, (r) =>
      r.request().method() === "PATCH"
        ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Synthetic failed save" }) })
        : r.continue());
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main.getByText("Synthetic failed save").first()).toBeVisible();
    await expect(main.getByRole("dialog")).toHaveCount(1);
    await expect(main.getByLabel("Start time", { exact: true }).nth(row)).toHaveValue("12:30");
    const untouched = await slots(gi.id);
    expect(untouched.filter((s) => s.dayOfWeek === 1).map((s) => s.startTime)).toEqual(["06:30", "12:00", "18:40"]);
    await main.unroute(url);
    let patches = 0;
    const count = (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${gi.id}`) patches++; };
    main.on("request", count);
    const res = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await res).status()).toBe(200);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    main.off("request", count);
    expect(patches).toBe(1);
    await expect.poll(() => times(allChips(main, "Mon")), { timeout: 20_000 }).toEqual(["06:30", "12:30", "18:40", "19:30"]);
    await main.reload();
    await expect.poll(() => times(allChips(main, "Mon")), { timeout: 20_000 }).toEqual(["06:30", "12:30", "18:40", "19:30"]);
    return { patchesOnRetry: patches, saved: await slots(gi.id) };
  });

  await shot(main, "timetable-sessions-desktop");

  await section("phone", "375 x 812: Monday's agenda lists four sessions in time order, the day picker counts 4, no sideways scroll, rows are tappable", async () => {
    const mobile = await context(browser, "10.94.3.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      const rows = agenda.getByRole("button", { name: /^Edit / });
      await expect(rows).toHaveCount(4);
      const order = await times(rows);
      const names = await labels(rows);
      const counts = await phone.getByRole("tab").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[2]?.textContent));
      const boxes = [];
      for (let i = 0; i < 4; i++) { const b = await rows.nth(i).boundingBox(); boxes.push(b ? Math.round(b.height) : null); }
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-sessions-phone");
      expect(order).toEqual(["06:30", "12:30", "18:40", "19:30"]);
      expect(names).toEqual([`Edit ${GI}`, `Edit ${GI}`, `Edit ${GI}`, `Edit ${ADV}`]);
      expect(counts).toEqual(["4", "1", "1", "—", "—", "1", "—"]);
      expect(noSideScroll).toBe(true);
      expect(Math.min(...boxes)).toBeGreaterThanOrEqual(44);
      return { order, counts, rowHeights: boxes, noSideScroll };
    } catch (e) {
      await shot(phone, "timetable-sessions-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
  });

  await section("database", "exactly the typed sessions are stored, per class", async () => {
    const g = await slots(gi.id);
    const a = await slots(adv.id);
    expect(g.map((s) => `${DAY[s.dayOfWeek]} ${s.startTime}`)).toEqual(["Mon 06:30", "Mon 12:30", "Mon 18:40", "Tue 17:50", "Wed 06:30", "Sat 11:20"]);
    expect(a.map((s) => `${DAY[s.dayOfWeek]} ${s.startTime}`)).toEqual(["Mon 19:30"]);
    return { gi: g.length, advanced: a.length };
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-sessions-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
