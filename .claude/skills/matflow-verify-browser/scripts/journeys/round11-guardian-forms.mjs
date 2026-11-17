// Journey: Round 11 (baseline 5.4 + 5.2) — a guardian's half-filled child forms are not lost to one stray tap.
// A synthetic parent with one confirmed child, phone width (390, touch). Edit child (profile → Actions → Edit): titled
// with the child's name, focus on the name; with the name changed, a tap on the backdrop asks "Discard your changes?",
// Keep editing keeps the text, Escape asks and Discard closes with nothing saved. Child waiver (family page → Sign
// waiver): Escape closes it untouched; with a name typed the backdrop asks, Keep editing keeps it, × then Discard
// closes and nothing is signed. No request is involved in these closes, so there is no forced network failure here.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-guardian-forms.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-guardian-forms");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];
const PARENT = `Guardian F ${TAG}`, CHILD = `Mia F ${TAG}`;
const email = (k) => `${club.slug}-${k}-${TAG}@example.test`.toLowerCase();

const parentId = randomUUID(), childId = randomUUID();
await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "onboardingCompleted", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'parent', true, true, now())`, [parentId, tenantId, email("parent"), PARENT]);
await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'kids', $5, now(), 'staff', false, now())`, [childId, tenantId, email("child"), CHILD, parentId]);
const childRow = async () => (await q(`select name, "waiverAccepted" from "Member" where id = $1 and "tenantId" = $2`, [childId, tenantId]))[0];

const question = (page) => page.getByRole("dialog", { name: "Discard your changes?" });
const asked = (page) => question(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
const gone = (loc) => loc.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.98.3.1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(page, club, await memberLogin(club, PARENT));

  // ── Edit child ──
  await page.goto("/member/profile");
  await page.getByRole("button", { name: `Actions for ${CHILD}` }).tap({ timeout: 60000 });
  await page.getByRole("button", { name: "Edit", exact: true }).tap();
  const edit = page.getByRole("dialog", { name: `Edit ${CHILD}` });
  const titled = await edit.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const nameBox = edit.getByLabel("Name", { exact: true });
  const focused = titled ? await nameBox.evaluate((el) => el === document.activeElement) : false;
  L.check("edit", "E1 Edit child is titled with the child's name and opens on the name field", titled && focused, { titled, focused });
  await nameBox.fill(`${CHILD} Smith`);
  await page.touchscreen.tap(195, 40); // the backdrop above the bottom sheet
  const e2asked = await asked(page);
  await shot(page, "r11-edit-child-question");
  await question(page).getByRole("button", { name: "Keep editing" }).tap();
  const kept = await nameBox.inputValue().catch(() => null);
  L.check("edit", "E2 with the name changed, a backdrop tap asks; Keep editing keeps the text", e2asked && kept === `${CHILD} Smith`, { e2asked, kept });
  await page.keyboard.press("Escape");
  const e3asked = await asked(page);
  await question(page).getByRole("button", { name: "Discard changes" }).tap();
  const closed = await gone(edit);
  L.check("edit", "E3 Escape asks; Discard changes closes the form and nothing is saved", e3asked && closed && (await childRow()).name === CHILD, { e3asked, closed, stored: (await childRow()).name });

  // ── Child waiver ──
  await page.goto(`/member/family/${childId}`);
  const signBtn = page.getByRole("button", { name: /Sign waiver/ }).first();
  await signBtn.tap({ timeout: 60000 });
  const waiver = page.getByRole("dialog", { name: `Sign waiver — ${CHILD}` });
  await waiver.waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");
  const escClosed = await gone(waiver);
  L.check("waiver", "W1 Escape closes an untouched waiver (it had no Escape before)", escClosed, { escClosed });
  await signBtn.tap();
  await waiver.waitFor({ timeout: 15000 });
  await waiver.getByLabel("Your name").fill("Ana Guardian");
  await page.touchscreen.tap(195, 20);
  const w2asked = await asked(page);
  await question(page).getByRole("button", { name: "Keep editing" }).tap();
  const wKept = await waiver.getByLabel("Your name").inputValue().catch(() => null);
  L.check("waiver", "W2 with a name typed, a backdrop tap asks; Keep editing keeps the waiver and the name", w2asked && wKept === "Ana Guardian", { w2asked, wKept });
  await waiver.getByRole("button", { name: "Close" }).tap();
  const w3asked = await asked(page);
  await question(page).getByRole("button", { name: "Discard changes" }).tap();
  const wClosed = await gone(waiver);
  L.check("waiver", "W3 the close button asks; Discard closes and nothing is signed", w3asked && wClosed && (await childRow()).waiverAccepted === false, { w3asked, wClosed });
  await ctx.close();

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, [childId, parentId]]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
