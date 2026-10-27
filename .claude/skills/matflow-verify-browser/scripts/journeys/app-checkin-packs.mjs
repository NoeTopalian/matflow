// Journey: the club's app check-in setting (G5) and class packs that never expire (G6), 27 Oct 2026.
// The owner finds "Members can check themselves in from the app" ON by default, turns it off (keyboard, a forced failed
// save first), and the member's home loses "Sign In to Class" while the server refuses the member's own check-in; the
// desk still checks the member in. Turned back on, the member sees the button again. A pack with no expiry reads
// "N classes left" with no date. Desktop and 390 px.
//   node journeys/app-checkin-packs.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, bcrypt } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("app-checkin-packs");
const tenantId = club.tenantId;
const errors = [];
const LABEL = "Members can check themselves in from the app";
const REFUSAL = "Check-ins from the app are turned off at this club. Please check in at the desk or the kiosk.";
// The switch lives in Settings → Waiver → Check-in Window, beside the check-in window it governs, and asks for
// confirmation (ConfirmDialog with the registry's impact preview) before it saves.
const SETTINGS_URL = "/dashboard/settings?tab=waiver";
async function confirmDialog(page, label) {
  const b = page.getByRole("button", { name: label, exact: true }).filter({ visible: true }).last();
  await b.waitFor({ timeout: 15000 });
  await b.focus();
  await page.keyboard.press("Enter");
}
const setting = async () => (await q(`select "memberAppCheckin" as v from "Tenant" where id = $1`, [tenantId]))[0]?.v;

