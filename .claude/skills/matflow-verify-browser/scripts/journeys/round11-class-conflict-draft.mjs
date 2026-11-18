// Journey: Round 11 (baseline 1.1) — a class save refused because someone else changed the class keeps the draft
// through Reload. Depends on PR #92 (stale_class refusal). Owner A edits a synthetic class's name; owner B (another
// browser) saves a new name and description for it; A's save is refused with Reload; after Reload the class's sheet
// reopens with A's name on top of B's description and says so; a forced failed save keeps the form; the retry stores
// A's name and B's description. Desktop (mouse) and phone (touch).
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-class-conflict-draft.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-class-conflict-draft");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];
const ids = [];

const row = async (id) => (await q(`select name, description from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0];

async function walk(where, pageA, pageB, tap) {
  const id = randomUUID(), NAME = `Conflict ${where} ${TAG}`;
  ids.push(id);
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 20)`, [id, tenantId, NAME]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, 2, '19:00', '20:00')`, [randomUUID(), id]);
  const press = (loc) => (tap ? loc.tap() : loc.click());

  await pageA.goto("/dashboard/timetable");
  await press(pageA.getByRole("button", { name: `Edit ${NAME}` }).filter({ visible: true }).first());
  const sheet = pageA.getByRole("dialog", { name: "Edit class" });
  const nameBox = sheet.getByLabel("Class Name");
  const mine = `${NAME} (mine)`;
  await nameBox.fill(mine);

  // B saves a new name and a description through the real API, as another person would.
  await pageB.goto("/dashboard/timetable");
  const bStatus = await pageB.evaluate(async ({ id, name }) => {
    const r = await fetch(`/api/classes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${name} (theirs)`, description: "Their description" }) });
    return r.status;
  }, { id, name: NAME });
  L.check(where, "C0 the other person's save is accepted", bStatus === 200, { bStatus });

  await press(sheet.getByRole("button", { name: "Save changes" }));
  const refused = await sheet.getByRole("alert").filter({ hasText: "Someone changed this class" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  const keeps = (await sheet.getByTestId("class-form-reload-keeps").textContent().catch(() => null))?.trim();
  L.check(where, "C1 the save is refused (stale_class) with Reload, and says Reload keeps what was changed", refused && keeps === "Reload keeps what you've changed here.", { refused, keeps });
  await shot(pageA, `r11-class-conflict-refused-${where}`);

  await press(sheet.getByRole("button", { name: "Reload", exact: true }));
  await pageA.waitForLoadState("load");
  const note = pageA.getByTestId("class-draft-restored");
  const noted = await note.waitFor({ timeout: 60000 }).then(() => true, () => false);
  const restored = await pageA.getByRole("dialog", { name: "Edit class" }).getByLabel("Class Name").inputValue().catch(() => null);
  const theirDesc = await pageA.getByRole("dialog", { name: "Edit class" }).getByLabel(/Description/).inputValue().catch(() => null);
  L.check(where, "C2 after Reload the class reopens with my name on top of their description, and the note says so",
    noted && restored === mine && theirDesc === "Their description", { noted, note: noted ? await note.textContent() : null, restored, theirDesc });
  await shot(pageA, `r11-class-conflict-restored-${where}`);

  const sheet2 = pageA.getByRole("dialog", { name: "Edit class" });
  let aborted = 0;
  await pageA.route(`**/api/classes/${id}`, (route) => (route.request().method() === "PATCH" && aborted++ === 0 ? route.abort("failed") : route.continue()));
  const dropped = pageA.waitForEvent("requestfailed", { predicate: (r) => r.method() === "PATCH" && r.url().endsWith(`/api/classes/${id}`), timeout: 30000 }).then(() => true, () => false);
  await press(sheet2.getByRole("button", { name: "Save changes" }));
  const sawDrop = await dropped;
  await pageA.waitForTimeout(500);
  const keptAfterFail = (await sheet2.isVisible()) && (await sheet2.getByLabel("Class Name").inputValue().catch(() => null)) === mine;
  L.check(where, "F1 a dropped save (request seen to fail) keeps the sheet and the restored name", sawDrop && keptAfterFail, { sawDrop, keptAfterFail });
  await pageA.unroute(`**/api/classes/${id}`);
  const saved = pageA.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/classes/${id}`));
  await press(sheet2.getByRole("button", { name: "Save changes" }));
  const res = await saved;
  await pageA.waitForTimeout(800);
  const stored = await row(id);
  L.check(where, "C3 the retry saves, and the stored class has my name AND their description", res.status() === 200 && stored.name === mine && stored.description === "Their description", { status: res.status(), stored });
}

const browser = await chromium.launch();
try {
  {
    const a = await context(browser, "10.98.7.1"), b = await context(browser, "10.98.7.2");
    const pageA = await a.newPage(), pageB = await b.newPage();
    for (const p of [pageA, pageB]) p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(pageA, club); await ownerSignIn(pageB, club);
    await walk("desktop", pageA, pageB, false);
    await a.close(); await b.close();
  }
  {
    const a = await context(browser, "10.98.7.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const b = await context(browser, "10.98.7.4");
    const pageA = await a.newPage(), pageB = await b.newPage();
    for (const p of [pageA, pageB]) p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(pageA, club); await ownerSignIn(pageB, club);
    await walk("phone", pageA, pageB, true);
    await a.close(); await b.close();
  }
  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  for (const id of ids) {
    await q(`delete from "ClassInstance" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "ClassSchedule" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch(() => {});
  }
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
