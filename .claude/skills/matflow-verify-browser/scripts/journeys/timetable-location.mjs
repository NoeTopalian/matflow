// The class form's Location: what is typed becomes a saved location (a mat), picked from a list next time
// (Noe, 7 Nov 2026), and the By mat split that follows (synthetic data only).
//   node run-journeys.mjs timetable-location
// The mats journey's companion (timetable-mats.mjs sets mats up from the Mats sheet; this one from the class form).
// Seeds three Monday 18:00 classes with no place, then walks what an owner does: chooses By time first, so the
// split is the club's choice; by keyboard, types "Mat 1" as a new location on one class and picks it from the list
// on a second; types "Mat 2" on a third with a forced failed save first (the typed text is kept, one retry saves);
// sees that saving locations did not change the split; presses By mat and gets two columns; the members' Monday
// follows; picks a place typed on two Tuesday classes for a third class, which takes all three onto the new location
// (and one of them, edited for something else, stays put); on a phone
// picks a saved location for a new class from the same list; and at 390 px a refused Location (twelve already) is
// said beside the field with the typed name kept and focus on it.
import { createRequire } from "node:module";
import { state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, weekGrid, weekDay, launchWithScrollbars } from "../lib.mjs";
// The refusal sentence the server gives past twelve mats (lib/mats.ts LOCATION_ERRORS.limit), quoted so the
// journey checks the words a person reads.
const LIMIT = "You already have 12 locations, the most a club can have, so this one can't be added. Remove a location under Mats, or choose one from the list.";

const require = createRequire(import.meta.url);
// Assertions wait 20 s (see timetable-mats.mjs: the slow path to the test branch measured 5 Nov 2026).
const expect = require("@playwright/test").expect.configure({ timeout: 20_000 });
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-location");
const errors = [];
const watch = (page) => page.on("pageerror", (e) => errors.push(e.message));

const CLASSES = ["Gi Fundamentals", "No-Gi", "Wrestling"];
const MONDAY_1800 = [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }];
const TUESDAY_1000 = [{ dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }];
const TYPED = ["Yoga", "Pilates"];
const UNPLACED = "Barre";
const matRows = () => q(`select id, name from "Mat" where "tenantId" = $1 order by "sortOrder", "createdAt"`, [club.tenantId]);
const classRow = async (name) => (await q(`select c.location, c."matId", m.name mat from "Class" c left join "Mat" m on m.id = c."matId" where c."tenantId" = $1 and c.name = $2`, [club.tenantId, name]))[0];
const storedLayout = async () => (await q(`select "timetableLayout" v from "Tenant" where id = $1`, [club.tenantId]))[0].v;
const matCreateAudits = async () => (await q(`select count(*)::int n from "AuditLog" where "tenantId" = $1 and action = 'mat.create'`, [club.tenantId]))[0].n;
const adoptAudits = async () => (await q(`select count(*)::int n from "AuditLog" where "tenantId" = $1 and action = 'mat.adopt'`, [club.tenantId]))[0].n;
const capacityOf = async (name) => (await q(`select "maxCapacity" v from "Class" where "tenantId" = $1 and name = $2`, [club.tenantId, name]))[0].v;
const matHeads = (page, day) => weekDay(page, day).locator("[data-mat-head]").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
const dialog = (page) => page.getByRole("dialog", { name: "Edit class" });

