// Journey: G4, a coach's one-off (owner, 27 Oct 2026: "If they want to do another class, they'd have to discuss with a
// coach, for example, and maybe that coach will include them on a one-off session.").
// A member whose "1 each week" class is used is REFUSED at the desk register; the refusal line offers "Add as a
// one-off"; the dialog (opened by keyboard) names the member and the session and needs a reason; a forced network
// failure and a server error keep the typed reason and show the error beside the action, nothing recorded; the retry
// sends one request and records the visit with a ClassOneOff row (reason, granted by the signed-in owner) and an
// attendance.one_off audit row. The row reads "One-off · <reason>". NOT COUNTED: with the counted visit undone, the
// member's own class is free again (a further mark is admitted). The member's history and Activity show it. Removing the
// check-in removes the one-off. Then the register and the dialog at phone width.
// Needs `fixture.mjs create` and `server.mjs start` (run-journeys.mjs does both).
//   node journeys/one-off.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("one-off");
const tenantId = club.tenantId;
const errors = [];
const REASON = "Trial for the comp squad, agreed with Sean";

// Today in the club's zone (fixture tenants default to Europe/London), spelled as 00:00Z: inside todayWindow.
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
const get = (t) => Number(parts.find((p) => p.type === t).value);
const todayIso = `${get("year")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;
// Three sessions today: the counted visit (T1), the one-off (T2), a later class (T3).
const T1 = hh(hourNow - 2), T2 = hh(hourNow + 1), T3 = hh(hourNow + 2);

const member = (await q(`select id, name from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const owner = (await q(`select id, name from "User" where id = $1`, [club.owner.id]))[0];
const records = async (instanceId) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "memberId" = $2 and "classInstanceId" = $3`, [tenantId, member.id, instanceId]))[0].n);
const oneOffs = async () => q(`select id, reason, "grantedById", "classInstanceId", "attendanceRecordId" from "ClassOneOff" where "tenantId" = $1 and "memberId" = $2`, [tenantId, member.id]);

// ── Seed: "1 each week", the member on it with a signed waiver, one class with three sessions today, T1 attended ──
const tier = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "updatedAt") values ($1, $2, 'One a week', 0, 'GBP', 'monthly', 1, 'week', now())`, [tier, tenantId]);
await q(`update "Member" set "membershipTierId" = $1, "waiverAccepted" = true where id = $2 and "tenantId" = $3`, [tier, member.id, tenantId]);
// Three classes, so a late-evening clamp of the hours can never put two sessions of one class in the same slot.
const clsA = randomUUID(); const clsB = randomUUID(); const clsC = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $4, 'Fundamentals', 60, 50), ($2, $4, 'Open Mat', 60, 50), ($3, $4, 'Sparring', 60, 50)`,
  [clsA, clsB, clsC, tenantId]);
const inst1 = randomUUID(); const inst2 = randomUUID(); const inst3 = randomUUID();
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $4, $7, $8, $8), ($2, $5, $7, $9, $9), ($3, $6, $7, $10, $10)`,
  [inst1, inst2, inst3, clsA, clsB, clsC, todayMarker, T1, T2, T3]);
