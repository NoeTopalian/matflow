// Journey: Mark attendance on a day with no classes (25 Nov 2026, Noe).
// A synthetic club with a class session yesterday and one tomorrow, by the CLUB's date, and none today. At 1280 and
// 390 the page must say there are no classes today, choose neither neighbouring day's session, and offer no way to
// mark or scan into either: no selected-class card, no Change class, no By name / Scan QR, no Mark control, no
// scanner. The day's API list is empty, nothing is written, and neither session's id or class name is in the page.
//   node journeys/attendance-empty-day.mjs   (on a FRESH fixture: it refuses a club that already has classes)
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("attendance-empty-day");
const t = club.tenantId;
let stage = "start";
let lastPage = null;

// A fresh fixture only: any other class could have a session today and make this check meaningless.
const others = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1`, [t]))[0].n);
if (others > 0) throw new Error(`the fixture club already has ${others} class(es); run on a fresh fixture`);

const tz = (await q(`select timezone from "Tenant" where id = $1`, [t]))[0]?.timezone || "Europe/London";
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const [y, m, d] = [Number(parts.year), Number(parts.month), Number(parts.day)];
const marker = (offset) => new Date(Date.UTC(y, m - 1, d + offset));
const todayKey = marker(0).toISOString().slice(0, 10);
const NAMES = { yesterday: "Empty Yesterday Class", tomorrow: "Empty Tomorrow Class" };
const cls = {};
const inst = {};

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [t, Object.values(NAMES)]);
  for (const { id } of rows) {
    await q(`delete from "AttendanceRecord" where "classInstanceId" in (select id from "ClassInstance" where "classId" = $1)`, [id]).catch(() => {});
    for (const tb of ["ClassSubscription", "ClassSchedule", "ClassInstance"]) await q(`delete from "${tb}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, t]).catch(() => {});
  }
}

const members = await q(`select id from "Member" where "tenantId" = $1 and name = $2`, [t, "Member 1"]);
if (!members[0]) throw new Error("fixture has no Member 1");
for (const [when, offset] of [["yesterday", -1], ["tomorrow", 1]]) {
  cls[when] = randomUUID();
  inst[when] = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 20)`, [cls[when], t, NAMES[when]]);
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '10:00', '11:00')`, [inst[when], cls[when], marker(offset)]);
  // Member 1 is booked into both, so a register for either would have a row to mark.
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), members[0].id, cls[when]]);
}
const before = Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1`, [t]))[0].n);

const VIEW = {
  "1280": { viewport: { width: 1280, height: 800 } },
  "390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

const browser = await chromium.launch();
try {
  const oc = await context(browser, "10.96.2.1", VIEW["1280"]);
  const op = await oc.newPage();
  await ownerSignIn(op, club);
  const owner = await oc.storageState();
  await oc.close();

  for (const [tag, lane] of [["1280", 2], ["390", 3]]) {
    stage = `empty@${tag}`;
    const ctx = await context(browser, `10.96.2.${lane}`, { ...VIEW[tag], storageState: owner });
    const page = await ctx.newPage();
    lastPage = page;
    const writes = [];
    page.on("request", (r) => { if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/")) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await page.goto("/dashboard/checkin");
    const empty = page.getByTestId("no-classes-today");
    await empty.waitFor({ timeout: 60000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = (await empty.innerText()).replace(/\s+/g, " ").trim();
    const controls = {
      selectedCard: await page.getByTestId("selected-class").count(),
      changeClass: await page.getByRole("button", { name: "Change class" }).count(),
      byName: await page.getByRole("tab", { name: "By name" }).count(),
      scanQr: await page.getByRole("tab", { name: "Scan QR" }).count(),
      markButtons: await page.getByRole("button", { name: /^Mark / }).count(),
      startCamera: await page.getByRole("button", { name: "Start camera" }).count(),
      videos: await page.locator("video").count(),
      search: await page.getByLabel("Find a member").count(),
    };
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const leaks = [inst.yesterday, inst.tomorrow, NAMES.yesterday, NAMES.tomorrow].filter((s) => html.includes(s));
    const api = await page.evaluate(async () => { const r = await fetch("/api/coach/today"); const j = await r.json().catch(() => null); return { status: r.status, length: Array.isArray(j) ? j.length : null, clubDate: r.headers.get("X-Club-Date") }; });
    await shot(page, `attendance-empty-${tag}`);
    // The kiosk section is out of scope; what it shows on an empty day is recorded.
    const kiosk = page.getByTestId("kiosk-section");
    let kioskText = (await kiosk.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (await kiosk.getByRole("button", { name: "Open kiosk" }).count()) {
      await kiosk.getByRole("button", { name: "Open kiosk" }).click();
      await page.waitForTimeout(2500);
      kioskText = (await kiosk.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    }
    const kioskMarks = await kiosk.getByRole("button", { name: /^Mark |check in|Check in/ }).count();
    const stored = Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1`, [t]))[0].n);
    L.check(`E@${tag}`, "a day with sessions yesterday and tomorrow but none today: the page says there are no classes today, chooses neither, and offers no card, Change class, By name, Scan QR, Mark, search or scanner",
      text === "No classes today Add a class on the timetable and it appears here straight away." && Object.values(controls).every((n) => n === 0) && leaks.length === 0,
      { text, controls, leaks });
    L.check(`E@${tag}`, "the day's list from the API is empty for the club's date, and nothing was written",
      api.status === 200 && api.length === 0 && api.clubDate === todayKey && writes.length === 0 && stored === before, { api, todayKey, writes, attendanceRows: { before, after: stored } });
    L.note(`E@${tag}`, "what the kiosk section shows on an empty day (out of scope unless it can mark into either session)", { kioskText: kioskText.slice(0, 300), kioskMarkControls: kioskMarks });
    await ctx.close();
  }
} catch (e) {
  const seen = lastPage && !lastPage.isClosed() ? await lastPage.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ").slice(0, 600)).catch(() => null) : null;
  if (lastPage && !lastPage.isClosed()) await shot(lastPage, "attendance-empty-failure").catch(() => {});
  L.check("run", "ran to the end", false, { stage, error: String(e).split("\n")[0].slice(0, 200), seen });
} finally {
  await browser.close().catch(() => {});
  await cleanup();
  const left = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = any($2)`, [t, Object.values(NAMES)]))[0].n);
  L.check("cleanup", "the two classes, their sessions and bookings are removed", left === 0, { left });
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
