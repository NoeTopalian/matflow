// Journey: Round 11 slice 2 (baseline 6.1) — an unsaved class form is not thrown away by one stray tap or Escape.
// Owner, desktop 1440 (mouse + keyboard) and phone 390 (touch): a clean form closes at once; with a name typed, a
// click on the page behind the sheet, Escape and the close button each ask "Discard your changes?". "Keep editing"
// keeps the text; "Discard changes" closes and nothing is saved. No request is involved, so there is no forced
// network failure here: the saves' own refusal paths are covered by timetable-lost-update and classes-lifecycle.
// Needs `fixture.mjs create` and `server.mjs start`. Creates nothing (it checks that).
//   node journeys/round11-discard-guard.mjs
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, BASE } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { devices } = require("@playwright/test");

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-discard-guard");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];

const question = (page) => page.getByRole("dialog", { name: "Discard your changes?" });
const classSheet = (page) => page.getByRole("dialog", { name: "New class" });
const nameBox = (page) => classSheet(page).getByRole("textbox", { name: "Class Name" });
const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
const isOpen = (loc) => loc.isVisible().catch(() => false);

async function openAdd(page) {
  await page.getByRole("button", { name: "Add class" }).filter({ visible: true }).first().click();
  await classSheet(page).waitFor({ timeout: 30000 });
}