const counted = randomUUID();
await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [counted, tenantId, member.id, inst1]);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let oneOffPosts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/checkin" && (r.postData() ?? "").includes('"oneOff"')) oneOffPosts++;
  });

  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // ── The refused mark offers the one-off ──
  await page.goto("/dashboard/checkin");
  const pickT2 = () => page.getByRole("button", { name: new RegExp(`${T2} · Open Mat`) }).click();
  await pickT2();
  const search = page.getByLabel("Search members");
  await search.waitFor();
  const markMember1 = async () => {
    await search.fill("");
    await search.fill("Member 1");
    await page.getByRole("button", { name: /^Member 1/ }).first().waitFor();
    await page.keyboard.press("Enter");
  };
  await markMember1();
  const refusal = page.getByRole("alert").filter({ hasText: "Member 1 has used their 1 class this week" });
  const refused = await refusal.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const offer = page.getByTestId("register-one-off-offer");
  L.check("journey", "J2 a member whose weekly class is used is refused at the register, and the refusal line offers 'Add as a one-off'",
    refused && (await offer.count()) === 1 && (await records(inst2)) === 0, { refused, offer: await offer.count() });
  await shot(page, "one-off-refused");

  // Keyboard: focus the offer, Enter opens the dialog with the reason field focused.
  await offer.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const dText = await dialog.textContent();
  L.check("keyboard", "K1 Enter on the offer opens the dialog with the reason field focused", focused === "register-one-off-reason", focused);
  L.check("journey", "J3 the dialog names the member and the session", /Member 1/.test(dText) && /Open Mat/.test(dText) && dText.includes(T2), dText.slice(0, 200));

  // An empty reason is refused before anything is sent.
  await page.keyboard.press("Enter");
  const emptyErr = await page.getByTestId("register-one-off-error").textContent().catch(() => null);
  L.check("journey", "J4 no reason: the dialog says what is needed and sends nothing", /Give a reason/.test(emptyErr ?? "") && oneOffPosts === 0, { emptyErr, oneOffPosts });
  await page.keyboard.type(REASON);

  // ── Forced failed saves: network failure, then a server error. Reason kept, error beside the action, nothing recorded ──
  await page.route("**/api/checkin", (r) => (r.request().method() === "POST" ? r.abort("failed") : r.fallback()));
  await page.getByTestId("register-one-off-confirm").click();
  const netErr = await page.getByTestId("register-one-off-error").filter({ hasText: "Couldn't reach MatFlow" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F1 network failure: error beside the action, reason kept, nothing recorded",
    netErr && (await page.getByTestId("register-one-off-reason").inputValue()) === REASON && (await records(inst2)) === 0 && (await oneOffs()).length === 0, { netErr });
  await page.unroute("**/api/checkin");
  await page.route("**/api/checkin", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to check in" }) }) : r.fallback()));
  await page.getByTestId("register-one-off-confirm").click();
  const srvErr = await page.getByTestId("register-one-off-error").filter({ hasText: "Failed to check in" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F2 server error: shown beside the action, reason kept, nothing recorded",
    srvErr && (await page.getByTestId("register-one-off-reason").inputValue()) === REASON && (await records(inst2)) === 0, { srvErr });
  await shot(page, "one-off-failed-save");
  await page.unroute("**/api/checkin");

  // ── Retry: one request, recorded with who and why ──
  const before = oneOffPosts;
  await page.getByTestId("register-one-off-reason").focus();
  await page.keyboard.press("Enter");
  const closed = await dialog.waitFor({ state: "detached", timeout: 30000 }).then(() => true, () => false);
  for (let i = 0; i < 30 && (await records(inst2)) === 0; i++) await page.waitForTimeout(500);
  const rows = await oneOffs();
  const audit = (await q(`select "userId", metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.one_off' order by "createdAt" desc limit 1`, [tenantId]))[0] ?? null;
  L.check("retry", "R1 the retry (Enter) sends ONE request; the visit and its one-off are recorded with the reason, granted by the signed-in owner",
    closed && oneOffPosts - before === 1 && (await records(inst2)) === 1 && rows.length === 1 && rows[0].reason === REASON && rows[0].grantedById === club.owner.id && rows[0].classInstanceId === inst2,
    { closed, requests: oneOffPosts - before, rows });
  L.check("journey", "J5 the audit row is attendance.one_off by the owner, with the reason and the record",
    !!audit && audit.userId === club.owner.id && audit.metadata?.reason === REASON && audit.metadata?.recordId === rows[0]?.attendanceRecordId, audit);

  // The row, after a reload (the server's answer, not local state).
  await page.reload();
  await pickT2();
  const rowLabel = page.getByTestId("register-one-off");
  const rowShown = await rowLabel.waitFor({ timeout: 45000 }).then(() => true, () => false);
  L.check("journey", "J6 the register row reads 'One-off · <reason>'", rowShown && (await rowLabel.textContent()) === `One-off · ${REASON}`, rowShown ? await rowLabel.textContent() : null);
  await shot(page, "one-off-row");

  // ── NOT COUNTED: undo the counted visit; if the one-off were counted the week would still be used ──
  await q(`delete from "AttendanceRecord" where id = $1 and "tenantId" = $2`, [counted, tenantId]);
  const third = await page.evaluate(async ({ id, mid }) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, memberId: mid, checkInMethod: "admin" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { id: inst3, mid: member.id });
  L.check("journey", "J7 not counted: with the one counted visit undone, the member's class this week is free again (a mark on a later session is admitted)",
    third.status === 201 && (await records(inst3)) === 1, third);

  // ── Member history and Activity ──
  await page.goto(`/dashboard/members/${member.id}`);
  await page.getByRole("tab", { name: /^Attendance/ }).click();
  const hist = page.getByTestId("attendance-one-off").first();
  const histShown = await hist.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const histText = histShown ? await hist.textContent() : null;
  L.check("journey", "J8 the member's history reads 'One-off — added by <staff name>: <reason>'", histText === `One-off — added by ${owner.name}: ${REASON}`, histText);
  await shot(page, "one-off-history");
  await page.goto("/dashboard/activity");
  const act = page.getByText(`Added a member to one session as a one-off: “${REASON}”`).first();
  const actShown = await act.waitFor({ timeout: 30000 }).then(() => true, () => false);
  L.check("journey", "J9 Activity shows the one-off as a sentence with the reason", actShown, actShown);
  await shot(page, "one-off-activity");

  // ── Removing the check-in removes the one-off ──
  await page.goto("/dashboard/checkin");
  await pickT2();
  const absent = page.getByRole("button", { name: "Mark Member 1 absent" });
  await absent.waitFor({ timeout: 45000 });
  await absent.click();
  const confirmText = await dialog.textContent();
  await dialog.getByRole("button", { name: "Remove check-in" }).click();
  for (let i = 0; i < 30 && (await records(inst2)) === 1; i++) await page.waitForTimeout(500);
  L.check("journey", "J10 removing the check-in says the one-off goes too, and removes the visit and the one-off",
    /The one-off is removed with it\./.test(confirmText ?? "") && (await records(inst2)) === 0 && (await oneOffs()).length === 0, { confirmText, rows: await records(inst2), oneOffs: (await oneOffs()).length });

  // ── Phone width: the refusal offers the one-off; the dialog fits and its action is reachable ──
  const phone = await context(browser, "10.94.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/dashboard/checkin");
  await p2.getByRole("button", { name: new RegExp(`${T2} · Open Mat`) }).click();
  const s2 = p2.getByLabel("Search members");
  await s2.waitFor();
  await s2.fill("Member 1");
  await p2.getByRole("button", { name: /^Member 1/ }).first().waitFor();
  await p2.getByRole("button", { name: /^Member 1/ }).first().tap();
  const offer2 = p2.getByTestId("register-one-off-offer");
  const offered = await offer2.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const reg = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 at 390 px the refusal offers the one-off and the page has no horizontal scroll", offered && reg.scroll <= reg.width + 1, { offered, ...reg });
  if (offered) {
    await offer2.tap();
    const d2 = p2.getByRole("dialog");
    await d2.waitFor();
    const confirmBox = await p2.getByTestId("register-one-off-confirm").boundingBox();
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth, height: window.innerHeight }));
    L.check("mobile", "M2 the dialog fits at 390 px and its action is on screen",
      !!confirmBox && confirmBox.y + confirmBox.height <= m.height && confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= m.width && m.scroll <= m.width + 1, { confirmBox, ...m });
    L.note("mobile", "M3 Confirm tap target at 390 px (44 px is the target)", confirmBox ? `${Math.round(confirmBox.width)}×${Math.round(confirmBox.height)} px` : "not visible");
    await shot(p2, "one-off-mobile-dialog");
    await p2.keyboard.press("Escape");
    const escaped = await d2.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    L.check("keyboard", "K2 Escape closes the dialog and records nothing", escaped && (await records(inst2)) === 0 && (await oneOffs()).length === 0, { escaped });
  }
  L.check("journey", "J11 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
