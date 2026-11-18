// Round 13 walk (brief: "Coach — open the timetable, take attendance and understand refusals within existing
// permissions"). The coach-on-phone register was not walked (round13-acceptance-matrix §C). A coach (no authenticator,
// as lib/mfa-policy.ts allows) signs in on a phone, finds today's class on the timetable, opens the register and:
//   - ticks an eligible member: stored once;
//   - ticks a member whose weekly class is already used: the SERVER refuses (no forced response), the refusal says
//     why on screen, and nothing is stored;
//   - loses a tick to the network: told, nothing stored; the retry stores it exactly once;
//   - is refused an owner-only action (settings) by the server.
// Outcomes only, so it holds on main and on the Round 11 branch (#100 moves the refusal onto the row).
// Needs `fixture.mjs create` and `server.mjs start` (or run-journeys.mjs).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, seedStaff, staffSignIn, BASE } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { devices } = require("@playwright/test");

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("walk-coach-phone-register");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayMarker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const TIME = `${parts.hour}:00`;
const CLASS = `Coach Walk ${TAG}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Seed: a weekly-limited plan, one class today, three booked members. "Used" already attended another class today.
const tier = randomUUID(), classId = randomUUID(), instanceId = randomUUID(), otherClass = randomUUID(), otherInst = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "updatedAt") values ($1, $2, $3, 0, 'GBP', 'monthly', 1, 'week', now())`, [tier, tenantId, `Once Weekly ${TAG}`]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50), ($4, $2, $5, 60, 50)`, [classId, tenantId, CLASS, otherClass, `Earlier ${TAG}`]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [randomUUID(), classId, todayMarker.getUTCDay(), TIME]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $4), ($5, $6, $3, '06:00', '07:00')`, [instanceId, classId, todayMarker, TIME, otherInst, otherClass]);
const members = {};
for (const key of ["Eligible", "Used", "Retry"]) {
  const id = randomUUID(), name = `${key} ${TAG}`;
  await q(`insert into "Member" (id, "tenantId", email, name, "waiverAccepted", "membershipTierId", "updatedAt") values ($1, $2, $3, $4, true, $5, now())`,
    [id, tenantId, `${club.slug}-${key.toLowerCase()}-${TAG}@example.test`.toLowerCase(), name, tier]);
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), id, classId]);
  members[key] = { id, name };
}
await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), tenantId, members.Used.id, otherInst]);
const stored = async (m) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, instanceId, m.id]))[0].n);
const tick = (page, m) => page.getByRole("button", { name: `Mark ${m.name} attended`, exact: true });
const ourAlerts = (page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const coach = await seedStaff(club, "coach", { name: `Coach ${TAG}` });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": "10.132.0.1" }, serviceWorkers: "block" });
  ctx.setDefaultTimeout(60000);
  ctx.setDefaultNavigationTimeout(120000);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await staffSignIn(page, club, coach);
  L.check("journey", "C1 the coach signs in on a phone through the real form, without an authenticator", !new URL(page.url()).pathname.startsWith("/login"), new URL(page.url()).pathname);

  await page.goto("/dashboard/timetable");
  const onTimetable = await page.getByText(CLASS).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("journey", "C2 today's class is on the coach's timetable", onTimetable);
  const t = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 the timetable at phone width has no horizontal page scroll", t.scroll <= t.width + 1, t);
  await shot(page, "walk-coach-timetable");

  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${esc(TIME)} · ${esc(CLASS)}`) }).first().click({ timeout: 90000 });
  await tick(page, members.Eligible).waitFor({ timeout: 60000 });
  const r = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M2 the register at phone width has no horizontal page scroll", r.scroll <= r.width + 1, r);
  const box = await tick(page, members.Eligible).boundingBox();
  L.check("mobile", "M3 a register tick is at least 44 × 44 px", !!box && box.width >= 44 && box.height >= 44, box);
  await shot(page, "walk-coach-register");

  // A1: an eligible member, stored once.
  const a1 = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/checkin", { timeout: 60000 });
  await tick(page, members.Eligible).tap();
  const a1r = await a1;
  await page.waitForTimeout(500);
  L.check("attendance", "A1 ticking an eligible member stores exactly one attendance", a1r.ok() && (await stored(members.Eligible)) === 1, { status: a1r.status(), rows: await stored(members.Eligible) });

  // A2: the server's own refusal (weekly class already used), said on screen, nothing stored.
  const a2 = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/checkin", { timeout: 60000 });
  await tick(page, members.Used).tap();
  const a2r = await a2;
  const refusal = ourAlerts(page).filter({ hasText: /can.t be checked in/ }).first();
  const said = await refusal.waitFor({ timeout: 20000 }).then(() => true, () => false);
  const text = said ? (await refusal.textContent())?.trim() : null;
  L.check("refusal", "A2 the server refuses the member whose weekly class is used (4xx), and nothing is stored", !a2r.ok() && a2r.status() < 500 && (await stored(members.Used)) === 0, { status: a2r.status(), rows: await stored(members.Used) });
  L.check("refusal", "A3 the refusal names the member and says why, on screen", said && !!text && text.includes(members.Used.name), { text });
  await shot(page, "walk-coach-refusal");

  // F1: the network drops a tick. Told; nothing stored. R1: the retry stores it exactly once.
  let posts = 0;
  await page.route("**/api/checkin", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts += 1;
    return route.abort("failed");
  });
  await tick(page, members.Retry).tap();
  const lost = await ourAlerts(page).filter({ hasText: /reach|connection|try again/i }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  L.check("failure", "F1 a tick lost to the network is reported and stores nothing", lost && posts === 1 && (await stored(members.Retry)) === 0, { lost, posts, rows: await stored(members.Retry) });
  await page.unroute("**/api/checkin");
  const sent = [];
  const onReq = (req) => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/checkin") sent.push(1); };
  page.on("request", onReq);
  await tick(page, members.Retry).tap();
  await page.waitForTimeout(2500);
  page.off("request", onReq);
  L.check("retry", "R1 the retry sends one request and stores the attendance exactly once", sent.length === 1 && (await stored(members.Retry)) === 1, { requests: sent.length, rows: await stored(members.Retry) });
  await page.reload();
  await page.getByRole("button", { name: new RegExp(`${esc(TIME)} · ${esc(CLASS)}`) }).first().click({ timeout: 90000 }).catch(() => {});
  const shownMarked = await page.getByRole("button", { name: new RegExp(`${esc(members.Retry.name)}.*(attended|absent|Unmark)`, "i") }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  L.note("retry", "N1 after reload the register shows the retried member as marked (control label measured, not asserted)", shownMarked);

  // P1: within existing permissions — the server refuses a coach an owner-only change.
  const p1 = await page.request.patch(`${BASE}/api/settings`, { data: { name: "Coach rename attempt" }, failOnStatusCode: false });
  L.check("permissions", "P1 the server refuses a coach an owner-only settings change (401/403)", p1.status() === 401 || p1.status() === 403, { status: p1.status() });

  const other = errors.filter((e) => !/Minified React error #418/.test(e));
  if (other.length !== errors.length) L.note("journey", "N2 pre-existing hydration text mismatch (#418) seen", errors.length - other.length);
  L.check("journey", "C3 no other uncaught page errors", other.length === 0, other);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
