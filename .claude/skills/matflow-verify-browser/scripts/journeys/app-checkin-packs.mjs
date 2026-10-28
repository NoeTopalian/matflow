// Journey: the club's app check-in setting (G5) and class packs with expiry chosen per product, 27 Oct 2026.
// The owner finds "Members can check themselves in from the app" ON by default, turns it off (keyboard, a forced failed
// save first), and the member's home loses "Sign In to Class" while the server refuses the member's own check-in; the
// desk still checks the member in. Turned back on, the member sees the button again.
// Packs (owner decision, 27 Oct 2026: "the club chooses an expiry or no expiry per new pack product"): the member holds
// a no-expiry pack, a dated pack in date, a dated pack past its date and a legacy "expired" pack. The profile lists the
// two usable ones ("4 classes left · expires <date>", "6 classes left"); the member's own check-in spends the dated pack
// first (earliest expiry), then the no-expiry pack; with only the expired packs left it is refused and neither is spent.
// The owner's create-pack form offers "Never expires" and sends validityDays null (Stripe calls intercepted, nothing
// created). Desktop and 390 px.
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
const inst2 = randomUUID();
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '00:01', '23:58')`, [inst2, cls, today]);
// Two products, one per choice, and four purchases recorded with their own terms.
const tplOpen = randomUUID(); const tplDated = randomUUID();
await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "isActive", "updatedAt") values ($1, $2, 'Open Pack', 10, null, 9000, true, now())`, [tplOpen, tenantId]);
await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "isActive", "updatedAt") values ($1, $2, 'Dated Pack', 10, 30, 8000, true, now())`, [tplDated, tenantId]);
const DAY = 86_400_000;
// Midday UTC, so the calendar date is the same in the browser's zone and this script's.
const datedExpiry = new Date(new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) + "T12:00:00.000Z");
const datedLabel = `4 classes left · expires ${datedExpiry.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
const packIds = { open: randomUUID(), dated: randomUUID(), past: randomUUID(), legacy: randomUUID() };
const addPack = (id, tpl, credits, expiresAt, purchasedAt, status) => q(
  `insert into "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", "purchasedAt", status) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [id, tenantId, member.id, tpl, credits, expiresAt, purchasedAt, status]);
await addPack(packIds.open, tplOpen, 6, null, new Date(Date.now() - 40 * DAY), "active");
await addPack(packIds.dated, tplDated, 4, datedExpiry, new Date(Date.now() - 10 * DAY), "active");
await addPack(packIds.past, tplDated, 5, new Date(Date.now() - DAY), new Date(Date.now() - 31 * DAY), "active");
await addPack(packIds.legacy, tplDated, 7, new Date(Date.now() + 5 * DAY), new Date(Date.now() - 50 * DAY), "expired");
const credits = async () => Object.fromEntries((await q(`select id, "creditsRemaining" as c from "MemberClassPack" where "tenantId" = $1`, [tenantId])).map((r) => [Object.keys(packIds).find((k) => packIds[k] === r.id), r.c]));
const attended = async (instanceId = inst) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "memberId" = $1 and "classInstanceId" = $2`, [member.id, instanceId]))[0].n);

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
  // Next's route announcer is also role=alert (empty); match the setting's own error by its words.
  const settingAlert = owner.getByRole("alert").filter({ hasText: /couldn|try again|error/i }).filter({ visible: true }).first();
  await settingAlert.waitFor({ timeout: 15000 }).catch(() => {});
  const alertText = await settingAlert.innerText().catch(() => "");
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
  // The control shows while /api/member/home is in flight (by design: the route refuses either way, and a sheet
  // opened then shows the refusal), so judge the page once the home payload has answered.
  const homeRes = mp.waitForResponse((r) => new URL(r.url()).pathname === "/api/member/home", { timeout: 90000 });
  await mp.goto("/member/home");
  const homeBody = await (await homeRes).json().catch(() => null);
  L.check("member", "M0 the home payload carries the club's setting: memberAppCheckin false", homeBody?.me?.memberAppCheckin === false, { memberAppCheckin: homeBody?.me?.memberAppCheckin });
  await mp.waitForTimeout(1500);
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
  await mp.getByTestId("pack-classes-left").first().waitFor({ timeout: 30000 }).catch(() => {});
  const packTexts = (await mp.getByTestId("pack-classes-left").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.trim());
  L.check("packs", "P1 the profile lists the two usable packs, dated first: the dated one with its date, the no-expiry one with none; the past-date and legacy expired packs are not listed",
    packTexts.length === 2 && packTexts[0] === datedLabel && packTexts[1] === "6 classes left", { packTexts, expected: [datedLabel, "6 classes left"] });
  const available = (await mp.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  L.check("packs", "P2 packs on sale say \"10 classes · no expiry\" and \"10 classes · valid 30 days\"", available.includes("10 classes · no expiry") && available.includes("10 classes · valid 30 days"),
    (available.match(/10 classes · [^·]{0,20}/g) ?? []).slice(0, 4));
  await shot(mp, "app-checkin-member-profile-packs");

  // The desk is unaffected.
  const desk = await owner.evaluate(async ({ classInstanceId, memberId }) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId, memberId, checkInMethod: "admin" }) });
    return { status: r.status };
  }, { classInstanceId: inst, memberId: member.id });
  L.check("desk", "D1 with the setting OFF the desk still checks the member in (201, one row)", desk.status === 201 && (await attended()) === 1, { ...desk, rows: await attended() });
  // The member has no plan, so the plan allowance is open and the desk spends no pack (a desk mark spends a pack only
  // once a plan allowance is used up; lib/checkin.ts, unchanged here).
  const afterDesk = await credits();
  L.check("packs", "P3 the desk mark spends no pack credit for a member whose plan allowance is open (4 / 6 / 5 / 7 unchanged)",
    afterDesk.dated === 4 && afterDesk.open === 6 && afterDesk.past === 5 && afterDesk.legacy === 7, afterDesk);

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

  // The member's own check-in (no plan, so a pack pays): earliest expiry first, then the no-expiry pack, never an
  // expired one.
  const selfCheckIn = async (classInstanceId) => mp.evaluate(async (id) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, checkInMethod: "self" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, classInstanceId);
  const newSession = async (start, end) => {
    const id = randomUUID();
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [id, cls, today, start, end]);
    return id;
  };
  const self2 = await selfCheckIn(inst2);
  const afterSelf = await credits();
  L.check("packs", "P4 the member's own check-in spends the dated pack in date first (earliest expiry), ahead of the older no-expiry pack; the expired packs are untouched",
    self2.status === 201 && (await attended(inst2)) === 1 && afterSelf.dated === 3 && afterSelf.open === 6 && afterSelf.past === 5 && afterSelf.legacy === 7,
    { status: self2.status, body: self2.body, credits: afterSelf });
  // The dated pack used up: the no-expiry pack pays next.
  await q(`update "MemberClassPack" set "creditsRemaining" = 0 where id = $1 and "tenantId" = $2`, [packIds.dated, tenantId]);
  const inst3 = await newSession("00:02", "23:57");
  const self3 = await selfCheckIn(inst3);
  const afterOpen = await credits();
  L.check("packs", "P5 with the dated pack used up, the no-expiry pack pays (6 → 5); the expired packs are untouched",
    self3.status === 201 && (await attended(inst3)) === 1 && afterOpen.open === 5 && afterOpen.past === 5 && afterOpen.legacy === 7,
    { status: self3.status, body: self3.body, credits: afterOpen });
  // Only the expired packs left with credits: nothing usable, so the member is refused and no credit is taken.
  await q(`update "MemberClassPack" set "creditsRemaining" = 0 where id = $1 and "tenantId" = $2`, [packIds.open, tenantId]);
  const inst4 = await newSession("00:03", "23:56");
  const self4 = await selfCheckIn(inst4);
  const afterOnlyExpired = await credits();
  L.check("packs", "P6 with only expired packs holding credits (past-date 5, legacy 7) the member's check-in is refused and neither is spent",
    self4.status !== 201 && (await attended(inst4)) === 0 && afterOnlyExpired.past === 5 && afterOnlyExpired.legacy === 7,
    { status: self4.status, reason: self4.body?.reason ?? self4.body?.error ?? null, credits: afterOnlyExpired });

  // ── Owner pack manager: the expiry choice per product ──
  // The manager shows only for a Stripe-connected club. The fixture club is marked connected for this step only and
  // every POST /api/class-packs is answered by the journey (never reaching Stripe), then the flag is put back.
  await q(`update "Tenant" set "stripeConnected" = true, "stripeAccountId" = $2 where id = $1`, [tenantId, `acct_mfv_${randomUUID().slice(0, 8)}`]);
  const sent = [];
  let answer = { status: 500, body: { error: "Couldn't create pack (journey: forced failure)" } };
  await owner.route("**/api/class-packs", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    sent.push(JSON.parse(r.request().postData() ?? "{}"));
    return r.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  try {
    const packsBefore = Number((await q(`select count(*)::int as n from "ClassPack" where "tenantId" = $1`, [tenantId]))[0].n);
    await owner.goto("/dashboard/settings?tab=revenue");
    const newPack = owner.getByRole("button", { name: "New pack" }).filter({ visible: true }).first();
    await newPack.waitFor({ timeout: 60000 });
    // The list loads after the button renders; wait for each row's terms line (the page has more than one <main>, so
    // read the rows themselves rather than a container's text).
    const shows = (text) => owner.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    const openRow = await shows("10 classes · no expiry");
    const datedRow = await shows("10 classes · valid 30 days");
    L.check("owner-packs", "O1 the owner's pack list shows each product's terms: \"no expiry\" and \"valid 30 days\"", openRow && datedRow, { openRow, datedRow });
    await owner.getByText("10 classes · no expiry", { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(owner, "app-checkin-owner-pack-list");
    await newPack.focus();
    await owner.keyboard.press("Enter");
    const dialog = owner.getByRole("dialog").filter({ visible: true }).first();
    await dialog.waitFor({ timeout: 15000 });
    await dialog.getByLabel("Name").fill("Journey pack");
    const expiry = dialog.getByLabel("Expiry");
    const options = await expiry.locator("option").allInnerTexts();
    L.check("owner-packs", "O2 the create form asks for the expiry: \"Expires after a set time\" or \"Never expires\"", options.includes("Never expires") && options.includes("Expires after a set time"), options);
    await expiry.focus();
    await expiry.selectOption("never");
    const daysHidden = (await dialog.getByLabel("Days after purchase").count()) === 0;
    // Forced failed save: the error shows in the dialog and nothing is stored.
    await dialog.getByLabel("Name").focus();
    await owner.keyboard.press("Enter");
    const alert = dialog.getByRole("alert").filter({ hasText: /couldn/i }).first();
    const alertShown = await alert.waitFor({ timeout: 15000 }).then(() => true, () => false);
    const packsAfterFail = Number((await q(`select count(*)::int as n from "ClassPack" where "tenantId" = $1`, [tenantId]))[0].n);
    L.check("owner-packs", "O3 \"Never expires\" hides the days field and sends validityDays null; a failed save shows an error and stores nothing",
      daysHidden && sent.length === 1 && sent[0].validityDays === null && alertShown && packsAfterFail === packsBefore, { daysHidden, sent, alertShown, packsBefore, packsAfterFail });
    // Retry as a dated product: the days field returns and its value is sent.
    await expiry.selectOption("days");
    const days = dialog.getByLabel("Days after purchase");
    await days.fill("45");
    answer = { status: 201, body: { id: "journey-pack", name: "Journey pack", description: null, totalCredits: 10, validityDays: 45, pricePence: 8000, currency: "GBP", isActive: true } };
    await owner.getByRole("button", { name: "Create pack" }).filter({ visible: true }).first().click();
    const newRow = await shows("10 classes · valid 45 days");
    L.check("owner-packs", "O4 retried as \"Expires after a set time\", 45: validityDays 45 is sent and the new product reads \"valid 45 days\"",
      sent.length === 2 && sent[1].validityDays === 45 && newRow, { sent: sent[1] ?? null, newRow });
    await shot(owner, "app-checkin-owner-packs");
  } finally {
    await owner.unroute("**/api/class-packs");
    await q(`update "Tenant" set "stripeConnected" = false, "stripeAccountId" = null where id = $1`, [tenantId]);
  }

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
