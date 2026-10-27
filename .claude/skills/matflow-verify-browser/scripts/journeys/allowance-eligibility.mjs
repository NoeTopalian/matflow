// Journey: plan allowance (explicit reset periods) and mandatory class eligibility, 21 Oct 2026.
// Owner creates a "1 each week" plan in the editor (summary + period dates shown before saving; failed saves keep the
// typed values; the retry sends one request), a member on that plan who already attended once this week is REFUSED
// at the desk register with the staff sentence and no "Admit anyway" (owner decision, 27 Oct 2026: no door admits
// past the allowance; an old client's "allowance_reached" acknowledgement admits no one), with a class pack the same
// mark is recorded on one pack credit and no override, undoing it gives the credit back, and without the pack the
// next mark is refused again; a class whose membership list excludes the plan REFUSES at the register with the
// member's own sentence — an old client's "tier_not_included" acknowledgement admits no one. Then the same pages at
// phone width.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/allowance-eligibility.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("allowance-eligibility");
const tenantId = club.tenantId;
const errors = [];

// Today in the club's zone (fixture tenants default to Europe/London), spelled as 00:00Z: inside todayWindow.
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
const get = (t) => Number(parts.find((p) => p.type === t).value);
const todayIso = `${get("year")}-${String(get("month")).padStart(2, "0")}-${String(get("day")).padStart(2, "0")}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
// Session times around the club's clock now: one already over (the attended one), two still to come today.
const hourNow = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;
const T1 = hh(hourNow - 2), T2 = hh(hourNow + 1), T3 = hh(hourNow + 2);
// Monday of this week and the next Monday (the "1 each week" period and its reset), as the copy spells them.
const dow = (todayMarker.getUTCDay() + 6) % 7;
const monday = new Date(todayMarker.getTime() - dow * 86_400_000);
const nextMonday = new Date(monday.getTime() + 7 * 86_400_000);
const sunday = new Date(nextMonday.getTime() - 86_400_000);
const long = (d, year = false) => {
  const t = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return year ? `${t} ${d.getUTCFullYear()}` : t;
};

const member = (await q(`select id, name from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const tierRow = async () => (await q(`select "classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor" from "MembershipTier" where "tenantId" = $1 and name = 'Limited A'`, [tenantId]))[0] ?? null;
const records = async (instanceId) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "memberId" = $2 and "classInstanceId" = $3`, [tenantId, member.id, instanceId]))[0].n);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.92.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let posts = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/memberships") posts++; });

  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // ── Plan editor: an explicit reset basis with the summary and the period dates before saving ──
  await page.goto("/dashboard/memberships");
  await page.getByRole("button", { name: "Add tier" }).click();
  const name = page.locator("#tier-name");
  await name.waitFor();
  await name.fill("Limited A");
  const limit = page.locator("#tier-class-limit");
  const basis = page.locator("#tier-class-limit-basis");
  L.check("journey", "J2 the basis select is disabled while Classes allowed is blank (blank = Unlimited)", await basis.isDisabled(), "disabled");
  const summary = page.getByTestId("tier-allowance-summary");
  L.check("journey", "J3 blank allowance reads as Unlimited", /^Unlimited classes\./.test(await summary.textContent()), await summary.textContent());
  await limit.fill("1");
  await page.keyboard.press("Tab");
  const focusedId = await page.evaluate(() => document.activeElement?.id);
  L.check("keyboard", "K1 Tab from Classes allowed reaches the reset-basis select", focusedId === "tier-class-limit-basis", focusedId);
  const expectWeek = `Attend up to 1 class during each week. The next reset is ${long(nextMonday, true)}.`;
  const expectPeriod = `The current period runs ${long(monday)} to ${long(sunday, true)}.`;
  L.check("journey", "J4 '1 each week' shows the plain summary with the actual next reset", (await summary.textContent()) === expectWeek, await summary.textContent());
  L.check("journey", "J5 the current period's dates are shown before saving", (await page.getByTestId("tier-allowance-period").textContent()) === expectPeriod, await page.getByTestId("tier-allowance-period").textContent());
  await basis.selectOption("weeks");
  const weeks = page.locator("#tier-class-limit-weeks");
  const anchor = page.locator("#tier-class-limit-anchor");
  L.check("journey", "J6 'every N weeks' asks for the number of weeks (default 4) and the date periods count from (this Monday)",
    (await weeks.inputValue()) === "4" && (await anchor.inputValue()) === monday.toISOString().slice(0, 10), { weeks: await weeks.inputValue(), anchor: await anchor.inputValue() });
  L.check("journey", "J7 the summary follows: each 4-week period", /during each 4-week period\./.test(await summary.textContent()), await summary.textContent());
  await basis.selectOption("month");
  L.check("journey", "J8 calendar month: summary says each calendar month and the weeks fields are gone",
    /during each calendar month\./.test(await summary.textContent()) && (await weeks.count()) === 0, await summary.textContent());
  await basis.selectOption("week");
  await shot(page, "allowance-editor");

  // Failed saves: network failure, then a server error. Typed values kept, nothing saved.
  await page.route("**/api/memberships", (r) => (r.request().method() === "POST" ? r.abort("failed") : r.fallback()));
  await page.getByRole("button", { name: "Create tier" }).click();
  const netAlert = page.getByRole("alert").filter({ hasText: "Couldn't reach the server" });
  const sawNet = await netAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F1 network failure: message shown, typed values kept, nothing saved",
    sawNet && (await name.inputValue()) === "Limited A" && (await limit.inputValue()) === "1" && (await tierRow()) === null, { alert: sawNet });
  await page.unroute("**/api/memberships");
  await page.route("**/api/memberships", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not save the tier" }) }) : r.fallback()));
  await page.getByRole("button", { name: "Create tier" }).click();
  const srvAlert = page.getByRole("alert").filter({ hasText: "Could not save the tier" });
  const sawSrv = await srvAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F2 server error: message shown, typed values kept, nothing saved",
    sawSrv && (await limit.inputValue()) === "1" && (await tierRow()) === null, { alert: sawSrv });
  await page.unroute("**/api/memberships");
  const before = posts;
  await page.getByRole("button", { name: "Create tier" }).focus();
  await page.keyboard.press("Enter");
  const created = await page.getByRole("alert").filter({ hasText: "Tier created" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  const saved = await tierRow();
  L.check("retry", "R1 retry sends one request and saves 1 each week (basis week, no weeks, no anchor)",
    created && posts - before === 1 && saved && saved.classLimit === 1 && saved.classLimitBasis === "week" && saved.classLimitWeeks === null && saved.classLimitAnchor === null, { created, requests: posts - before, saved });
  await page.reload();
  const card = page.getByTestId("tier-class-limit").first();
  await card.waitFor();
  L.check("retry", "R2 after reload the plan reads '1 each week'", /1 each week/.test(await card.textContent()), await card.textContent());

  // ── Seed: the member on the plan, two sessions of an open class and one of a class the plan is not on ──
  const tier = (await q(`select id from "MembershipTier" where "tenantId" = $1 and name = 'Limited A'`, [tenantId]))[0];
  const tierB = randomUUID();
  await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $2, 'Squad B', 0, 'GBP', 'monthly', now())`, [tierB, tenantId]);
  // On the plan, waiver signed (the desk asks about an unsigned waiver first; that is not what is under test here).
  await q(`update "Member" set "membershipTierId" = $1, "waiverAccepted" = true where id = $2 and "tenantId" = $3`, [tier.id, member.id, tenantId]);
  const openClass = randomUUID(); const squadClass = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Open Mat', 60, 50), ($3, $2, 'Squad Only', 60, 50)`, [openClass, tenantId, squadClass]);
  await q(`insert into "ClassMembershipTier" (id, "tenantId", "classId", "tierId") values ($1, $2, $3, $4)`, [randomUUID(), tenantId, squadClass, tierB]);
  const inst1 = randomUUID(); const inst2 = randomUUID(); const inst3 = randomUUID();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $4, $6, $7, $7), ($2, $4, $6, $8, $8), ($3, $5, $6, $9, $9)`,
    [inst1, inst2, inst3, openClass, squadClass, todayMarker, T1, T2, T3]);
  // One confirmed attendance this week: the plan's single class is used.
  await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), tenantId, member.id, inst1]);

  // ── Desk register: the allowance REFUSES (no Admit anyway); a class pack pays; undo gives the credit back ──
  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${T2} · Open Mat`) }).click();
  const search = page.getByLabel("Search members");
  await search.waitFor();
  const markMember1 = async () => {
    await search.fill("");
    await search.fill("Member 1");
    await page.getByRole("button", { name: /^Member 1/ }).first().waitFor();
    await page.keyboard.press("Enter");
  };
  const dialog = page.getByRole("dialog");
  const staffSentence = `Member 1 has used their 1 class this week (resets on ${long(nextMonday)}) and has no class-pack credit, so they can't be checked in.`;
  await markMember1();
  const refusedAlert = page.getByRole("alert").filter({ hasText: staffSentence });
  const refusedSeen = await refusedAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const seen = refusedSeen ? null : { dialog: await dialog.textContent().catch(() => null), alert: await page.getByRole("alert").allTextContents().catch(() => null) };
  L.check("journey", "J9 a member whose weekly class is used is REFUSED at the desk with the staff sentence (count and reset date), no question, no Admit anyway",
    refusedSeen && (await dialog.count()) === 0 && (await page.getByRole("button", { name: "Admit anyway" }).count()) === 0, { refusedSeen, staffSentence, ...(seen ? { seen } : {}) });
  if (!refusedSeen) await shot(page, "allowance-register-unexpected");
  await shot(page, "allowance-register-refused");
  L.check("journey", "J10 the refusal records nothing", (await records(inst2)) === 0, "0 rows");
  const forcedAllowance = await page.evaluate(async ({ id, mid }) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, memberId: mid, checkInMethod: "admin", acknowledged: ["allowance_reached"] }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { id: inst2, mid: member.id });
  L.check("journey", "J10b an old register's acknowledged: ['allowance_reached'] is not a 400: 403 allowance_reached with the staff sentence, nothing recorded",
    forcedAllowance.status === 403 && forcedAllowance.body?.reason === "allowance_reached" && forcedAllowance.body?.error === staffSentence && !forcedAllowance.body?.askable && (await records(inst2)) === 0, forcedAllowance);

  // A class pack pays instead (owner, 27 Oct 2026: "they get what they paid for").
  const packTpl = randomUUID(); const memberPack = randomUUID();
  await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "updatedAt") values ($1, $2, 'Desk pack', 5, 90, 5000, now())`, [packTpl, tenantId]);
  await q(`insert into "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", status) values ($1, $2, $3, $4, 2, now() + interval '60 days', 'active')`, [memberPack, tenantId, member.id, packTpl]);
  const credits = async () => Number((await q(`select "creditsRemaining" as n from "MemberClassPack" where id = $1`, [memberPack]))[0].n);
  const dropPack = async () => {
    await q(`delete from "ClassPackRedemption" where "memberPackId" = $1`, [memberPack]);
    await q(`delete from "MemberClassPack" where id = $1`, [memberPack]);
    await q(`delete from "ClassPack" where id = $1`, [packTpl]);
  };
  try {
    await markMember1();
    for (let i = 0; i < 30 && (await records(inst2)) === 0; i++) await page.waitForTimeout(500);
    // The register re-reads after a mark; a reload proves the walk-in row is what the server holds, not local state.
    await page.reload();
    await page.getByRole("button", { name: new RegExp(`${T2} · Open Mat`) }).click();
    const absentBtn = page.getByRole("button", { name: "Mark Member 1 absent" });
    const rowShown = await absentBtn.waitFor({ timeout: 45000 }).then(() => true, () => false);
    if (!rowShown) await shot(page, "allowance-register-after-pack");
    L.check("journey", "J11a with a class pack the desk mark is recorded and the register shows Member 1 as attended (walk-in row)", rowShown, { rowShown });
    const audit = (await q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.mark' and "entityId" = $2 order by "createdAt" desc limit 1`, [tenantId, `${inst2}:${member.id}`]))[0]?.metadata ?? null;
    L.check("journey", "J11 the pack paid ONE credit (2 → 1) for that one row, and the audit row carries no override or overAllowance",
      (await records(inst2)) === 1 && (await credits()) === 1 && audit && !("overrides" in audit) && !("overAllowance" in audit),
      { rows: await records(inst2), credits: await credits(), audit });

    // Undo gives the credit back.
    await absentBtn.click();
    await dialog.getByRole("button", { name: "Remove check-in" }).click();
    for (let i = 0; i < 30 && (await records(inst2)) === 1; i++) await page.waitForTimeout(500);
    await page.waitForTimeout(500);
    L.check("journey", "J12 undo removes the row and gives the pack credit back (1 → 2)", (await records(inst2)) === 0 && (await credits()) === 2, { rows: await records(inst2), credits: await credits() });
  } finally {
    await dropPack();
  }
  // Without the pack the next mark is refused again (the earlier session still counts; this one does not).
  await markMember1();
  const refusedAgain = await refusedAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J13 without a pack the desk is refused again, nothing recorded", refusedAgain && (await records(inst2)) === 0, { refusedAgain });

  // ── Eligibility: the membership list refuses at the register; no acknowledgement admits ──
  await page.getByRole("button", { name: new RegExp(`${T3} · Squad Only`) }).click();
  await search.fill("");
  await search.fill("Member 1");
  await page.getByRole("button", { name: /^Member 1/ }).first().waitFor();
  await page.keyboard.press("Enter");
  const refusal = page.getByRole("alert").filter({ hasText: "Squad Only isn't included in your Limited A membership" });
  const sawRefusal = await refusal.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J14 a class whose memberships exclude the plan is REFUSED at the register with the member's own sentence, nothing recorded",
    sawRefusal && (await records(inst3)) === 0 && (await page.getByRole("dialog").count()) === 0, { sawRefusal, rows: await records(inst3) });
  await shot(page, "eligibility-register-refused");
  const forced = await page.evaluate(async ({ id, mid }) => {
    const r = await fetch("/api/checkin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, memberId: mid, checkInMethod: "admin", acknowledged: ["tier_not_included"] }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { id: inst3, mid: member.id });
  L.check("journey", "J15 an old client's acknowledged: ['tier_not_included'] still gets 403 tier_not_included and admits no one",
    forced.status === 403 && forced.body?.reason === "tier_not_included" && (await records(inst3)) === 0, forced);

  // ── Phone width ──
  const phone = await context(browser, "10.92.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/memberships", "/dashboard/checkin"]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", `M1 ${path} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `allowance-mobile${path.replace(/\//g, "-")}`);
  }
  await p2.goto("/dashboard/memberships");
  await p2.getByRole("button", { name: "Add tier" }).click();
  await p2.locator("#tier-class-limit").waitFor();
  const box = await p2.getByRole("button", { name: "Create tier" }).boundingBox();
  L.note("mobile", "M2 Create tier tap target at 390 px (44 px is the target)", box ? `${Math.round(box.width)}×${Math.round(box.height)} px` : "not visible");
  const sheet = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M3 the plan editor at 390 px has no horizontal page scroll", sheet.scroll <= sheet.width + 1, sheet);
  await shot(p2, "allowance-mobile-editor");
  L.check("journey", "J16 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
