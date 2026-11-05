// Timetable: Gi on Monday and Tuesday stays on screen (synthetic data only).
//   node run-journeys.mjs timetable-multiday   (needs a running server)
// Covers the stale-snapshot fix (another tab's change after a route refresh,
// browser Back after a save, pause/resume elsewhere) and the journeys around
// it: keyboard creation, failed saves with one-request retry, same-name
// classes, the who-can-attend preview, archive/restore and phone width.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, weekDay, weekGrid } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-multiday");
const errors = [];
const DAY = { 1: "Mon", 2: "Tue", 3: "Wed" };

const gridDay = (page, day) => weekDay(page, day.toLowerCase());
// A week chip is named "Edit Gi, Monday 18:00 to 19:00" (then its place and, today, its state).
const weekName = (name) => new RegExp(`^Edit ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, [A-Z][a-z]+day \\d\\d:\\d\\d to `);
const chips = (page, day, name) => gridDay(page, day).getByRole("button", { name: weekName(name) });
async function expectDays(page, name, want) {
  // A route refresh takes ~6 s to land on this harness (Neon round trips).
  for (const [d, n] of Object.entries(want)) await expect(chips(page, DAY[d], name)).toHaveCount(n, { timeout: 30_000 });
}
const activeSlots = async (classId) =>
  q(`select "dayOfWeek", "startTime" from "ClassSchedule" where "classId" = $1 and "isActive" = true order by "dayOfWeek"`, [classId]);
