// Journey: Round 11 (baseline 3.2) — a conflict reload on the staff member profile keeps what was typed.
// Owner A opens a synthetic member's profile and changes the name. Owner B (another browser) saves a new phone number
// for the same member. A presses Save: refused ("Someone else changed this member…") with a Reload button. Reload: the
// form reopens with A's new name on top of B's phone, and says so. A forced failed save keeps the form; the retry saves
// once and the stored row has BOTH changes. Desktop 1440 (mouse + keyboard) and phone 390 (touch).
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-member-conflict-draft.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-member-conflict-draft");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];
const ids = [];

async function seedMember(key) {
  const id = randomUUID();
  await q(`insert into "Member" (id, "tenantId", email, name, "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, true, now())`,
    [id, tenantId, `${club.slug}-${key}-${TAG}@example.test`.toLowerCase(), `Conflict ${key} ${TAG}`]);
  ids.push(id);
  return { id, name: `Conflict ${key} ${TAG}` };
}
const row = async (id) => (await q(`select name, phone from "Member" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0];

/** Owner B saves a phone number for the member through the real API, as another person would. */
async function otherPersonSavesPhone(pageB, member, phone) {
  await pageB.goto(`/dashboard/members/${member.id}`);
  return pageB.evaluate(async ({ id, phone }) => {
    const cur = await (await fetch(`/api/members/${id}`)).json();
    const r = await fetch(`/api/members/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ updatedAt: cur.updatedAt, phone }) });
    return r.status;
  }, { id: member.id, phone });
}

async function walk(where, pageA, pageB, { tap }) {
  const m = await seedMember(where);
  const newName = `${m.name} Renamed`;
  const phone = where === "desktop" ? "07700 900123" : "07700 900456";
  await pageA.goto(`/dashboard/members/${m.id}`);
  const edit = pageA.getByRole("button", { name: "Edit", exact: true }).first();
  await edit.waitFor({ timeout: 90000 });
  await (tap ? edit.tap() : edit.click());
  const nameBox = pageA.getByLabel("Full Name", { exact: true });
  await nameBox.fill(newName);

  const status = await otherPersonSavesPhone(pageB, m, phone);
  L.check(where, "C0 the other person's phone save is accepted", status === 200, { status });

  const save = pageA.getByRole("button", { name: "Save", exact: true });
  await (tap ? save.tap() : save.click());
  const refusal = pageA.getByRole("alert").filter({ hasText: "Someone else changed this member" });
  const refused = await refusal.waitFor({ timeout: 20000 }).then(() => true, () => false);
  const reload = pageA.getByRole("button", { name: "Reload", exact: true });
  const box = await reload.boundingBox().catch(() => null);
  const vh = pageA.viewportSize().height;
  L.check(where, "C1 the save is refused with the conflict sentence and a Reload button on screen", refused && !!box && box.y >= 0 && box.y + box.height <= vh, { refused, box, vh });
  await shot(pageA, `r11-conflict-refused-${where}`);

  await (tap ? reload.tap() : reload.click());
  await pageA.waitForLoadState("load");
  const note = pageA.getByTestId("profile-draft-restored");
  const noted = await note.waitFor({ timeout: 60000 }).then(() => true, () => false);
  const restoredName = await pageA.getByLabel("Full Name", { exact: true }).inputValue().catch(() => null);
  const freshPhone = await pageA.getByLabel("Phone", { exact: true }).inputValue().catch(() => null);
  L.check(where, "C2 after Reload: my new name is back, their phone is shown, and the note says so",
    noted && restoredName === newName && freshPhone === phone, { noted, note: noted ? await note.textContent() : null, restoredName, freshPhone });
  await shot(pageA, `r11-conflict-restored-${where}`);

  // Forced failed save, then a real retry. The sentence is matched, not "any alert": Next's route announcer is one.
  let aborted = 0;
  await pageA.route(`**/api/members/${m.id}`, (route) => (route.request().method() === "PATCH" && aborted++ === 0 ? route.abort("failed") : route.continue()));
  const dropped = pageA.waitForEvent("requestfailed", { predicate: (r) => r.method() === "PATCH" && r.url().endsWith(`/api/members/${m.id}`), timeout: 30000 }).then(() => true, () => false);
  await (tap ? save.tap() : save.click());
  const sawDrop = await dropped;
  const failed = sawDrop && await pageA.getByRole("alert").filter({ hasText: "Couldn't reach MatFlow" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  const keptAfterFail = await pageA.getByLabel("Full Name", { exact: true }).inputValue().catch(() => null);
  L.check(where, "F1 a dropped save (request seen to fail) says so and keeps the form", failed && keptAfterFail === newName, { sawDrop, failed, keptAfterFail });
  await pageA.unroute(`**/api/members/${m.id}`);
  let patchesSent = 0;
  pageA.on("request", (r) => { if (r.method() === "PATCH" && r.url().endsWith(`/api/members/${m.id}`)) patchesSent++; });
  const saved = pageA.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/members/${m.id}`));
  await (tap ? save.tap() : save.click());
  const res = await saved;
  await pageA.waitForTimeout(1000);
  const stored = await row(m.id);
  L.check(where, "C3 the retry sends one save, and the stored member has my name AND their phone", res.status() === 200 && patchesSent === 1 && stored.name === newName && stored.phone === phone, { status: res.status(), patchesSent, stored });
}

const browser = await chromium.launch();
try {
  {
    const a = await context(browser, "10.98.5.1"), b = await context(browser, "10.98.5.2");
    const pageA = await a.newPage(), pageB = await b.newPage();
    for (const p of [pageA, pageB]) p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(pageA, club); await ownerSignIn(pageB, club);
    await walk("desktop", pageA, pageB, { tap: false });
    await a.close(); await b.close();
  }
  {
    const a = await context(browser, "10.98.5.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const b = await context(browser, "10.98.5.4");
    const pageA = await a.newPage(), pageB = await b.newPage();
    for (const p of [pageA, pageB]) p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(pageA, club); await ownerSignIn(pageB, club);
    await walk("phone", pageA, pageB, { tap: true });
    await a.close(); await b.close();
  }
  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, ids]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