// ── Seed: a member with a password, a class with a session today, and a pack with no expiry ──
const member = (await q(`select id, name, email from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const memberPassword = `Mfv-${randomUUID().slice(0, 12)}-aa1`;
await q(`update "Member" set "waiverAccepted" = true, "passwordHash" = $3 where id = $1 and "tenantId" = $2`, [member.id, tenantId, await bcrypt.hash(memberPassword, 10)]);
const cls = randomUUID(); const inst = randomUUID();
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'App Check-in Class', 60, 50)`, [cls, tenantId]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '00:00', '23:59')`, [inst, cls, today]);
const pack = randomUUID(); const memberPack = randomUUID();
await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "isActive", "updatedAt") values ($1, $2, 'Ten Pack', 10, null, 8000, true, now())`, [pack, tenantId]);
await q(`insert into "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", status) values ($1, $2, $3, $4, 6, null, 'active')`, [memberPack, tenantId, member.id, pack]);
const attended = async () => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "memberId" = $1 and "classInstanceId" = $2`, [member.id, inst]))[0].n);

const browser = await chromium.launch();
try {
  // ── Owner: the setting, ON by default ──
  const octx = await context(browser, "10.98.0.1");
  const owner = await octx.newPage();
  owner.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(owner, club);
  await owner.goto(SETTINGS_URL);
  const sw = owner.getByRole("switch", { name: LABEL }).filter({ visible: true }).first();
  await sw.waitFor({ timeout: 60000 });
  L.check("settings", "S1 the switch is shown and ON for a club that never set it", (await sw.getAttribute("aria-checked")) === "true" && (await setting()) === true, { aria: await sw.getAttribute("aria-checked"), db: await setting() });

  // Forced failed save: the switch keeps its value, an error shows, nothing saved.
  await owner.route("**/api/settings", (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await sw.focus();
  await owner.keyboard.press("Space");
  await confirmDialog(owner, "Turn off");
  await owner.getByRole("alert").filter({ visible: true }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const alertText = await owner.getByRole("alert").filter({ visible: true }).first().innerText().catch(() => "");
  L.check("settings", "S2 a failed save shows an error beside the switch, keeps it ON, and saves nothing",
    /couldn|try again|error/i.test(alertText) && (await sw.getAttribute("aria-checked")) === "true" && (await setting()) === true,
    { alertText, aria: await sw.getAttribute("aria-checked"), db: await setting() });
  await owner.unroute("**/api/settings");

  // Keyboard: Space turns it off; one PATCH; persisted.
  let patches = 0;
  owner.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === "/api/settings") patches++; });
  await sw.focus();
  const focusVisible = await sw.evaluate((el) => { const s = getComputedStyle(el); return s.outlineStyle !== "none" || s.boxShadow !== "none"; });
  L.check("keyboard", "K1 the switch takes keyboard focus with a visible indicator", focusVisible, { focusVisible });
  await owner.keyboard.press("Space");
  const nothingBeforeConfirm = patches === 0;
  await confirmDialog(owner, "Turn off");
  await owner.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings", { timeout: 30000 });
  await owner.waitForTimeout(500);
  L.check("settings", "S3a Space opens the confirmation; nothing is saved before it is confirmed", nothingBeforeConfirm, { nothingBeforeConfirm });
  L.check("settings", "S3 Space then Enter on \"Turn off\" turns it off: one save, the database reads OFF", patches === 1 && (await setting()) === false, { patches, db: await setting() });
  await owner.reload();
  const sw2 = owner.getByRole("switch", { name: LABEL }).filter({ visible: true }).first();
  await sw2.waitFor({ timeout: 60000 });
  L.check("settings", "S4 after a reload the switch still reads OFF", (await sw2.getAttribute("aria-checked")) === "false", await sw2.getAttribute("aria-checked"));
  const audit = (await q(`select metadata::text as m from "AuditLog" where "tenantId" = $1 and metadata::text like '%memberAppCheckin%' order by "createdAt" desc limit 1`, [tenantId]))[0];
  L.check("settings", "S5 the change is in the audit log", !!audit, audit ? audit.m.slice(0, 200) : null);
  await shot(owner, "app-checkin-settings-off");

  // ── Member, with the setting OFF ──
  const mctx = await context(browser, "10.98.0.2");
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await mp.goto("/login");
  await mp.getByLabel("Club code").fill(club.slug);
  await mp.keyboard.press("Enter");
  await mp.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await mp.getByLabel("Email address").first().fill(member.email);
  await mp.getByLabel("Password").fill(memberPassword);
  await mp.getByRole("button", { name: "Sign in", exact: true }).click();
  await mp.waitForURL(/\/member/, { timeout: 60000 });
  await mp.goto("/member/home");
  await mp.waitForLoadState("load");
  await mp.waitForTimeout(4000);
  const btnOff = await mp.getByText("Sign In to Class", { exact: true }).filter({ visible: true }).count();
  L.check("member", "M1 with the setting OFF the member home has no \"Sign In to Class\"", btnOff === 0, { visible: btnOff });
  const selfRes = await mp.evaluate(async (classInstanceId) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId, checkInMethod: "self" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, inst);
  L.check("member", "M2 the server refuses the member's own check-in: 403 app_checkin_off with the sentence, nothing recorded",
    selfRes.status === 403 && selfRes.body?.reason === "app_checkin_off" && selfRes.body?.error === REFUSAL && (await attended()) === 0, selfRes);
  await shot(mp, "app-checkin-member-home-off");
  // The member's packs are listed on the profile (ClassPacksWidget), not the home page.
  await mp.goto("/member/profile");
  await mp.waitForLoadState("load");
  const packText = await mp.getByTestId("pack-classes-left").filter({ visible: true }).first().innerText({ timeout: 15000 }).catch(() => null);
  L.check("packs", "P1 the member's pack reads \"6 classes left\" with no expiry date", packText !== null && /6 classes left/.test(packText) && !/expir|until|valid/i.test(packText), { packText });
  await shot(mp, "app-checkin-member-profile-packs");

  // The desk is unaffected.
  const desk = await owner.evaluate(async ({ classInstanceId, memberId }) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId, memberId, checkInMethod: "admin" }) });
    return { status: r.status };
  }, { classInstanceId: inst, memberId: member.id });
  L.check("desk", "D1 with the setting OFF the desk still checks the member in (201, one row)", desk.status === 201 && (await attended()) === 1, { ...desk, rows: await attended() });

  // ── Back ON ──
  await sw2.focus();
  await owner.keyboard.press("Space");
  await confirmDialog(owner, "Turn on");
  await owner.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings", { timeout: 30000 });
  await owner.waitForTimeout(500);
  L.check("settings", "S6 turned back on, the database reads ON", (await setting()) === true, await setting());
  await mp.goto("/member/home");
  await mp.waitForLoadState("load");
  const btnOn = await mp.getByText("Sign In to Class", { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  L.check("member", "M3 with the setting ON the member sees \"Sign In to Class\" again", btnOn, { btnOn });

  // ── Owner pack manager: no validity field ──
  await owner.goto("/dashboard/memberships");
  await owner.waitForLoadState("load");
  const mgrText = (await owner.locator("main").innerText({ timeout: 60000 }).catch(() => "")).replace(/\s+/g, " ");
  L.note("packs", "N1 owner memberships page mentions of validity or expiry", (mgrText.match(/.{0,40}(valid for|days valid|validity|expir).{0,40}/gi) ?? []).slice(0, 5));

  // ── Phone width ──
  const phone = await context(browser, "10.98.0.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await octx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto(SETTINGS_URL);
  const sw3 = p2.getByRole("switch", { name: LABEL }).filter({ visible: true }).first();
  await sw3.waitFor({ timeout: 60000 });
  await sw3.scrollIntoViewIfNeeded();
  const box = await sw3.boundingBox();
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "MB1 /dashboard/settings at 390 px: no horizontal scroll and the switch is reachable", m.scroll <= m.width + 1 && !!box, { ...m, box });
  L.note("mobile", "MB2 switch tap target at 390 px (44 px is the target)", box ? `${Math.round(box.width)}×${Math.round(box.height)} px` : "not visible");
  await shot(p2, "app-checkin-settings-mobile");
  const mphone = await context(browser, "10.98.0.4", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await mctx.storageState() });
  const p3 = await mphone.newPage();
  await p3.goto("/member/home");
  await p3.waitForLoadState("load");
  const m2 = await p3.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "MB3 the member home at 390 px has no horizontal scroll", m2.scroll <= m2.width + 1, m2);
  await shot(p3, "app-checkin-member-home-mobile");

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
