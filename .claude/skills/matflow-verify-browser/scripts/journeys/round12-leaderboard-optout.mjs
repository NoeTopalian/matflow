// Journey: Round 12 G-1, staff hide a member from the gym leaderboard (16 Nov 2026).
// An owner turns "Show on the leaderboard" off on a member's profile, by keyboard. The saved value persists and is
// audited; the public TV board (/leaderboard/<token>) drops the member within its 60 s cache (the lag is measured); a
// forced failed save leaves the switch and says nothing changed; the retry works; phone width has no sideways scroll.
// Needs `fixture.mjs create` and `server.mjs start`. Cleans up its own seeded rows.
//   node journeys/round12-leaderboard-optout.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round12-leaderboard-optout");
const tenantId = club.tenantId;
const errors = [];
const member = (await q(`select id, name from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const today = new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
const cls = randomUUID(), inst = randomUUID(), att = randomUUID();
const optOut = async () => (await q(`select "leaderboardOptOut" o from "Member" where id = $1`, [member.id]))[0].o;

try {
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Board Gi', 60, 30)`, [cls, tenantId]);
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '06:00', '07:00')`, [inst, cls, today]);
  await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod", "checkInTime") values ($1, $2, $3, $4, 'admin', now())`, [att, tenantId, member.id, inst]);
  await q(`update "Member" set "leaderboardOptOut" = false where id = $1`, [member.id]);

  const browser = await chromium.launch();
  try {
    const ctx = await context(browser, "10.98.0.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(page, club);
    await page.goto("/dashboard");
    const origin = new URL(page.url()).origin;
    const en = await page.request.post("/api/settings/display", { headers: { origin }, data: { action: "enable" } });
    const token = en.ok() ? (await en.json()).rawToken : null;
    L.check("setup", "S1 the owner turns the TV leaderboard link on", !!token, { status: en.status() });
    if (!token) throw new Error("no display token");

    const tv = await (await context(browser, "10.98.0.2")).newPage();
    tv.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    const boardHas = async () => { await tv.goto(`/leaderboard/${token}`); await tv.waitForLoadState("networkidle"); return /Member/.test((await tv.locator("body").textContent()) ?? ""); };
    const before = await boardHas();
    L.check("board", "B1 before: the member who trained this month is on the TV board", before, { before });

    await page.goto(`/dashboard/members/${member.id}`);
    const sw = page.getByRole("switch", { name: "Show on the leaderboard" });
    await sw.waitFor({ timeout: 90000 });
    const on0 = await sw.getAttribute("aria-checked");
    await sw.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-labelledby="leaderboard-optout-label"]')?.getAttribute("aria-checked") === "false", null, { timeout: 30000 }).catch(() => {});
    const on1 = await sw.getAttribute("aria-checked");
    const saved = await optOut();
    const audit = (await q(`select metadata::text m from "AuditLog" where "tenantId" = $1 and action = 'member.update' and "entityId" = $2 order by "createdAt" desc limit 1`, [tenantId, member.id]))[0]?.m ?? "";
    L.check("profile", "P1 keyboard (Space) turns the switch off; the member is saved as hidden and the change is audited", on0 === "true" && on1 === "false" && saved === true && audit.includes("leaderboardOptOut"), { on0, on1, saved, audited: audit.includes("leaderboardOptOut") });
    await shot(page, "r12-profile-hidden");

    const t0 = Date.now();
    let gone = false;
    while (!gone && Date.now() - t0 < 100_000) { gone = !(await boardHas()); if (!gone) await tv.waitForTimeout(10_000); }
    const lagS = Math.round((Date.now() - t0) / 1000);
    L.check("board", "B2 after: the TV board drops the member within its cache window (≤ ~70 s)", gone && lagS <= 75, { gone, lagS });
    await shot(tv, "r12-board-after");

    // Forced failed save, then retry.
    await page.route(`**/api/members/${member.id}`, (r) => (r.request().method() === "PATCH" ? r.abort("failed") : r.continue()));
    await sw.click();
    const toastShown = await page.getByText(/Nothing changed/).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    const stillOff = await sw.getAttribute("aria-checked");
    L.check("failure", "F1 a failed save says nothing changed and leaves the switch off; the database is unchanged", toastShown && stillOff === "false" && (await optOut()) === true, { toastShown, stillOff });
    await page.unroute(`**/api/members/${member.id}`);
    await page.waitForTimeout(1000);
    await sw.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"][aria-labelledby="leaderboard-optout-label"]')?.getAttribute("aria-checked") === "true", null, { timeout: 30000 }).catch(() => {});
    L.check("failure", "F2 the retry turns it back on and saves", (await sw.getAttribute("aria-checked")) === "true" && (await optOut()) === false, {});

    const ph = await context(browser, "10.98.0.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const pp = await ph.newPage();
    pp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await pp.goto(`/dashboard/members/${member.id}`);
    const psw = pp.getByRole("switch", { name: "Show on the leaderboard" });
    const shown = await psw.waitFor({ timeout: 90000 }).then(() => true, () => false);
    const box = shown ? await psw.boundingBox() : null;
    const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", "M1 390 px: the switch is shown at its fixed 40×22 size, no sideways scroll", shown && box && Math.round(box.width) === 40 && Math.round(box.height) === 22 && m.scroll <= m.width + 1, { shown, box, ...m });
    await shot(pp, "r12-profile-phone");

    await page.request.post("/api/settings/display", { headers: { origin }, data: { action: "disable" } });
    L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
  } finally {
    await browser.close();
  }
} finally {
  await q(`delete from "AttendanceRecord" where id = $1`, [att]);
  await q(`delete from "ClassInstance" where id = $1`, [inst]);
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [cls, tenantId]);
  await q(`update "Member" set "leaderboardOptOut" = false where id = $1`, [member.id]);
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