const browser = await chromium.launch();
try {
  // ── Desktop: mouse and keyboard ──
  {
    const ctx = await context(browser, "10.98.0.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(page, club);
    await page.goto("/dashboard/timetable");
    await page.getByRole("button", { name: "Add class" }).filter({ visible: true }).first().waitFor({ timeout: 90000 });

    await openAdd(page);
    await page.mouse.click(200, 450); // the timetable behind the 480 px sheet: the scrim
    const cleanClosed = await classSheet(page).waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    L.check("desktop", "D1 a clean form closes at once on a click behind the sheet (no question)", cleanClosed && !(await isOpen(question(page))), { cleanClosed });

    await openAdd(page);
    const typed = `Discard probe ${TAG}`;
    await nameBox(page).fill(typed);
    await page.mouse.click(200, 450);
    const asked = await question(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
    const focus = await focusedText(page);
    L.check("desktop", "D2 with a name typed, a click behind the sheet asks 'Discard your changes?' (focus on Keep editing)", asked && focus === "Keep editing", { asked, focus });
    await shot(page, "r11b-desktop-question");
    await question(page).getByRole("button", { name: "Keep editing" }).click();
    const kept = await nameBox(page).inputValue().catch(() => null);
    await page.waitForTimeout(200);
    const focusInSheet = await classSheet(page).evaluate((el) => el.contains(document.activeElement));
    L.check("desktop", "D3 Keep editing returns to the form with the name still there and focus inside it", !(await isOpen(question(page))) && kept === typed && focusInSheet, { kept, focusInSheet });

    await page.keyboard.press("Escape");
    const kAsked = await question(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const kKept = (await isOpen(classSheet(page))) && !(await isOpen(question(page))) && (await nameBox(page).inputValue()) === typed;
    L.check("desktop", "K1 Escape asks; a second Escape answers the question and leaves the form as it was", kAsked && kKept, { kAsked, kKept });

    await classSheet(page).getByRole("button", { name: "Close", exact: true }).click();
    await question(page).waitFor({ timeout: 10000 });
    await page.keyboard.press("Tab");
    const onDiscard = await focusedText(page);
    await page.keyboard.press("Enter");
    const discarded = await classSheet(page).waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    L.check("desktop", "K2 the close button asks; Tab to 'Discard changes' and Enter closes the form", onDiscard === "Discard changes" && discarded, { onDiscard, discarded });

    await openAdd(page);
    const fresh = await nameBox(page).inputValue();
    L.check("desktop", "D4 reopening after Discard starts a clean form", fresh === "", { fresh });
    await classSheet(page).getByRole("button", { name: "Close", exact: true }).click();
    await classSheet(page).waitFor({ state: "detached", timeout: 10000 });

    // ── Pause / Archive from the class sheet with an unsaved edit ──
    const cls = randomUUID(), CLS = `Pause probe ${TAG}`;
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 20)`, [cls, tenantId, CLS]);
    await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, 1, '18:00', '19:00')`, [randomUUID(), cls]);
    await page.reload();
    const edit = page.getByRole("button", { name: `Edit ${CLS}` }).filter({ visible: true }).first();
    await edit.click({ timeout: 90000 });
    const editSheet = page.getByRole("dialog", { name: "Edit class" });
    const editName = editSheet.getByRole("textbox", { name: "Class Name" });
    await editName.fill(`${CLS} renamed`);
    await editSheet.getByRole("button", { name: "Pause class" }).click();
    const pq = page.getByRole("dialog", { name: `Pause ${CLS}?` });
    const pqText = (await pq.textContent({ timeout: 15000 }).catch(() => "")) ?? "";
    await shot(page, "r11b-pause-with-edits");
    await pq.getByRole("button", { name: "Cancel" }).click();
    await pq.waitFor({ state: "detached", timeout: 10000 });
    const keptName = await editName.inputValue().catch(() => null);
    const stillActive = (await q(`select "isActive" from "Class" where id = $1`, [cls]))[0].isActive === true;
    L.check("desktop", "PA1 Pause from the sheet with an edit asks that the edits will be discarded; Cancel keeps the sheet, the edit and the class",
      pqText.includes("Your unsaved changes to this class will be discarded, not saved.") && keptName === `${CLS} renamed` && stillActive, { pqText: pqText.slice(0, 200), keptName, stillActive });

    // A pause that fails keeps the sheet and the edit.
    await page.route(`**/api/classes/${cls}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not pause the class right now." }) }) : route.continue()));
    await editSheet.getByRole("button", { name: "Pause class" }).click();
    await page.getByRole("dialog", { name: `Pause ${CLS}?` }).getByRole("button", { name: "Discard changes and pause" }).click();
    const toldFail = await page.getByText("Could not pause the class right now.").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    const keptAfterFail = (await editSheet.isVisible()) && (await editName.inputValue().catch(() => null)) === `${CLS} renamed`;
    L.check("desktop", "PA2 a failed pause says so and keeps the sheet with the edit", toldFail && keptAfterFail, { toldFail, keptAfterFail });
    await page.unroute(`**/api/classes/${cls}`);

    // While the class save is in flight, Pause and Archive are off.
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(`**/api/classes/${cls}`, async (route) => { if (route.request().method() === "PUT" || route.request().method() === "PATCH") { await held; } return route.continue(); });
    await editSheet.getByRole("button", { name: "Save changes" }).click();
    await page.waitForTimeout(500);
    const pauseOff = await editSheet.getByRole("button", { name: "Pause class" }).isDisabled();
    const archiveOff = await editSheet.getByRole("button", { name: "Archive class" }).isDisabled();
    release();
    await page.unroute(`**/api/classes/${cls}`);
    L.check("desktop", "PA3 while the class save is in flight, Pause and Archive in the sheet are disabled", pauseOff && archiveOff, { pauseOff, archiveOff });
    await editSheet.waitFor({ state: "detached", timeout: 30000 }).catch(() => {});

    // Confirmed: the class is paused and the edit is NOT saved (the save above stored the rename; edit again to test).
    await page.reload();
    await page.getByRole("button", { name: `Edit ${CLS} renamed` }).filter({ visible: true }).first().click({ timeout: 90000 });
    await editName.fill(`${CLS} second edit`);
    await editSheet.getByRole("button", { name: "Pause class" }).click();
    await page.getByRole("dialog", { name: `Pause ${CLS} renamed?` }).getByRole("button", { name: "Discard changes and pause" }).click();
    const closed = await editSheet.waitFor({ state: "detached", timeout: 30000 }).then(() => true, () => false);
    const row = (await q(`select name, "isActive" from "Class" where id = $1`, [cls]))[0];
    L.check("desktop", "PA4 confirmed: the class is paused, the sheet closes, and the unsaved edit was not saved", closed && row.isActive === false && row.name === `${CLS} renamed`, { closed, row });
    await q(`delete from "ClassInstance" where "classId" = $1`, [cls]).catch(() => {});
    await q(`delete from "ClassSchedule" where "classId" = $1`, [cls]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [cls, tenantId]).catch(() => {});
    await ctx.close();
  }

  // ── Phone: touch ──
  {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": "10.98.0.2" }, serviceWorkers: "block" });
    ctx.setDefaultTimeout(60000);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(page, club);
    await page.goto("/dashboard/timetable");
    await page.getByRole("button", { name: "Add class" }).filter({ visible: true }).first().waitFor({ timeout: 90000 });
    await openAdd(page);
    const typed = `Phone probe ${TAG}`;
    await nameBox(page).fill(typed);
    await page.touchscreen.tap(195, 12); // above the bottom sheet: the scrim
    const asked = await question(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
    await shot(page, "r11b-phone-question");
    const btn = question(page).getByRole("button", { name: "Keep editing" });
    const box = asked ? await btn.boundingBox() : null;
    await btn.tap();
    const closedQ = await question(page).waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    const kept = await nameBox(page).inputValue().catch(() => null);
    L.check("phone", "P1 a tap above the sheet asks; Keep editing closes the question and keeps the typed name", asked && closedQ && kept === typed, { asked, closedQ, kept });
    L.check("phone", "P2 the question's buttons are at least 44 px tall", !!box && box.height >= 44, { box });
    await ctx.close();
  }

  const saved = await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name like $2`, [tenantId, `%probe ${TAG}%`]);
  L.check("journey", "J1 nothing was saved: no class with a probe name exists", saved[0].n === 0, { n: saved[0].n });
  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  // Defensive: if a probe class was ever saved, remove it.
  await q(`delete from "Class" where "tenantId" = $1 and name like $2`, [tenantId, `%probe ${TAG}%`]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
