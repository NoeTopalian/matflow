// Journey: Round 11 (baseline 2.1) — a refused register tick is shown on the row that was ticked.
// A synthetic class today with 30 booked members. Owner at phone width (iPhone 13, touch) taps row 20's tick while
// POST /api/checkin is forced to refuse for that member: the refusal sentence is inside row 20, on screen, and the
// tick button keeps focus. Desktop keyboard: Space on row 20 does the same. Forced network failure on row 21, then a
// real retry: the message goes and the attendance is stored once. Nothing is stored for row 20.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-register-refusal.mjs
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, BASE } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { devices } = require("@playwright/test");

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-register-refusal");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const TIME = `${parts.hour}:00`;
const CLASS = `Register Mat ${TAG}`;
const SENTENCE = `Reg 20 ${TAG} has used all 4 classes this 4-week period and has no class-pack credit, so they can't be checked in.`;
const NET = "Couldn't reach MatFlow";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Seed: one class, today's session, 30 members booked on it ──
const classId = randomUUID(), instanceId = randomUUID();
const members = [];
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [classId, tenantId, CLASS]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [instanceId, classId, new Date(`${todayIso}T00:00:00.000Z`), TIME]);
for (let i = 1; i <= 30; i++) {
  const id = randomUUID(), name = `Reg ${String(i).padStart(2, "0")} ${TAG}`;
  await q(`insert into "Member" (id, "tenantId", email, name, "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, true, now())`,
    [id, tenantId, `${club.slug}-reg${i}-${TAG}@example.test`.toLowerCase(), name]);
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), id, classId]);
  members.push({ id, name });
}
const m20 = members[19], m21 = members[20];
const stored = async (mid) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, instanceId, mid]))[0].n);
const rowOf = (page, m) => page.getByRole("list", { name: "Register" }).getByRole("listitem").filter({ hasText: m.name });
const tick = (page, m, state = "attended") => page.getByRole("button", { name: `Mark ${m.name} ${state}`, exact: true });
const focusedLabel = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);

/** Refuse the mark for row 20 with the staff sentence; everything else goes to the server. */
async function refuseRow20(page) {
  await page.route("**/api/checkin", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && JSON.parse(req.postData() ?? "{}").memberId === m20.id) {
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: SENTENCE, reason: "allowance_reached" }) });
    }
    return route.continue();
  });
}

async function openRegister(page) {
  await ownerSignIn(page, club);
  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${esc(TIME)} · ${esc(CLASS)}`) }).first().click({ timeout: 90000 });
  await tick(page, m20).waitFor({ timeout: 60000 });
}

const browser = await chromium.launch();
try {
  // ── Phone: touch ──
  {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": "10.98.1.1" }, serviceWorkers: "block" });
    ctx.setDefaultTimeout(60000);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await openRegister(page);
    await refuseRow20(page);
    await tick(page, m20).scrollIntoViewIfNeeded();
    await tick(page, m20).tap();
    const inRow = rowOf(page, m20).getByRole("alert").filter({ hasText: SENTENCE });
    const shown = await inRow.waitFor({ timeout: 20000 }).then(() => true, () => false);
    const alerts = await page.getByRole("alert").count();
    const vh = page.viewportSize().height;
    const box = shown ? await inRow.boundingBox() : null;
    const onScreen = !!box && box.y >= 0 && box.y + box.height <= vh;
    L.check("phone", "P1 tapping row 20 of 30: the refusal is inside row 20, on screen, and is the only alert (no top banner)", shown && onScreen && alerts === 1, { shown, box, vh, alerts });
    await shot(page, "r11-register-row-refusal-phone");
    const focus = await focusedLabel(page);
    L.check("phone", "P2 the tick button for row 20 still has focus after the refusal", focus === `Mark ${m20.name} attended`, { focus });
    L.check("phone", "P3 the row stays unticked and nothing is stored for row 20", (await tick(page, m20).count()) === 1 && (await stored(m20.id)) === 0, null);
    await ctx.close();
  }

  // ── Desktop: keyboard, forced network failure, retry ──
  {
    const ctx = await context(browser, "10.98.1.2");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await openRegister(page);
    await refuseRow20(page);
    await tick(page, m20).focus();
    await page.keyboard.press("Space");
    const shown = await rowOf(page, m20).getByRole("alert").filter({ hasText: SENTENCE }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    await page.waitForTimeout(200);
    const focus = await focusedLabel(page);
    L.check("desktop", "K1 Space on row 20's tick: refusal inside row 20, focus still on that tick", shown && focus === `Mark ${m20.name} attended`, { shown, focus });

    await page.unroute("**/api/checkin");
    await page.route("**/api/checkin", (route) => (route.request().method() === "POST" ? route.abort("failed") : route.continue()));
    await tick(page, m21).click();
    const net = await rowOf(page, m21).getByRole("alert").filter({ hasText: NET }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    const row20Cleared = (await rowOf(page, m20).getByRole("alert").count()) === 0;
    L.check("desktop", "N1 a dropped request on row 21 is said on row 21 (row 20's old message is gone)", net && row20Cleared && (await stored(m21.id)) === 0, { net, row20Cleared });
    await page.unroute("**/api/checkin");
    await tick(page, m21).click();
    const marked = await tick(page, m21, "absent").waitFor({ timeout: 30000 }).then(() => true, () => false);
    const left = await page.getByRole("alert").count();
    L.check("desktop", "N2 the retry marks row 21 once and clears the message", marked && left === 0 && (await stored(m21.id)) === 1, { marked, left, stored: await stored(m21.id) });
    await shot(page, "r11-register-retry-desktop");
    await ctx.close();
  }

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  const ids = members.map((m) => m.id);
  await q(`delete from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2`, [tenantId, instanceId]).catch(() => {});
  await q(`delete from "ClassSubscription" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "ClassInstance" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]).catch(() => {});
  await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, ids]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
