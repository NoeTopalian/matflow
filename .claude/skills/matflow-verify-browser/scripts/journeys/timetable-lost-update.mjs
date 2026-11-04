// Timetable: a stale tab cannot delete a day it never saw (synthetic data only).
//   node run-journeys.mjs timetable-lost-update
// P6: tab A opens Gi (Monday) to rename it; tab B adds Tuesday; tab A saves. The save is refused with a
// message that says what happened, the form keeps its typed values, nothing is written, Tuesday survives
// in the database; after a reload tab A sees both days and the same rename saves. Also: the dry-run
// preview path (a squad change) is refused the same way; a save that does not touch the days still works.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-lost-update");
const errors = [];

const gridDay = (page, day) => page.locator(".grid-cols-7 > div").filter({ has: page.getByText(day, { exact: true }) });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const chips = (page, day, name) => gridDay(page, day).getByRole("button", { name: new RegExp(`^Edit ${escapeRe(name)}( \\([a-z]+\\))?$`) });
// The refusal must be IN the form (role=alert beside the buttons), never a toast.
const refusal = (page) => page.getByRole("dialog").getByTestId("class-form-save-error");
const activeDays = async (classId) =>
  (await q(`select "dayOfWeek" from "ClassSchedule" where "classId" = $1 and "isActive" = true order by "dayOfWeek"`, [classId])).map((r) => r.dayOfWeek);
