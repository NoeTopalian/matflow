// Class categories, Release B (12 Nov 2026): the Categories sheet on the Timetable page (synthetic data only).
//   CLASS_CATEGORY_MANAGEMENT=on node run-journeys.mjs class-categories-b
// The switch must be on in the server's environment (run-journeys passes the shell's environment through).
//   B1 the sheet lists the club's eight starting categories, each with its class count;
//   B2 add "Intermediate" (keyboard: Add, type, Enter): a club-made row, recorded in Activity;
//   B3 rename Fundamentals to Beginners in place: the class on it keeps it, name and all;
//   B4 move Kids up by keyboard: the order is saved and focus stays on the control;
//   B5 archive Gi: listed under Archived, its class keeps it, the class form no longer offers it for another class;
//   B6 restore Gi: offered again;
//   B7 a stale edit (another tab renamed the category meanwhile) is refused: the sheet says so and shows what is there;
//   B8 a forced failed save keeps the typed name and says so beside it; the retry saves it once;
//   B9 a duplicate name is refused beside the new row;
//   B10 phone 390 px: the sheet opens, no sideways scroll;
//   B11 a coach has no Categories button;
//   B12 an editor left open: another tab gives the class a category; this form's change is refused beside the
//       buttons, the other tab's choice is kept, and the request carried the category the form saw;
//   B13 reorder then rename at once (the reorder held 6 s): both land; the rename counts the reorder's own bump;
//   B14 two admins: the owner's rename waits behind a reorder whose answer is held while the manager renames the same category; the
//       owner's rename is refused (stale), the sheet says so, and the manager's name is kept (B3-1);
//   B15 a lost response: the reorder reaches the server but its answer is dropped; the sheet says it could not confirm
//       the move and shows the saved order; a retry and a rename then land, and the screen matches the database.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("class-categories-b");
const TAG = randomUUID().slice(0, 4);
const errors = [];
async function section(id, desc, fn) {
  try { L.check(id, desc, true, await fn()); } catch (e) { L.check(id, desc, false, String(e.message ?? e).split("\n").filter((s) => s.trim()).slice(0, 6).join(" | ")); }
}
const catRows = () => q(`select id, name, "legacyKey", "sortOrder", "archivedAt", version from "ClassCategory" where "tenantId" = $1 order by "sortOrder", id`, [tenantId]);
const classCat = async (id) => (await q(`select "categoryId", name from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0];
const audits = async (action) => Number((await q(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = $2`, [tenantId, action]))[0].n);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.96.6.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(page, club);
  let rows = await catRows();
  if (rows.length === 0) {
    await q(`select matflow_seed_class_categories($1)`, [tenantId]);
    rows = await catRows();
  }
  const fund = rows.find((r) => r.legacyKey === "fundamentals");
  const gi = rows.find((r) => r.legacyKey === "gi");
  const kids = rows.find((r) => r.legacyKey === "kids");
  const mk = (name, categoryId) => page.evaluate(async ([n, c]) => {
    const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n, duration: 60, categoryId: c, schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00" }] }) });
    return { status: r.status, body: await r.json() };
  }, [name, categoryId]);
  const onFund = await mk(`Fundamentals Gi ${TAG}`, fund.id);
  const onGi = await mk(`Gi Open ${TAG}`, gi.id);
  const plain = await mk(`Plain ${TAG}`, null);
  if ([onFund, onGi, plain].some((r) => r.status !== 201)) throw new Error(`class create: ${[onFund, onGi, plain].map((r) => r.status)}`);

  await page.goto("/dashboard/timetable");
  await page.waitForLoadState("networkidle");
  const open = async () => {
    await page.getByTestId("timetable-categories").click();
    await page.getByTestId("categories-sheet").waitFor();
    await page.getByTestId("categories-row").first().waitFor();
  };
  const sheet = () => page.getByTestId("categories-sheet");

  await section("B1", "the sheet lists the club's eight starting categories, each with its class count", async () => {
    await open();
    await expect(sheet().getByTestId("categories-row")).toHaveCount(8);
    await expect(sheet().getByLabel(`${fund.name} name`, { exact: true })).toHaveValue(fund.name);
    await expect(sheet().locator(`#categories-count-${fund.id}`)).toHaveText("1 class");
    await shot(page, "categories-b-sheet");
    return "8";
  });

  await section("B2", "add 'Intermediate' by keyboard: a club-made category at the end, recorded in Activity", async () => {
    const add = sheet().getByRole("button", { name: "Add a category", exact: true });
    await add.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("Intermediate");
    await page.keyboard.press("Enter");
    await expect(sheet().getByLabel("Intermediate name", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await catRows()).find((r) => r.name === "Intermediate")?.legacyKey, { timeout: 30_000 }).toBeNull();
    await expect.poll(() => audits("class_category.create"), { timeout: 30_000 }).toBe(1);
    return "added";
  });

  await section("B3", "rename Fundamentals to Beginners in place: the class on it keeps it, its own name unchanged", async () => {
    const field = sheet().getByLabel(`${fund.name} name`, { exact: true });
    await field.fill("Beginners");
    await field.press("Enter");
    await expect.poll(async () => (await catRows()).find((r) => r.id === fund.id)?.name, { timeout: 30_000 }).toBe("Beginners");
    const c = await classCat(onFund.body.id);
    expect(c).toMatchObject({ categoryId: fund.id, name: `Fundamentals Gi ${TAG}` });
    return c;
  });

  await section("B4", "move Kids up by keyboard: the new order is saved, focus stays on the control", async () => {
    const before = (await catRows()).filter((r) => !r.archivedAt).map((r) => r.id);
    const up = sheet().getByRole("button", { name: "Move Kids up", exact: true });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await catRows()).filter((r) => !r.archivedAt).map((r) => r.id).indexOf(kids.id), { timeout: 30_000 }).toBe(before.indexOf(kids.id) - 1);
    await expect(sheet().getByRole("button", { name: "Move Kids up", exact: true })).toBeFocused({ timeout: 30_000 });
    return { from: before.indexOf(kids.id), to: before.indexOf(kids.id) - 1 };
  });

  await section("B5", "archive Gi: listed under Archived, its class keeps it, the class form does not offer it for another class", async () => {
    await sheet().getByRole("button", { name: "Archive Gi", exact: true }).click();
    await expect(sheet().getByTestId("categories-archived-row").filter({ hasText: "Gi" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await catRows()).find((r) => r.id === gi.id)?.archivedAt !== null, { timeout: 30_000 }).toBe(true);
    expect((await classCat(onGi.body.id)).categoryId).toBe(gi.id);
    await page.keyboard.press("Escape");
    // The sheet refreshes the page's categories (router.refresh) without a reload: the class form must stop
    // offering Gi once that refresh lands. Opened and read again until it has, at most 20 s.
    let options = [];
    await expect.poll(async () => {
      await page.locator(`button[aria-label^="Edit Plain ${TAG}, "]:visible`).first().click();
      options = (await page.getByTestId("class-category-select").locator("option").allTextContents()).map((o) => o.trim());
      await page.keyboard.press("Escape");
      await page.getByTestId("class-category-select").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
      return options.includes("Gi");
    }, { timeout: 20_000, intervals: [500, 1000, 2000] }).toBe(false);
    expect(options).toContain("Intermediate");
    return { options };
  });

  await section("B6", "restore Gi: active again and offered", async () => {
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    await open();
    await sheet().getByRole("button", { name: "Restore Gi", exact: true }).click();
    await expect.poll(async () => (await catRows()).find((r) => r.id === gi.id)?.archivedAt, { timeout: 30_000 }).toBeNull();
    await expect(sheet().getByLabel("Gi name", { exact: true })).toBeVisible({ timeout: 30_000 });
    return "restored";
  });

  await section("B7", "a stale edit is refused: another tab renamed it meanwhile; the sheet says so and shows what is there now", async () => {
    const nogi = (await catRows()).find((r) => r.legacyKey === "nogi");
    // Another tab: a rename through the API, which bumps the version under the open sheet.
    const other = await page.evaluate(async ([id, v]) => (await fetch(`/api/class-categories/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: v, name: "No-Gi (Tue)" }) })).status, [nogi.id, nogi.version]);
    expect(other).toBe(200);
    const field = sheet().getByLabel(`${nogi.name} name`, { exact: true });
    await field.fill("Nogi");
    await field.press("Enter");
    await expect(sheet().getByTestId("categories-notice")).toContainText("changed in another tab", { timeout: 30_000 });
    await expect(sheet().getByLabel("No-Gi (Tue) name", { exact: true })).toBeVisible({ timeout: 30_000 });
    expect((await catRows()).find((r) => r.id === nogi.id)?.name).toBe("No-Gi (Tue)");
    return "refused";
  });

  await section("B8", "a forced failed save keeps the typed name and says so beside it; the retry saves it once", async () => {
    const comp = (await catRows()).find((r) => r.legacyKey === "competition");
    await page.route(`**/api/class-categories/${comp.id}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong" }) }) : r.continue()));
    const field = sheet().getByLabel(`${comp.name} name`, { exact: true });
    await field.fill("Competition Team");
    await field.press("Enter");
    await expect(sheet().locator(`#categories-error-${comp.id}`)).toBeVisible({ timeout: 30_000 });
    await expect(field).toHaveValue("Competition Team", { timeout: 30_000 });
    expect((await catRows()).find((r) => r.id === comp.id)?.name).toBe(comp.name);
    await page.unroute(`**/api/class-categories/${comp.id}`);
    let patches = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(`/api/class-categories/${comp.id}`)) patches++; });
    await field.press("Enter");
    await expect.poll(async () => (await catRows()).find((r) => r.id === comp.id)?.name, { timeout: 30_000 }).toBe("Competition Team");
    expect(patches).toBe(1);
    return { patches };
  });

  await section("B9", "a duplicate name (any capitals) is refused beside the new row", async () => {
    await sheet().getByRole("button", { name: "Add a category", exact: true }).click();
    await page.keyboard.type("intermediate");
    await page.keyboard.press("Enter");
    await expect(sheet().locator("#categories-error-new")).toContainText("already have a category", { timeout: 30_000 });
    expect((await catRows()).filter((r) => r.name.toLowerCase() === "intermediate")).toHaveLength(1);
    await page.keyboard.press("Escape");
    return "refused";
  });

  await section("B12", "an editor left open: another tab gives the class a category; this form's change is refused beside the buttons and theirs is kept", async () => {
    const intermediate = (await catRows()).find((r) => r.name === "Intermediate");
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    await page.locator(`button[aria-label^="Edit Plain ${TAG}, "]:visible`).first().click();
    const select = page.getByTestId("class-category-select");
    await select.waitFor();
    // Another tab, after this form opened on an uncategorised class.
    const other = await page.evaluate(async ([id, c]) => (await fetch(`/api/classes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryId: c, categoryBaseId: null }) })).status, [plain.body.id, intermediate.id]);
    expect(other).toBe(200);
    const bodies = [];
    const listen = (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${plain.body.id}`) bodies.push(r.postDataJSON()); };
    page.on("request", listen);
    await select.selectOption(`id:${kids.id}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("class-form-save-error")).toHaveText("Someone else changed this class's category since you opened it. Reload the page and choose again.", { timeout: 30_000 });
    page.off("request", listen);
    expect(await select.inputValue()).toBe(`id:${kids.id}`);
    expect((await classCat(plain.body.id)).categoryId).toBe(intermediate.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ categoryId: kids.id, categoryBaseId: null });
    await page.keyboard.press("Escape");
    return bodies[0];
  });

  // ── B3-1: reorder and rename, one admin and two, a held request and a lost response ──
  const manager = await seedStaff(club, "manager");
  const mc = await context(browser, "10.96.6.4", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const mp = await mc.newPage();
  await staffSignIn(mp, club, manager);
  const activeNames = async () => (await catRows()).filter((r) => !r.archivedAt).map((r) => r.name);
  const shownNames = async () => (await sheet().getByTestId("categories-row").locator("input").evaluateAll((els) => els.map((e) => e.value)));
  const reopen = async () => {
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    await open();
  };
  // The reorder reaches the server at once (it is saved), and its answer is held back: the window in which another
  // admin can change a category after the reorder landed but before this sheet hears of it (B3-1).
  const hold = (ms) => page.route("**/api/class-categories/order", async (r) => { const resp = await r.fetch(); await new Promise((res) => setTimeout(res, ms)); await r.fulfill({ response: resp }); });
  const release = () => page.unroute("**/api/class-categories/order");

  await section("B13", "reorder then rename at once, the reorder's answer held 6 s: both land, nothing refused", async () => {
    await reopen();
    const names = await activeNames();
    const x = names[1];
    await hold(6000);
    await sheet().getByRole("button", { name: `Move ${x} down`, exact: true }).click();
    const field = sheet().getByLabel(`${x} name`, { exact: true });
    await field.fill(`${x} (B13)`);
    await field.press("Enter");
    await expect.poll(async () => (await catRows()).find((r) => r.name === `${x} (B13)`) !== undefined, { timeout: 60_000 }).toBe(true);
    await release();
    const after = await activeNames();
    expect(after.indexOf(`${x} (B13)`)).toBe(2);
    await expect(sheet().getByTestId("categories-notice")).toHaveCount(0);
    return after;
  });

  await section("B14", "two admins: the owner's rename waits behind a reorder whose answer is held while the manager renames the same category; the owner's is refused and the manager's kept", async () => {
    await reopen();
    const names = await activeNames();
    const y = names[0];
    const z = names[3];
    await hold(15000);
    await sheet().getByRole("button", { name: `Move ${y} down`, exact: true }).click();
    const field = sheet().getByLabel(`${z} name`, { exact: true });
    await field.fill(`${z} (owner)`);
    await field.press("Enter");
    // Once the reorder is saved (its answer still held), the manager, in their own session, renames the same category
    // while the owner's rename waits behind it.
    await expect.poll(async () => (await activeNames())[1], { timeout: 30_000 }).toBe(y);
    const row = (await catRows()).find((r) => r.name === z);
    const managerSave = await mp.evaluate(async ([id, v, n]) => (await fetch(`/api/class-categories/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: v, name: n }) })).status, [row.id, row.version, `${z} (manager)`]);
    expect(managerSave).toBe(200);
    await expect(sheet().getByTestId("categories-notice")).toContainText("changed in another tab", { timeout: 60_000 });
    await release();
    const stored = (await catRows()).find((r) => r.id === row.id);
    expect(stored.name).toBe(`${z} (manager)`);
    await expect(sheet().getByLabel(`${z} (manager) name`, { exact: true })).toBeVisible({ timeout: 30_000 });
    return { stored: stored.name };
  });

  await section("B15", "a lost response: the reorder reaches the server, its answer is dropped; the sheet says so and shows the saved order; a retry and a rename then land", async () => {
    await reopen();
    const before = await activeNames();
    const w = before[4];
    let reached = 0;
    await page.route("**/api/class-categories/order", async (r) => { reached++; await r.fetch(); await r.abort("failed"); });
    await sheet().getByRole("button", { name: `Move ${w} down`, exact: true }).click();
    await expect(sheet().getByTestId("categories-notice")).toContainText("Couldn't confirm that move", { timeout: 60_000 });
    await page.unroute("**/api/class-categories/order");
    expect(reached).toBe(1);
    const saved = await activeNames();
    expect(saved.indexOf(w)).toBe(5);
    await expect.poll(shownNames, { timeout: 30_000 }).toEqual(saved);
    // The retry: one more step, exactly.
    await sheet().getByRole("button", { name: `Move ${w} down`, exact: true }).click();
    await expect.poll(async () => (await activeNames()).indexOf(w), { timeout: 60_000 }).toBe(6);
    // A rename begun after the reload carries what was on screen: it lands. Every category write's answer is kept,
    // so a failure says what the server said.
    const answers = [];
    const onAnswer = async (resp) => { if (resp.url().includes("/api/class-categories/") && resp.request().method() !== "GET") answers.push({ method: resp.request().method(), status: resp.status(), body: (await resp.text().catch(() => "")).slice(0, 300) }); };
    page.on("response", onAnswer);
    const renamed = `B15 ${TAG}`;
    const field = sheet().getByLabel(`${w} name`, { exact: true });
    await field.fill(renamed);
    await field.press("Enter");
    try {
      await expect.poll(async () => (await activeNames()).includes(renamed), { timeout: 60_000 }).toBe(true);
    } catch (e) {
      throw new Error(`rename did not land; answers ${JSON.stringify(answers)}; notice ${JSON.stringify(await sheet().getByTestId("categories-notice").textContent().catch(() => null))}; names ${JSON.stringify(await activeNames())}`);
    } finally {
      page.off("response", onAnswer);
    }
    await expect.poll(shownNames, { timeout: 30_000 }).toEqual(await activeNames());
    return await activeNames();
  });
  await mc.close();

  await section("B10", "phone 390 px: the sheet opens and nothing scrolls sideways", async () => {
    const ph = await context(browser, "10.96.6.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
    const pp = await ph.newPage();
    pp.on("pageerror", (e) => errors.push(e.message));
    await ownerSignIn(pp, club);
    await pp.goto("/dashboard/timetable");
    await pp.getByTestId("timetable-categories").click();
    await pp.getByTestId("categories-row").first().waitFor();
    const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    expect(m.scroll).toBeLessThanOrEqual(m.width + 1);
    await shot(pp, "categories-b-phone");
    await ph.close();
    return m;
  });

  await section("B11", "a coach has no Categories button", async () => {
    const coach = await seedStaff(club, "coach");
    const cc = await context(browser, "10.96.6.3", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
    const cp = await cc.newPage();
    await staffSignIn(cp, club, coach);
    await cp.goto("/dashboard/timetable");
    await cp.waitForLoadState("networkidle");
    await expect(cp.getByTestId("timetable-categories")).toHaveCount(0);
    await cc.close();
    return "hidden";
  });

  L.check("errors", "no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