const isPatch = (id) => (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${id}` && !r.url().includes("dryRun");

// `start`: a start time other than the form's 18:00. More than three classes at once on a day fold behind
// "+N more" on the week, so a class this journey needs to SEE as a chip is kept out of the 18:00 crowd.
async function create(page, name, days, { start } = {}) {
  await page.getByRole("button", { name: "Add class", exact: true }).first().click();
  await page.getByLabel("Class Name", { exact: true }).fill(name);
  for (const [i, d] of days.entries()) {
    await page.getByRole("button", { name: "Add day", exact: true }).click();
    await page.getByLabel("Day of the week").nth(i).selectOption(String(d));
    if (start) await page.getByLabel("Start time", { exact: true }).nth(i).fill(start);
  }
  const res = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST" && !r.url().includes("dryRun"));
  await page.getByRole("button", { name: "Create class", exact: true }).click();
  expect((await res).status()).toBe(201);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return (await res).json();
}
async function openEdit(page, name, day) {
  await chips(page, DAY[day], name).first().click();
  await expect(page.getByLabel("Class Name", { exact: true })).toHaveValue(name);
}
async function saveEdit(page, id) {
  const res = page.waitForResponse(isPatch(id));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await res).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function addDay(page, name, cls, fromDay, newDay) {
  await openEdit(page, name, fromDay);
  const n = await page.getByLabel("Day of the week").count();
  await page.getByRole("button", { name: "Add day", exact: true }).click();
  await page.getByLabel("Day of the week").nth(n).selectOption(String(newDay));
  await saveEdit(page, cls.id);
}
async function routeRefresh(page) {
  const rsc = page.waitForResponse((r) => new URL(r.url()).pathname === "/dashboard/timetable" && r.request().headers().rsc === "1");
  await page.evaluate(() => window.next.router.refresh());
  expect((await rsc).status()).toBe(200);
}
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    const toasts = main && !main.isClosed() ? await main.locator('[role="status"], [role="alert"]').allInnerTexts().catch(() => []) : [];
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim(), toasts.filter(Boolean).length ? `toasts: ${toasts.filter(Boolean).join(" | ")}` : null].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-multiday-fail-${id}`);
      const dialogs = await main.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')].map((el) => ({
          role: el.getAttribute("role"),
          label: el.getAttribute("aria-label") ?? document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
          hiddenAncestor: !!el.closest('[aria-hidden="true"]'),
          inertAncestor: !!el.closest("[inert]"),
          visible: !!(el.offsetWidth || el.offsetHeight),
        }))).catch(() => "n/a");
      L.note(`${id}-dialogs`, "dialog elements at failure", dialogs);
      // Leave no drawer or dialog behind for the next section.
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
let main;
try {
  const ctx = await context(browser, "10.94.2.1");
  const open = async () => {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("/dashboard/timetable");
    await expect(p.getByRole("button", { name: "Add class", exact: true }).first()).toBeVisible();
    return p;
  };
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  let gi;
  await section("keyboard", "Gi created by keyboard with Monday + Tuesday; both shown, after reload and on reopening", async () => {
    await main.getByRole("button", { name: "Add class", exact: true }).first().focus();
    await main.keyboard.press("Enter");
    await main.getByLabel("Class Name", { exact: true }).focus();
    await main.keyboard.type("Gi");
    for (const [i, d] of [1, 2].entries()) {
      await main.getByRole("button", { name: "Add day", exact: true }).focus();
      await main.keyboard.press("Enter");
      await main.getByLabel("Day of the week").nth(i).selectOption(String(d));
    }
    const submit = main.getByRole("button", { name: "Create class", exact: true });
    await submit.focus();
    const ring = await submit.evaluate((el) => {
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle, shadow: s.boxShadow };
    });
    const visibleFocus = ring.outline !== "none" || (ring.shadow && ring.shadow !== "none");
    const res = main.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST");
    await main.keyboard.press("Enter");
    expect((await res).status()).toBe(201);
    gi = await (await res).json();
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expectDays(main, "Gi", { 1: 1, 2: 1 });
    await main.reload();
    await expectDays(main, "Gi", { 1: 1, 2: 1 });
    await openEdit(main, "Gi", 2);
    await expect(main.getByLabel("Day of the week")).toHaveCount(2);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    expect(visibleFocus).toBe(true);
    return { response: gi.schedules.map((s) => s.dayOfWeek), db: await activeSlots(gi.id), focusRing: ring };
  });

  await section("failed-save", "editing Tuesday: network and server failures keep the form and save nothing; one retry saves only Tuesday", async () => {
    await openEdit(main, "Gi", 2);
    const days = await main.getByLabel("Day of the week").evaluateAll((els) => els.map((e) => e.value));
    const tue = days.indexOf("2");
    await main.getByLabel("Start time", { exact: true }).nth(tue).fill("19:00");
    const url = `**/api/classes/${gi.id}`;
    await main.route(url, (r) => (r.request().method() === "PATCH" ? r.abort() : r.continue()));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
    await expect(main.getByLabel("Start time", { exact: true }).nth(tue)).toHaveValue("19:00");
    await main.unroute(url);
    await main.route(url, (r) =>
      r.request().method() === "PATCH"
        ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Synthetic failed save" }) })
        : r.continue());
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(main.getByText("Synthetic failed save").first()).toBeVisible();
    await expect(main.getByRole("dialog")).toHaveCount(1);
    await expect(main.getByLabel("Start time", { exact: true }).nth(tue)).toHaveValue("19:00");
    const untouched = await activeSlots(gi.id);
    expect(untouched.map((s) => s.startTime)).toEqual(["18:00", "18:00"]);
    await main.unroute(url);
    let patches = 0;
    const count = (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${gi.id}`) patches++; };
    main.on("request", count);
    await saveEdit(main, gi.id);
    main.off("request", count);
    expect(patches).toBe(1);
    await main.reload();
    await expectDays(main, "Gi", { 1: 1, 2: 1 });
    await expect(chips(main, "Mon", "Gi")).toContainText("18:00");
    await expect(chips(main, "Tue", "Gi")).toContainText("19:00");
    return { patchesOnRetry: patches, afterFailures: untouched, saved: await activeSlots(gi.id) };
  });

  let kids;
  await section("other-tab", "Tuesday added in another tab appears here after a route refresh", async () => {
    kids = await create(main, "Kids", [1]);
    const other = await open();
    await addDay(other, "Kids", kids, 1, 2);
    await other.close();
    await routeRefresh(main);
    await expectDays(main, "Kids", { 1: 1, 2: 1 });
    return { db: await activeSlots(kids.id) };
  });

  let comp;
  await section("back", "Tuesday saved here is still shown after a Dashboard link and browser Back", async () => {
    comp = await create(main, "Comp", [1]);
    await addDay(main, "Comp", comp, 1, 2);
    await main.locator('a[href="/dashboard"]:visible').first().click();
    await main.waitForURL(/\/dashboard$/);
    await main.goBack();
    await main.waitForURL(/\/dashboard\/timetable/);
    await expectDays(main, "Comp", { 1: 1, 2: 1 });
    return { db: await activeSlots(comp.id) };
  });

  await section("lists", "Kids paused then resumed in another tab: after each route refresh it is in one list only", async () => {
    const where = async () => ({
      grid: await weekGrid(main).getByRole("button", { name: weekName("Kids") }).count(),
      paused: await main.getByTestId(`inactive-class-${kids.id}`).count(),
    });
    const other = await open();
    await other.getByRole("button", { name: "Pause Kids", exact: true }).first().click();
    const paused = other.waitForResponse(isPatch(kids.id));
    await other.getByRole("dialog").last().getByRole("button", { name: "Pause class", exact: true }).click();
    expect((await paused).status()).toBe(200);
    await routeRefresh(main);
    await expect.poll(where, { timeout: 20_000 }).toEqual({ grid: 0, paused: 1 });
    const resumed = other.waitForResponse(isPatch(kids.id));
    await other.getByRole("button", { name: "Resume Kids", exact: true }).click();
    expect((await resumed).status()).toBe(200);
    await other.close();
    await routeRefresh(main);
    await expect.poll(where, { timeout: 20_000 }).toEqual({ grid: 2, paused: 0 });
    return "paused: grid 0 / paused 1; resumed: grid 2 / paused 0";
  });

  let pair;
  await section("same-name", "two separately created 'Open mat' classes (Monday, Tuesday) stay distinct, also after reload", async () => {
    // At 20:00: Monday 18:00 already has three classes, and a fourth at once would fold behind "+N more".
    const a = await create(main, "Open mat", [1], { start: "20:00" });
    const b = await create(main, "Open mat", [2], { start: "20:00" });
    expect(a.id).not.toBe(b.id);
    pair = [a, b];
    await expectDays(main, "Open mat", { 1: 1, 2: 1 });
    await main.reload();
    await expectDays(main, "Open mat", { 1: 1, 2: 1 });
    return { ids: [a.id, b.id], days: [(await activeSlots(a.id)).map((s) => s.dayOfWeek), (await activeSlots(b.id)).map((s) => s.dayOfWeek)] };
  });

  const rosterRows = async (id) => (await q(`select count(*)::int n from "ClassRoster" where "classId" = $1`, [id]))[0].n;
  await section("eligibility", "limiting Gi to one member shows who it turns away and saves on confirm; it reopens as that squad at once; switching back clears it", async () => {
    await openEdit(main, "Gi", 1);
    await main.getByRole("button", { name: "+ Select specific people (comp class)" }).click();
    await main.getByRole("checkbox", { name: /Member 1/ }).check();
    const preview = main.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/classes/${gi.id}?dryRun=1`));
    const saved = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await preview).status()).toBe(200);
    const confirm = main.getByRole("dialog").last();
    await expect(confirm.getByText("Check who this change turns away")).toBeVisible();
    await confirm.getByRole("button", { name: "Save — bookings are kept" }).click();
    expect((await saved).status()).toBe(200);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expectDays(main, "Gi", { 1: 1, 2: 1 });
    const limited = await rosterRows(gi.id);
    expect(limited).toBe(1);
    // Reopened straight away — no waiting for the page refresh: the save's
    // reply now carries the roster.
    await openEdit(main, "Gi", 1);
    await expect(main.getByRole("button", { name: "Switch back to rank gate" })).toBeVisible();
    await expect(main.getByRole("checkbox", { name: /Member 1/ })).toBeChecked({ timeout: 20_000 });
    await expect(main.getByRole("checkbox", { name: /Member 2/ })).not.toBeChecked();
    await main.getByRole("button", { name: "Switch back to rank gate" }).click();
    const reopened = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    // Opening a class turns no one away, so no confirmation is asked for.
    expect((await reopened).status()).toBe(200);
    await expect(main.getByText("Check who this change turns away")).toHaveCount(0);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    const afterSwitchBack = await rosterRows(gi.id);
    expect(afterSwitchBack).toBe(0);
    await openEdit(main, "Gi", 1);
    await expect(main.getByRole("button", { name: "+ Select specific people (comp class)" })).toBeVisible();
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expectDays(main, "Gi", { 1: 1, 2: 1 });
    return { rosterRowsWhileLimited: limited, rosterRowsAfterSwitchBack: afterSwitchBack, slots: await activeSlots(gi.id) };
  });

  await section("archive", "archive Comp with its counted confirmation, then restore it: one list at a time, both days back", async () => {
    // Archive reads the class's history counts before it asks (a dry run).
    const counts = main.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes(`/api/classes/${comp.id}?dryRun=1`));
    const t0 = Date.now();
    const archiveBtn = main.getByRole("button", { name: "Archive Comp", exact: true }).first();
    await archiveBtn.click();
    // Busy from the click, while the history is read — not an idle button.
    await expect(archiveBtn).toHaveAttribute("aria-busy", "true", { timeout: 2_000 });
    await expect(archiveBtn).toBeDisabled();
    expect((await counts).status()).toBe(200);
    const countsMs = Date.now() - t0;
    const dialog = main.getByRole("dialog", { name: "Archive Comp?" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/no check-ins, roster or bookings yet/)).toBeVisible();
    const del = main.waitForResponse((r) => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/classes/${comp.id}` && !r.url().includes("dryRun"));
    await dialog.getByRole("button", { name: "Archive class" }).click();
    expect((await del).status()).toBe(200);
    await expectDays(main, "Comp", { 1: 0, 2: 0 });
    await expect(main.getByTestId(`inactive-class-${comp.id}`)).toHaveCount(1);
    const restored = main.waitForResponse(isPatch(comp.id));
    await main.getByRole("button", { name: "Restore Comp", exact: true }).click();
    expect((await restored).status()).toBe(200);
    await expectDays(main, "Comp", { 1: 1, 2: 1 });
    await expect(main.getByTestId(`inactive-class-${comp.id}`)).toHaveCount(0);
    await main.reload();
    await expectDays(main, "Comp", { 1: 1, 2: 1 });
    return { countsReadMs: countsMs, slots: await activeSlots(comp.id) };
  });

  await shot(main, "timetable-multiday-desktop");

  await section("phone", "390 x 844: the Monday and Tuesday agenda each show Gi once; no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.2.2", { viewport: { width: 390, height: 844 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto("/dashboard/timetable");
    const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
    const sizes = {};
    for (const day of ["Mon", "Tue"]) {
      await phone.getByRole("tab", { name: new RegExp(`^${day}`) }).click();
      const gi = agenda.getByRole("button", { name: "Edit Gi", exact: true });
      await expect(gi).toHaveCount(1);
      const box = await gi.boundingBox();
      sizes[day] = box ? { w: Math.round(box.width), h: Math.round(box.height) } : null;
    }
    const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    await shot(phone, "timetable-multiday-phone");
    await mobile.close();
    expect(noSideScroll).toBe(true);
    L.note("phone-tap", "agenda chip size (px)", sizes);
    return { noSideScroll, sizes };
  });

  await section("database", "every intended weekday slot is stored, and only those", async () => {
    const rows = await q(
      `select c.name, s."dayOfWeek" from "Class" c join "ClassSchedule" s on s."classId" = c.id
       where c."tenantId" = $1 and s."isActive" = true order by c.name, s."dayOfWeek"`, [club.tenantId]);
    const by = rows.reduce((m, r) => ((m[r.name] ??= []).push(r.dayOfWeek), m), {});
    expect(by).toEqual({ Comp: [1, 2], Gi: [1, 2], Kids: [1, 2], "Open mat": [1, 2] });
    expect(pair[0].id).not.toBe(pair[1].id);
    return by;
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-multiday-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