const nameOf = async (classId) => (await q(`select name from "Class" where id = $1`, [classId]))[0]?.name;
const isPatch = (id) => (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${id}` && !r.url().includes("dryRun");

async function create(page, name, days) {
  await page.getByRole("button", { name: "Add class", exact: true }).first().click();
  await page.getByLabel("Class Name", { exact: true }).fill(name);
  for (const [i, d] of days.entries()) {
    await page.getByRole("button", { name: "Add day", exact: true }).click();
    await page.getByLabel("Day of the week").nth(i).selectOption(String(d));
  }
  const res = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST" && !r.url().includes("dryRun"));
  await page.getByRole("button", { name: "Create class", exact: true }).click();
  expect((await res).status()).toBe(201);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return (await res).json();
}
async function openEdit(page, name, day) {
  await chips(page, day, name).first().click();
  await expect(page.getByLabel("Class Name", { exact: true })).toHaveValue(name);
}
async function addDay(page, name, cls, fromDay, newDay) {
  await openEdit(page, name, fromDay);
  const n = await page.getByLabel("Day of the week").count();
  await page.getByRole("button", { name: "Add day", exact: true }).click();
  await page.getByLabel("Day of the week").nth(n).selectOption(String(newDay));
  const res = page.waitForResponse(isPatch(cls.id));
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await res).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `timetable-lost-update-fail-${id}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
let main;
try {
  const ctx = await context(browser, "10.94.6.1");
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
  await section("stale-save", "tab A renames Gi after tab B added Tuesday: refused with a message, typed values kept, nothing written, Tuesday survives", async () => {
    gi = await create(main, "Gi", [1]);
    await openEdit(main, "Gi", "Mon"); // tab A holds Monday only
    const other = await open();
    await addDay(other, "Gi", gi, "Mon", 2); // tab B adds Tuesday
    await other.close();
    expect(await activeDays(gi.id)).toEqual([1, 2]);
    await main.getByLabel("Class Name", { exact: true }).fill("Gi Fundamentals");
    const res = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    const status = (await res).status();
    expect(status).toBe(409);
    await expect(refusal(main)).toContainText(/days or times changed since you opened it/);
    await expect(main.getByRole("dialog").getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(main.getByRole("dialog")).toHaveCount(1);
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Gi Fundamentals");
    const days = await activeDays(gi.id);
    const name = await nameOf(gi.id);
    expect(days).toEqual([1, 2]);
    expect(name).toBe("Gi");
    return { status, daysAfterRefusal: days, nameAfterRefusal: name };
  });

  await section("reload-then-save", "after a reload tab A sees both days; the same rename saves and keeps Tuesday", async () => {
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await main.reload();
    await expect(chips(main, "Mon", "Gi")).toHaveCount(1, { timeout: 20_000 });
    await expect(chips(main, "Tue", "Gi")).toHaveCount(1);
    await openEdit(main, "Gi", "Mon");
    await expect(main.getByLabel("Day of the week")).toHaveCount(2);
    await main.getByLabel("Class Name", { exact: true }).fill("Gi Fundamentals");
    const res = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    expect((await res).status()).toBe(200);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expect(chips(main, "Mon", "Gi Fundamentals")).toHaveCount(1);
    await expect(chips(main, "Tue", "Gi Fundamentals")).toHaveCount(1);
    return { days: await activeDays(gi.id), name: await nameOf(gi.id) };
  });

  await section("preview-refused", "a squad change (which previews who is turned away) from a stale tab is refused before any confirmation", async () => {
    await openEdit(main, "Gi Fundamentals", "Mon"); // tab A: Mon + Tue
    const other = await open();
    await addDay(other, "Gi Fundamentals", gi, "Mon", 3); // tab B adds Wednesday
    await other.close();
    await main.getByRole("button", { name: "+ Select specific people (comp class)" }).click();
    await main.getByRole("checkbox", { name: /Member 1/ }).check();
    const preview = main.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(`/api/classes/${gi.id}?dryRun=1`));
    await main.getByRole("button", { name: "Save changes", exact: true }).click();
    const status = (await preview).status();
    expect(status).toBe(409);
    await expect(refusal(main)).toContainText(/days or times changed since you opened it/);
    await expect(main.getByText("Check who this change turns away")).toHaveCount(0);
    const roster = (await q(`select count(*)::int n from "ClassRoster" where "classId" = $1`, [gi.id]))[0].n;
    expect(roster).toBe(0);
    expect(await activeDays(gi.id)).toEqual([1, 2, 3]);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return { previewStatus: status, rosterRows: roster, days: await activeDays(gi.id) };
  });

  await shot(main, "timetable-lost-update-desktop");

  await section("phone", "375 x 812: a phone's stale save is refused too; the message reads inside the sheet above Save; no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.6.2", { viewport: { width: 375, height: 812 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      await phone.getByRole("tab", { name: /^Mon/ }).click();
      const agenda = phone.locator('[role="tablist"][aria-label="Day of week"] + div');
      await agenda.getByRole("button", { name: /^Edit Gi Fundamentals/ }).first().click();
      await expect(phone.getByLabel("Class Name", { exact: true })).toHaveValue("Gi Fundamentals");
      const base = await activeDays(gi.id); // [1, 2, 3]
      // The desk (another device) adds Thursday meanwhile.
      const desk = await open();
      await addDay(desk, "Gi Fundamentals", gi, "Mon", 4);
      await desk.close();
      await phone.getByLabel("Class Name", { exact: true }).fill("Gi Fundamentals B");
      const res = phone.waitForResponse(isPatch(gi.id));
      await phone.getByRole("button", { name: "Save changes", exact: true }).click();
      expect((await res).status()).toBe(409);
      const msg = refusal(phone);
      await expect(msg).toContainText(/days or times changed since you opened it/);
      await expect(phone.getByRole("dialog").getByRole("button", { name: "Reload" })).toBeVisible();
      const [m, save] = await Promise.all([msg.boundingBox(), phone.getByRole("button", { name: "Save changes", exact: true }).boundingBox()]);
      const noSideScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      await shot(phone, "timetable-lost-update-phone");
      expect(m && save && m.y < save.y).toBe(true);
      expect(noSideScroll).toBe(true);
      expect(await activeDays(gi.id)).toEqual([...base, 4]);
      expect(await nameOf(gi.id)).toBe("Gi Fundamentals");
      return { messageAboveSave: true, noSideScroll, days: await activeDays(gi.id) };
    } catch (e) {
      await shot(phone, "timetable-lost-update-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
  });

  await section("pause-untouched", "a pause from a stale tab sends no days, so it is not refused and the days stay", async () => {
    // Tab A's page state predates Wednesday and Thursday; Pause sends { isActive: false } only.
    const paused = main.waitForResponse(isPatch(gi.id));
    await main.getByRole("button", { name: "Pause Gi Fundamentals", exact: true }).first().click();
    await main.getByRole("dialog").last().getByRole("button", { name: "Pause class", exact: true }).click();
    expect((await paused).status()).toBe(200);
    expect(await activeDays(gi.id)).toEqual([1, 2, 3, 4]);
    return { days: await activeDays(gi.id) };
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-lost-update-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