let main;
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-location-fail-${id}`).catch(() => {});
      await main.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      for (let i = 0; i < 4 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

/** Opens a class's edit form from the week grid (Monday unless said) and returns its Location select. */
async function openEdit(page, name, day = "mon") {
  await weekDay(page, day).getByRole("button", { name: new RegExp(`^Edit ${name},`) }).first().click();
  await expect(dialog(page)).toBeVisible();
  return dialog(page).getByLabel("Location", { exact: true });
}
/** Presses the form's Save by keyboard. */
async function saveByKeyboard(page) {
  await dialog(page).getByRole("button", { name: "Save changes", exact: true }).focus();
  await page.keyboard.press("Enter");
}

const browser = await launchWithScrollbars();
try {
  const ctx = await context(browser, "10.96.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  main = await ctx.newPage();
  watch(main);
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");

  await section("seed", `three Monday 18:00 classes with no place, no mats, and the owner chooses By time (saved for the whole club)`, async () => {
    for (const name of CLASSES) {
      const status = await main.evaluate(async (body) => (await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { name, duration: 60, schedules: MONDAY_1800 });
      expect(status).toBe(201);
    }
    expect(await matRows()).toEqual([]);
    await main.reload();
    await expect(weekDay(main, "mon").locator("[data-cell-key] button")).toHaveCount(3);
    await main.getByTestId("timetable-split-time").click();
    await expect(main.getByText("Saved for the whole club.").first()).toBeVisible();
    expect(await storedLayout()).toBe("time");
    return { classes: CLASSES.length };
  });

  await section("type-new", `by keyboard: "Add a new location…" on ${CLASSES[0]}, type "Mat 1", save; one mat "Mat 1" is saved, the class is on it with that place, one mat.create row, and the owner is told`, async () => {
    const select = await openEdit(main, CLASSES[0]);
    const before = await select.locator("option").allTextContents();
    expect(before).toEqual(["No location", "Add a new location…"]);
    await expect(select).toHaveValue("none");
    await select.focus();
    // Type-ahead on the closed select: "Add…" is the only option starting with A.
    await main.keyboard.type("Add");
    await expect(select).toHaveValue("new");
    await main.keyboard.press("Tab");
    const box = dialog(main).getByLabel("Name of the new location", { exact: true });
    await expect(box).toBeFocused();
    await main.keyboard.type("Mat 1");
    await saveByKeyboard(main);
    await expect(dialog(main)).toHaveCount(0);
    await expect(main.getByText("“Mat 1” is saved as a location.", { exact: false }).first()).toBeVisible();
    const mats = await matRows();
    expect(mats.map((m) => m.name)).toEqual(["Mat 1"]);
    expect(await classRow(CLASSES[0])).toEqual({ location: "Mat 1", matId: mats[0].id, mat: "Mat 1" });
    expect(await matCreateAudits()).toBe(1);
    return { options: before, mats: mats.map((m) => m.name) };
  });

  await section("pick-saved", `by keyboard: ${CLASSES[1]}'s Location lists "Mat 1" first; picking it puts the class on the same mat and adds none`, async () => {
    const select = await openEdit(main, CLASSES[1]);
    await expect.poll(() => select.locator("option").allTextContents()).toEqual(["Mat 1", "No location", "Add a new location…"]);
    await select.focus();
    await main.keyboard.type("Mat");
    await expect(select).toHaveValue(/^mat:/);
    await saveByKeyboard(main);
    await expect(dialog(main)).toHaveCount(0);
    const mats = await matRows();
    expect(mats).toHaveLength(1);
    expect(await classRow(CLASSES[1])).toEqual({ location: "Mat 1", matId: mats[0].id, mat: "Mat 1" });
    expect(await matCreateAudits()).toBe(1);
    return { mats: mats.length };
  });

  await section("failed-save", `"Mat 2" typed on ${CLASSES[2]}: a forced failed save keeps the form, the choice and the typed text, and writes nothing; one retry saves it as a second mat`, async () => {
    const select = await openEdit(main, CLASSES[2]);
    await select.focus();
    await main.keyboard.type("Add");
    await expect(select).toHaveValue("new");
    const box = dialog(main).getByLabel("Name of the new location", { exact: true });
    await box.fill("Mat 2");
    const patches = [];
    const onReq = (r) => { if (r.method() === "PATCH" && /\/api\/classes\/[^/?]+$/.test(new URL(r.url()).pathname)) patches.push(r.url()); };
    main.on("request", onReq);
    await main.route("**/api/classes/*", (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to update class" }) }) : r.fallback()), { times: 1 });
    await saveByKeyboard(main);
    await expect(dialog(main).getByTestId("class-form-save-error")).toBeVisible();
    await expect(select).toHaveValue("new");
    await expect(box).toHaveValue("Mat 2");
    expect((await matRows()).map((m) => m.name)).toEqual(["Mat 1"]);
    await saveByKeyboard(main);
    await expect(dialog(main)).toHaveCount(0);
    main.off("request", onReq);
    expect(patches).toHaveLength(2); // the failed one and one retry
    const mats = await matRows();
    expect(mats.map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
    expect(await classRow(CLASSES[2])).toEqual({ location: "Mat 2", matId: mats[1].id, mat: "Mat 2" });
    return { patches: patches.length };
  });

  await section("split-unchanged", "saving locations did not change the club's choice: still By time, nothing stored changed, and the week is not split by mat", async () => {
    await main.reload();
    await expect(weekDay(main, "mon").locator("[data-cell-key] button")).toHaveCount(3);
    expect(await storedLayout()).toBe("time");
    await expect(main.getByTestId("timetable-split-time")).toHaveAttribute("aria-pressed", "true");
    await expect(weekGrid(main)).not.toHaveAttribute("data-mats", "true");
    return { stored: "time" };
  });

  await section("by-mat", "By mat: saved for the whole club, and Monday is two columns, Mat 1 (two classes) then Mat 2 (one)", async () => {
    await main.getByTestId("timetable-split-mat").click();
    await expect(main.getByText("Saved for the whole club.").first()).toBeVisible();
    await expect(weekGrid(main)).toHaveAttribute("data-mats", "true");
    await expect.poll(() => matHeads(main, "mon")).toEqual(["Mat 1", "Mat 2"]);
    expect(await storedLayout()).toBe("mat");
    const columns = await main.evaluate(() => {
      const mon = document.querySelector('[data-testid="week-grid"] [data-day="mon"]');
      const heads = [...mon.querySelectorAll("[data-mat-head]")].map((h) => ({ name: h.textContent.trim(), r: h.getBoundingClientRect() }));
      const cells = [...mon.querySelectorAll("[data-cell-key]")].map((c) => c.getBoundingClientRect());
      return heads.map((h) => ({ name: h.name, chips: cells.filter((r) => r.left >= h.r.left - 1 && r.right <= h.r.right + 1).length }));
    });
    expect(columns).toEqual([{ name: "Mat 1", chips: 2 }, { name: "Mat 2", chips: 1 }]);
    await shot(main, "timetable-location-by-mat-1440");
    return columns;
  });

  await section("members-follow", "390 px, member: next Monday's schedule is drawn in mat columns too", async () => {
    const member = await memberLogin(club);
    const mctx = await context(browser, "10.96.1.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
    try {
      const page = await mctx.newPage();
      watch(page);
      await memberSignIn(page, club, member);
      await page.goto("/member/schedule");
      await page.getByRole("button", { name: /^Mon\s*\d/ }).first().click();
      const pane = page.getByTestId("schedule-pane");
      await expect(pane.getByTestId("schedule-day")).toHaveAttribute("data-mats", "true", { timeout: 30_000 });
      const heads = await pane.locator("[data-mat-head]").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
      expect(heads).toEqual(["Mat 1", "Mat 2"]);
      await shot(page, "timetable-location-member-390");
      return { heads };
    } finally {
      await mctx.close();
    }
  });

  await section("pick-place", `"Upstairs", typed on two Tuesday classes, is offered to a third (${UNPLACED}, no place) between the saved locations and No location; picked by keyboard, it is saved as a location and all three classes are on it ("3 classes are now on it"); ${TYPED[0]} then lists "Upstairs" once, on it, and an edit of its capacity leaves its Location as it was`, async () => {
    for (const [name, location] of [[TYPED[0], "Upstairs"], [TYPED[1], "Upstairs"], [UNPLACED, null]]) {
      const status = await main.evaluate(async (body) => (await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { name, location, duration: 60, schedules: TUESDAY_1000 });
      expect(status).toBe(201);
    }
    await main.reload();
    await expect(weekDay(main, "tue").locator("[data-cell-key] button")).toHaveCount(3);
    // A class that types the place opens on it; leaving it alone saves nothing (no silent move).
    const own = await openEdit(main, TYPED[0], "tue");
    await expect(own).toHaveValue("place:Upstairs");
    await dialog(main).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog(main)).toHaveCount(0);
    const select = await openEdit(main, UNPLACED, "tue");
    await expect(select.locator("option")).toHaveText(["Mat 1", "Mat 2", "Upstairs", "No location", "Add a new location…"]);
    await expect(select).toHaveValue("none");
    await select.focus();
    await main.keyboard.type("Up");
    await expect(select).toHaveValue("place:Upstairs");
    await saveByKeyboard(main);
    await expect(dialog(main)).toHaveCount(0);
    await expect(main.getByText("“Upstairs” is saved as a location. 3 classes are now on it.", { exact: false }).first()).toBeVisible();
    const mats = await matRows();
    expect(mats.map((m) => m.name)).toEqual(["Mat 1", "Mat 2", "Upstairs"]);
    const upstairs = mats[2].id;
    // All three: the one saved and the two that typed it (as "Add these as mats" does).
    for (const name of [UNPLACED, ...TYPED]) expect(await classRow(name)).toEqual({ location: "Upstairs", matId: upstairs, mat: "Upstairs" });
    expect(await matCreateAudits()).toBe(3);
    expect(await adoptAudits()).toBe(1);
    // Yoga, now on Upstairs: the list names it once, selected; an unrelated edit does not touch its Location.
    const yoga = await openEdit(main, TYPED[0], "tue");
    const texts = await yoga.locator("option").allTextContents();
    expect(texts).toEqual(["Mat 1", "Mat 2", "Upstairs", "No location", "Add a new location…"]);
    expect(new Set(texts.map((t) => t.trim().toLowerCase())).size).toBe(texts.length);
    await expect(yoga).toHaveValue(`mat:${upstairs}`);
    await dialog(main).getByLabel("Max Capacity", { exact: true }).fill("20");
    const patch = main.waitForRequest((r) => r.method() === "PATCH" && /\/api\/classes\/[^/?]+$/.test(new URL(r.url()).pathname));
    await saveByKeyboard(main);
    const sent = JSON.parse((await patch).postData() ?? "{}");
    await expect(dialog(main)).toHaveCount(0);
    expect(Object.keys(sent).filter((k) => ["matId", "matName", "location"].includes(k))).toEqual([]);
    await expect.poll(() => capacityOf(TYPED[0])).toBe(20);
    expect(await classRow(TYPED[0])).toEqual({ location: "Upstairs", matId: upstairs, mat: "Upstairs" });
    expect((await matRows()).map((m) => m.name)).toEqual(["Mat 1", "Mat 2", "Upstairs"]);
    return { mats: mats.map((m) => m.name), yogaOptions: texts };
  });

  for (const width of [375, 390]) {
    await section(`phone-${width}`, `${width} px, owner: a new class picks "Mat 2" from the same Location list; the select and the new-name box are at least 44 px tall to tap; the page does not scroll sideways; the class is saved on Mat 2 and no mat is added`, async () => {
      const mobile = await context(browser, `10.96.1.${width === 375 ? 30 : 31}`, { viewport: { width, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState(), timezoneId: "Europe/London" });
      const phone = await mobile.newPage();
      watch(phone);
      try {
        const name = `Kids ${width}`;
        await phone.goto("/dashboard/timetable");
        await phone.getByRole("button", { name: "Add class", exact: true }).first().tap();
        const form = phone.getByRole("dialog", { name: "New class" });
        await expect(form).toBeVisible();
        await form.getByLabel("Class Name", { exact: true }).fill(name);
        await form.getByRole("button", { name: "Add day", exact: true }).tap();
        const select = form.getByLabel("Location", { exact: true });
        expect(await select.locator("option").allTextContents()).toEqual(["Mat 1", "Mat 2", "Upstairs", "No location", "Add a new location…"]);
        await select.selectOption({ label: "Add a new location…" });
        const box = form.getByLabel("Name of the new location", { exact: true });
        await expect(box).toBeVisible();
        const sizes = { select: Math.round((await select.boundingBox()).height), box: Math.round((await box.boundingBox()).height) };
        expect(sizes.select).toBeGreaterThanOrEqual(44);
        expect(sizes.box).toBeGreaterThanOrEqual(44);
        await select.selectOption({ label: "Mat 2" });
        await expect(box).toHaveCount(0);
        expect(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
        await shot(phone, `timetable-location-form-phone-${width}`);
        await form.getByRole("button", { name: "Create class", exact: true }).tap();
        await expect(form).toHaveCount(0);
        const mats = await matRows();
        expect(mats.map((m) => m.name)).toEqual(["Mat 1", "Mat 2", "Upstairs"]);
        expect(await classRow(name)).toEqual({ location: "Mat 2", matId: mats[1].id, mat: "Mat 2" });
        return sizes;
      } finally {
        await mobile.close();
      }
    });
  }

  await section("phone-refused", "390 px: a Location refused past twelve mats is said beside the field, not under the buttons; the typed name stays in its box with focus on it; nothing is saved; changing the name clears it", async () => {
    const mobile = await context(browser, "10.96.1.32", { viewport: { width: 390, height: 812 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState(), timezoneId: "Europe/London" });
    const phone = await mobile.newPage();
    watch(phone);
    try {
      const name = "Refused 390";
      await phone.goto("/dashboard/timetable");
      await phone.getByRole("button", { name: "Add class", exact: true }).first().tap();
      const form = phone.getByRole("dialog", { name: "New class" });
      await expect(form).toBeVisible();
      await form.getByLabel("Class Name", { exact: true }).fill(name);
      await form.getByRole("button", { name: "Add day", exact: true }).tap();
      await form.getByLabel("Location", { exact: true }).selectOption({ label: "Add a new location…" });
      const box = form.getByLabel("Name of the new location", { exact: true });
      await box.fill("Garage");
      // The server's own refusal past twelve mats, so the journey does not need twelve real ones.
      await phone.route("**/api/classes", (r) => (r.request().method() === "POST" && !r.request().url().includes("dryRun")
        ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: LIMIT, reason: "location" }) })
        : r.fallback()), { times: 1 });
      await form.getByRole("button", { name: "Create class", exact: true }).tap();
      const said = form.getByTestId("class-form-location-error");
      await expect(said).toHaveText(LIMIT);
      await expect(form.getByTestId("class-form-save-error")).toHaveCount(0);
      await expect(box).toHaveValue("Garage");
      await expect(box).toBeFocused();
      await expect(box).toHaveAttribute("aria-invalid", "true");
      // On screen: the sentence sits inside the window, just under the box.
      const where = await phone.evaluate(() => {
        const r = document.querySelector('[data-testid="class-form-location-error"]').getBoundingClientRect();
        const b = document.querySelector('[data-testid="class-form-new-location"]').getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), gap: Math.round(r.top - b.bottom), height: window.innerHeight };
      });
      expect(where.top).toBeGreaterThanOrEqual(0);
      expect(where.bottom).toBeLessThanOrEqual(where.height);
      expect(where.gap).toBeGreaterThanOrEqual(0);
      expect(where.gap).toBeLessThanOrEqual(40);
      expect(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
      await shot(phone, "timetable-location-refused-phone-390");
      expect(await classRow(name)).toBeUndefined();
      expect((await matRows()).map((m) => m.name)).toEqual(["Mat 1", "Mat 2", "Upstairs"]);
      await box.fill("Garage 2");
      await expect(said).toHaveCount(0);
      return where;
    } finally {
      await mobile.close();
    }
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-location-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
