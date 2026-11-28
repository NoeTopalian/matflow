// Journey: session cover — the acceptance test in Noe's specification of 26 Nov 2026.
// Two Thursdays of one class ("Adults Gi", Mat 2, regular coach Alex Regular) and a simultaneous session on another
// mat ("Kids BJJ", Mat 1, Kim Kids). The owner requests cover for the first Thursday (with a forced network failure and
// a forced server error first: nothing is saved, the retry sends one request). Kim, already teaching at that time, is
// refused and told which session. Two other coaches confirm "I'll cover this class" at the same moment: exactly one
// wins and the other reads "Already covered by [name]." Nobody is double-booked, next Thursday is untouched, and the
// owner, the covering coach and a member see the right thing at 1280 and 390. Activity records who requested and who
// accepted. Round 2 (review of 5f92f724): a claimed session cancelled and restored recommits nobody; deactivating the
// covering coach makes the session read Cover needed to staff and Coach to be confirmed to a member; archiving and
// restoring the class ends the cover for good. Synthetic club only.
//   node journeys/session-cover.mjs
//   MF_COVER_R4_ONLY=1: only the round-4 checks (section 11), after the owner and member sign in. A diagnostic for a
//   day when an earlier section cannot pass for a reason this round did not cause (27 Nov 2026: member home past its
//   15 s budget from Bali on 121529e4 too); the ledger says so with a NOTE.
import { randomUUID, randomBytes } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, staffSignIn, memberLogin, memberSignIn, bcrypt, chooseRegisterClass } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("session-cover");
const t = club.tenantId;
let stage = "start";
let lastPage = null;
const errors = [];

const tz = (await q(`select timezone from "Tenant" where id = $1`, [t]))[0]?.timezone || "Europe/London";
const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (key, n) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// The next Thursday strictly after today (club date), and the one after it.
const dow = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
const thu1 = addDays(todayKey, ((4 - dow + 7) % 7) || 7);
const thu2 = addDays(thu1, 7);
const dayLabel = (key) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));
const THU1_LABEL = dayLabel(thu1);
const CLASSES = ["Cover Adults Gi", "Cover Kids BJJ", "Cover Late", "Cover Twice"];
// Today, for the staff dashboard, the timetable and the register: one class per coach state and capacity state.
const DASH = [
  { key: "regular", name: "Dash Regular", place: "Mat 5", cap: 10, attend: 0, coach: "alex", cover: null, wantCoach: "Alex Regular", wantStatus: "Ready" },
  { key: "nocoach", name: "Dash No Coach", place: "Mat 6", cap: 1, attend: 1, coach: null, cover: null, wantCoach: "No coach assigned", wantStatus: "Full" },
  { key: "covered", name: "Dash Covered", place: "Mat 7", cap: 1, attend: 2, coach: "kim", cover: "covered", wantCoach: "Covered by Casey Cover", wantStatus: "Over capacity" },
  { key: "requested", name: "Dash Requested", place: "Mat 8", cap: 10, attend: 0, coach: "alex", cover: "open", wantCoach: "Cover needed · Alex Regular away", wantStatus: "Ready" },
];
// Round 4: a weekly-slot move onto a session the same coach covers, and two classes of one regular coach at once.
const R4_CLASSES = ["Cover R4 Own", "Cover R4 Covered", "Cover R4 Kids", "Cover R4 Adults"];
const ALL_CLASSES = [...CLASSES, ...DASH.map((d) => d.name), ...R4_CLASSES];

/** A staff member of the fixture club with a password (synthetic address; coaches have no authenticator). */
async function coach(key, name) {
  const email = `cover-${key}-${club.slug}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const rows = await q(
    `insert into "User" (id, "tenantId", email, "passwordHash", name, role, "updatedAt") values ($1, $2, $3, $4, $5, 'coach', now())
     on conflict ("tenantId", email) do update set "passwordHash" = excluded."passwordHash", name = excluded.name, role = 'coach', "deactivatedAt" = null, "failedLoginCount" = 0, "lockedUntil" = null, "updatedAt" = now()
     returning id`,
    [randomUUID(), t, email, await bcrypt.hash(password, 10), name],
  );
  return { id: rows[0].id, email, password, secret: null, role: "coach", name };
}

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [t, ALL_CLASSES]);
  for (const { id } of rows) {
    await q(`delete from "SessionCover" where "tenantId" = $1 and "classInstanceId" in (select id from "ClassInstance" where "classId" = $2)`, [t, id]).catch(() => {});
    await q(`delete from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" in (select id from "ClassInstance" where "classId" = $2)`, [t, id]).catch(() => {});
    for (const tb of ["ClassSubscription", "ClassSchedule", "ClassInstance"]) await q(`delete from "${tb}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, t]).catch(() => {});
  }
}
await cleanup();

const alex = await coach("alex", "Alex Regular");
const kim = await coach("kim", "Kim Kids");
const casey = await coach("casey", "Casey Cover");
const robin = await coach("robin", "Robin Relief");
const ids = { adults: randomUUID(), kids: randomUUID(), late: randomUUID(), twice: randomUUID(), thu1: randomUUID(), thu2: randomUUID(), kidsThu1: randomUUID(), lateThu1: randomUUID(), morning: randomUUID(), noon: randomUUID() };
for (const [id, name, place, coachId] of [[ids.adults, CLASSES[0], "Mat 2", alex.id], [ids.kids, CLASSES[1], "Mat 1", kim.id]]) {
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location, "coachUserId") values ($1, $2, $3, 90, 20, $4, $5)`, [id, t, name, place, coachId]);
  // A Thursday slot from the first Thursday on, so the member's timetable has the class and nothing earlier is minted.
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate") values ($1, $2, 4, '19:00', '20:30', $3)`, [randomUUID(), id, new Date(`${thu1}T00:00:00Z`)]);
}
for (const [id, classId, day] of [[ids.thu1, ids.adults, thu1], [ids.thu2, ids.adults, thu2], [ids.kidsThu1, ids.kids, thu1]]) {
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '19:00', '20:30')`, [id, classId, new Date(`${day}T00:00:00Z`)]);
}
// Kids BJJ is a kids class, so a member's next class is Adults Gi.
await q(`update "Class" set "isKids" = true where id = $1 and "tenantId" = $2`, [ids.kids, t]);
// A Mat 1 class starting as Kids BJJ ends (back to back), and one class twice on the first Thursday (07:00 and 12:00, Mat 3).
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location) values ($1, $2, $3, 60, 20, 'Mat 1')`, [ids.late, t, CLASSES[2]]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '20:30', '21:30')`, [ids.lateThu1, ids.late, new Date(`${thu1}T00:00:00Z`)]);
// A kids class, so the member's next class stays Adults Gi (the 07:00 session would otherwise come first).
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location, "isKids") values ($1, $2, $3, 60, 20, 'Mat 3', true)`, [ids.twice, t, CLASSES[3]]);
for (const [start, end] of [["07:00", "08:00"], ["12:00", "13:00"]]) {
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate") values ($1, $2, 4, $3, $4, $5)`, [randomUUID(), ids.twice, start, end, new Date(`${thu1}T00:00:00Z`)]);
}
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '07:00', '08:00'), ($4, $2, $3, '12:00', '13:00')`, [ids.morning, ids.twice, new Date(`${thu1}T00:00:00Z`), ids.noon]);
/** Next Thursday's session: no cover row, and the weekly class still has Alex. Checked after every transition. */
const nextWeekUntouched = async () => (await q(`select count(*)::int as n from "SessionCover" where "classInstanceId" = $1`, [ids.thu2]))[0].n === 0
  && (await q(`select "coachUserId" from "Class" where id = $1`, [ids.adults]))[0].coachUserId === alex.id;
// Today's four classes at 22:00, each on its own mat; kids classes, so the member's next class stays Adults Gi.
const todayDow = new Date(`${todayKey}T00:00:00Z`).getUTCDay();
const members = await q(`select id from "Member" where "tenantId" = $1 and name in ('Member 1', 'Member 2') order by name`, [t]);
for (const d of DASH) {
  d.classId = randomUUID();
  d.instanceId = randomUUID();
  const coachId = d.coach === "alex" ? alex.id : d.coach === "kim" ? kim.id : null;
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location, "coachUserId", "isKids") values ($1, $2, $3, 30, $4, $5, $6, true)`, [d.classId, t, d.name, d.cap, d.place, coachId]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate") values ($1, $2, $3, '22:00', '22:30', $4)`, [randomUUID(), d.classId, todayDow, new Date(`${todayKey}T00:00:00Z`)]);
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '22:00', '22:30')`, [d.instanceId, d.classId, new Date(`${todayKey}T00:00:00Z`)]);
  for (const m of members.slice(0, d.attend)) await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), t, m.id, d.instanceId]);
  if (d.cover) {
    await q(`insert into "SessionCover" (id, "tenantId", "classInstanceId", status, "coverUserId", "requestedById", "updatedAt") values ($1, $2, $3, $4, $5, $6, now())`, [randomUUID(), t, d.instanceId, d.cover, d.cover === "covered" ? casey.id : null, club.owner.id]);
  }
}
const coverRow = async (instanceId) => (await q(`select status, "coverUserId", "closedReason" from "SessionCover" where "tenantId" = $1 and "classInstanceId" = $2`, [t, instanceId]))[0] ?? null;

const VIEW = { "1280": { viewport: { width: 1280, height: 800 } }, "390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };
const browser = await chromium.launch();
const watch = (page, who) => page.on("pageerror", (e) => errors.push(`${who}: ${String(e).slice(0, 200)}`));
const noSideways = (page) => page.evaluate(() => {
  const main = document.querySelector("main");
  return { document: document.documentElement.scrollWidth > window.innerWidth + 1, main: !!main && main.scrollWidth > main.clientWidth + 1 };
});
const openBoard = async (page) => {
  await page.goto("/dashboard/cover");
  await page.getByTestId("cover-board").waitFor({ timeout: 90000 });
};
/** The session's row in the Sessions list, turning to later weeks until it is on screen. */
async function sessionRow(page, instanceId) {
  const row = page.locator(`[data-testid="cover-week"] li[data-session-id="${instanceId}"]`);
  for (let i = 0; i < 3 && !(await row.count()); i++) {
    await page.getByRole("button", { name: "Later" }).click();
    await page.waitForTimeout(500);
    await page.locator(`[data-testid="cover-week"]`).waitFor();
    await row.first().waitFor({ timeout: 30000 }).catch(() => {});
  }
  return row.first();
}

/** Request cover on a session from its row (the owner's Class cover page) and wait for "Cover needed". */
async function requestVia(page, instanceId) {
  const r = await sessionRow(page, instanceId);
  await r.getByRole("button", { name: "Request cover" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Request cover" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60000 });
  await (await sessionRow(page, instanceId)).getByTestId("cover-state").filter({ hasText: "Cover needed" }).waitFor({ timeout: 60000 });
}
/** A cover action from a session's row or card, confirmed, and the note it leaves beside the session. */
async function actOn(page, scope, instanceId, label, confirmLabel = label) {
  const where = scope.includes("cover-week") ? await sessionRow(page, instanceId) : page.locator(`${scope} [data-session-id="${instanceId}"]`).first();
  await where.getByRole("button", { name: label }).click();
  await page.getByRole("dialog").getByRole("button", { name: confirmLabel }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60000 });
  const note = page.locator(`[data-session-id="${instanceId}"] [data-testid="cover-note"]`).first();
  await note.waitFor({ timeout: 60000 });
  return (await note.innerText()).trim();
}
/** The session row's state, after waiting (up to a minute) for the board's re-read to show `expected`. The state must
 * START with it: a coach's name alone is also inside the stale "Cover needed · <name> away", so a plain substring wait
 * returns before the re-read lands. */
async function stateAfter(page, instanceId, expected) {
  const r = await sessionRow(page, instanceId);
  const starts = new RegExp(`^\\s*${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  await r.getByTestId("cover-state").filter({ hasText: starts }).waitFor({ timeout: 60000 }).catch(() => {});
  return (await (await sessionRow(page, instanceId)).getByTestId("cover-state").innerText()).trim();
}
/** PATCH the class's weekly slots from the owner's own page (the timetable form's route), as the owner. */
const editSlots = (page, classId, name, schedules) => page.evaluate(async ({ classId, name, schedules }) => {
  const r = await fetch(`/api/classes/${classId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, schedules }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, { classId, name, schedules });

/** The owner signed in once; the saved state is reused by every owner context. */
async function oc0(b) {
  const ctx = await context(b, "10.98.7.20", VIEW["1280"]);
  const page = await ctx.newPage();
  await ownerSignIn(page, club);
  const st = await ctx.storageState();
  await ctx.close();
  return st;
}

// ── 11. Round 4 (review of 121529e4), as a function: run at the end of the full journey, or on its own with
// MF_COVER_R4_ONLY=1 (only the owner and member sign-ins before it).
async function round4({ op, opPhone, mp, ownerFetch }) {
  // 11a. Fern covers Cover R4 Covered (19:00–20:00, Mat 10) right after Fern's own Cover R4 Own (18:00–19:00, Mat 9):
  // back to back, allowed. The owner moves Cover R4 Own's weekly slot to 19:00 with the same coach: one person on two
  // overlapping sessions, one a cover. Staff see a flag naming the other session on both; members never see Fern twice.
  stage = "round4-slot-move";
  const fern = await coach("fern", "Fern Flag");
  const r4own = { classId: randomUUID(), instanceId: randomUUID() };
  const r4cov = { classId: randomUUID(), instanceId: randomUUID() };
  for (const [c, name, place, coachId, start, end] of [[r4own, R4_CLASSES[0], "Mat 9", fern.id, "18:00", "19:00"], [r4cov, R4_CLASSES[1], "Mat 10", null, "19:00", "20:00"]]) {
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location, "coachUserId", "isKids") values ($1, $2, $3, 60, 20, $4, $5, true)`, [c.classId, t, name, place, coachId]);
    await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate") values ($1, $2, 4, $3, $4, $5)`, [randomUUID(), c.classId, start, end, new Date(`${thu1}T00:00:00Z`)]);
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [c.instanceId, c.classId, new Date(`${thu1}T00:00:00Z`), start, end]);
  }
  L.check("R4A", "Fern is assigned to Cover R4 Covered, straight after Fern's own class (back to back)", (await ownerFetch(`/api/coach/instances/${r4cov.instanceId}/cover`, "POST", { action: "assign", coachUserId: fern.id })) === 200);
  const r4move = await editSlots(op, r4own.classId, R4_CLASSES[0], [{ dayOfWeek: 4, startTime: "19:00", endTime: "20:00" }]);
  L.check("R4A", "the owner moves Cover R4 Own to 19:00–20:00 with the same coach (saved: the class form allows it)", r4move.status === 200, r4move.status);
  const movedId = (await q(`select id from "ClassInstance" where "classId" = $1 and date = $2 and "startTime" = '19:00'`, [r4own.classId, new Date(`${thu1}T00:00:00Z`)]))[0]?.id;
  const flagOwn = `Clash: ${fern.name} is also teaching ${R4_CLASSES[1]} on ${THU1_LABEL}, 19:00–20:00, Mat 10`;
  const flagCov = `Clash: ${fern.name} is also teaching ${R4_CLASSES[0]} on ${THU1_LABEL}, 19:00–20:00, Mat 9`;
  for (const [tag, page] of [["1280", op], ["390", opPhone]]) {
    await openBoard(page);
    const ownRow = await sessionRow(page, movedId);
    const covRow = await sessionRow(page, r4cov.instanceId);
    const ownFlag = ownRow.getByTestId("clash-flag");
    const covFlag = covRow.getByTestId("clash-flag");
    await ownFlag.waitFor({ timeout: 60000 }).catch(() => {});
    const seen = { own: (await ownFlag.isVisible()) ? (await ownFlag.innerText()).trim() : null, cov: (await covFlag.isVisible()) ? (await covFlag.innerText()).trim() : null };
    L.check(`R4A@${tag}`, "the clash flag is visible on both sessions, each naming the other session (class, day, time, mat)", seen.own === flagOwn && seen.cov === flagCov, seen);
    const states = { own: (await ownRow.getByTestId("cover-state").innerText()).trim(), cov: (await covRow.getByTestId("cover-state").innerText()).trim() };
    L.check(`R4A@${tag}`, "the regular side reads Coach to be confirmed (not Fern); the cover side still reads Covered by Fern Flag", states.own === "Coach to be confirmed" && states.cov === `Covered by ${fern.name}`, states);
    // Keyboard: from the session's time line, Tab reaches the flag itself, and its text is what is read.
    await ownRow.locator("p").first().click();
    let reached = null;
    for (let i = 0; i < 8 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate((id) => {
        const a = document.activeElement;
        return a?.getAttribute("data-testid") === "clash-flag" && a.closest("[data-session-id]")?.getAttribute("data-session-id") === id ? a.textContent.trim() : null;
      }, movedId);
    }
    L.check(`R4A@${tag}`, "the flag is reached with Tab and its text is the clash sentence", reached === flagOwn, reached);
    L.check(`R4A@${tag}`, "no sideways scroll on the board with the flag", !Object.values(await noSideways(page)).some(Boolean), await noSideways(page));
    await shot(page, `session-cover-r4-clash-${tag}`);
  }
  const r4sched = await (await mp.request.get(`/api/member/schedule?date=${thu1}`)).json();
  const mOwn = r4sched.find((e) => e.classId === r4own.classId && e.dayOfWeek === 4);
  const mCov = r4sched.find((e) => e.classId === r4cov.classId && e.dayOfWeek === 4);
  L.check("R4A@390", "the member reads Coach to be confirmed on the regular side and Fern Flag on the cover; no flag or clash text reaches them", mOwn?.coach === "Coach to be confirmed" && mCov?.coach === fern.name && !JSON.stringify(r4sched).includes("Clash"), { own: mOwn?.coach, cov: mCov?.coach });
  L.check("N", "next Thursday untouched after round 4's slot move", await nextWeekUntouched());

  // 11b. Gus heads Cover R4 Kids and Cover R4 Adults at 17:00 on two mats (the class form allows it). A request on Kids
  // can be withdrawn (1280) and returned to Gus (390): the regular-versus-regular overlap no longer blocks them.
  stage = "round4-withdraw-open";
  const gus = await coach("gus", "Gus Twice");
  const r4kids = { classId: randomUUID(), instanceId: randomUUID() };
  for (const [c, name, place] of [[r4kids, R4_CLASSES[2], "Mat 11"], [{ classId: randomUUID(), instanceId: randomUUID() }, R4_CLASSES[3], "Mat 12"]]) {
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", location, "coachUserId", "isKids") values ($1, $2, $3, 60, 20, $4, $5, true)`, [c.classId, t, name, place, gus.id]);
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '17:00', '18:00')`, [c.instanceId, c.classId, new Date(`${thu1}T00:00:00Z`)]);
  }
  for (const [tag, page, label, confirm, okNote, endStatus] of [["1280", op, "Withdraw request", "Withdraw request", "Cover request withdrawn.", "withdrawn"], ["390", opPhone, "Return to regular coach", "Return to regular coach", "Back to its regular coach.", "closed"]]) {
    await openBoard(page);
    await requestVia(page, r4kids.instanceId);
    const note = await actOn(page, '[data-testid="cover-week"]', r4kids.instanceId, label, confirm);
    const st = await stateAfter(page, r4kids.instanceId, gus.name);
    L.check(`R4B@${tag}`, `${label} on an open request is allowed while Gus heads another class at the same time`, note === okNote && st === gus.name && (await coverRow(r4kids.instanceId))?.status === endStatus, { note, st, row: await coverRow(r4kids.instanceId) });
    await shot(page, `session-cover-r4-${endStatus}-${tag}`);
  }
}

try {
  main: {
  if (process.env.MF_COVER_R4_ONLY === "1") {
    stage = "round4-sign-in";
    L.note("R4", "round-4-only run (MF_COVER_R4_ONLY=1): sections 0 to 10 not run", "");
    const ownerFirst = await oc0(browser);
    const op = await (await context(browser, "10.98.7.31", { ...VIEW["1280"], storageState: ownerFirst })).newPage();
    lastPage = op;
    watch(op, "owner-r4");
    const opPhone = await (await context(browser, "10.98.7.32", { ...VIEW["390"], storageState: ownerFirst })).newPage();
    watch(opPhone, "owner-390-r4");
    const member = await memberLogin(club, "Member 1");
    await q(`update "Member" set "onboardingCompleted" = true where id = $1 and "tenantId" = $2`, [member.id, t]);
    const mp = await (await context(browser, "10.98.7.33", VIEW["390"])).newPage();
    watch(mp, "member-r4");
    await memberSignIn(mp, club, member);
    await op.goto("/dashboard/cover");
    const ownerFetch = (url, method, body) => op.evaluate(async ({ url, method, body }) => (await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status, { url, method, body });
    await round4({ op, opPhone, mp, ownerFetch });
    break main;
  }
  // ── 0. Staff dashboard, timetable, register and cover page: the three coach states stay distinct ────────────────
  stage = "dashboard";
  const ownerFirst = await oc0(browser);
  for (const [tag, lane] of [["1280", 21], ["390", 22]]) {
    const ctx = await context(browser, `10.98.7.${lane}`, { ...VIEW[tag], storageState: ownerFirst });
    const page = await ctx.newPage();
    lastPage = page;
    watch(page, `dash-${tag}`);
    await page.goto("/dashboard");
    for (const d of DASH) {
      const card = page.locator(`a[href="/dashboard/checkin?class=${d.instanceId}"]`).first();
      await card.waitFor({ timeout: 90000 });
      const lines = await card.evaluate((el) => [...el.querySelectorAll("p, span")].map((x) => ({ text: x.textContent.trim(), color: x.getAttribute("style") || "" })));
      const coachLine = lines.find((l) => l.text.startsWith(d.wantCoach.split(" · ")[0]) || l.text.startsWith(d.wantCoach));
      const statusText = lines.map((l) => l.text).find((x) => ["Ready", "Full", "Over capacity"].includes(x));
      L.check(`D@${tag}`, `Today's Classes: ${d.name} names its coach as "${d.wantCoach}"`, !!coachLine && coachLine.text.startsWith(d.wantCoach), lines.map((l) => l.text));
      L.check(`D@${tag}`, `Today's Classes: ${d.name} status reads ${d.wantStatus}`, statusText === d.wantStatus, { statusText, lines: lines.map((l) => l.text) });
      if (d.key === "nocoach") {
        L.check(`D@${tag}`, "No coach assigned is quiet (muted text, no pill), and Cover needed is not shown", coachLine?.color.includes("--tx-3") && !lines.some((l) => /Cover needed|Needs coach/.test(l.text)), lines);
      }
    }
    // The week calendar on the same page.
    const week = await page.evaluate((names) => {
      const btn = document.querySelector('[aria-label="Previous week"]');
      let root = btn;
      while (root && !names.every((n) => (root.innerText || "").includes(n))) root = root.parentElement;
      if (!root) return null;
      const out = {};
      for (const n of names) {
        const hit = [...root.querySelectorAll("p, span")].find((el) => el.children.length === 0 && el.textContent.includes(n) && el.offsetParent && !el.closest('a[href^="/dashboard/checkin"]'));
        // Up to the pill itself: the first ancestor that also holds the session's time.
        let pill = hit ? hit.parentElement : null;
        while (pill && !pill.innerText.includes("22:00")) pill = pill.parentElement;
        out[n] = pill ? pill.innerText.replace(/\s+/g, " ").trim() : null;
      }
      return out;
    }, DASH.map((d) => d.name));
    if (week) {
      for (const d of DASH) L.check(`W@${tag}`, `week calendar: ${d.name} shows "${d.wantCoach}"`, (week[d.name] || "").includes(d.wantCoach) && (d.key !== "nocoach" || !(week[d.name] || "").includes("Cover needed")), week[d.name]);
    } else {
      L.note(`W@${tag}`, "week calendar: not every class of today is on screen at this width", null);
    }
    await shot(page, `session-cover-dashboard-${tag}`);
    // The timetable's chips for today: a cover note only where cover was asked for or accepted. On a desktop the Day
    // view draws the whole day; a chip the grid folds into "+N more" is recorded as folded, and the week's cover read
    // the chips are drawn from is checked as well.
    // The chips' cover lines come from the week's cover read, which can take several seconds from here: wait for it.
    const coverRead = page.waitForResponse((r) => r.url().includes("/api/coach/cover?from="), { timeout: 120000 }).catch(() => null);
    await page.goto("/dashboard/timetable");
    const coverResponse = await coverRead;
    L.note(`T@${tag}`, "the timetable's week cover read answered", coverResponse ? coverResponse.status() : "no response within 120 s");
    if (tag === "1280") await page.getByRole("button", { name: "Day", exact: true }).click().catch(() => {});
    const chipOf = (name) => page.locator('[data-chip-part="name"]', { hasText: name }).first().locator("xpath=ancestor::button[1]");
    await page.locator('[data-chip-part="name"]', { hasText: DASH[1].name }).first().waitFor({ timeout: 90000 });
    await page.waitForTimeout(1500);
    const chips = {};
    for (const d of DASH) {
      const c = chipOf(d.name);
      chips[d.key] = (await c.count()) ? (await c.locator('[data-chip-part="cover"]').allInnerTexts()).join(" | ") : "folded";
    }
    // A folded class is read from the "+N more" panel's row, which carries the same cover line.
    if (Object.values(chips).includes("folded")) {
      await page.getByRole("button", { name: /more sessions, 22:00/ }).first().click().catch(() => {});
      for (const d of DASH) {
        if (chips[d.key] !== "folded") continue;
        const row = page.getByTestId("more-row").filter({ hasText: d.name }).first();
        await row.waitFor({ timeout: 30000 }).catch(() => {});
        chips[d.key] = (await row.count()) ? (await row.locator('[data-chip-part="cover"]').allInnerTexts()).join(" | ") : "folded";
      }
    }
    const read = Object.fromEntries(((await (await page.request.get(`/api/coach/cover?from=${todayKey}&days=1`)).json()).sessions || []).filter((x) => DASH.some((d) => d.instanceId === x.id)).map((x) => [x.className, x.coachLabel]));
    L.check(`T@${tag}`, "timetable (chips and the +N more rows): Cover needed / Covered by only on the classes with cover; never on the coachless class or the regular one", chips.nocoach === "" && chips.regular === "" && chips.covered === "Covered by Casey Cover" && chips.requested === "Cover needed · Alex Regular away", { chips, read });
    L.check(`T@${tag}`, "timetable's cover read for the day: the coachless and regular classes carry no cover label", read["Dash No Coach"] === null && read["Dash Regular"] === "Alex Regular" && read["Dash Covered"] === "Covered by Casey Cover" && read["Dash Requested"] === "Cover needed · Alex Regular away", read);
    await shot(page, `session-cover-timetable-${tag}`);
    await ctx.close();
  }
  // The register (Mark attendance's list, and its Session details for the coachless class).
  const regCtx = await context(browser, "10.98.7.23", { ...VIEW["1280"], storageState: ownerFirst });
  const rp0 = await regCtx.newPage();
  watch(rp0, "register");
  await rp0.goto("/dashboard/checkin");
  const todayList = await (await rp0.request.get("/api/coach/today")).json();
  const byName = Object.fromEntries(todayList.map((x) => [x.name, x.coachName]));
  L.check("G", "register list: each class's coach as the resolver says; the coachless class has none and never Cover needed", DASH.every((d) => (d.key === "nocoach" ? byName[d.name] === null : byName[d.name] === d.wantCoach)), byName);
  await chooseRegisterClass(rp0, "22:00", DASH[1].name);
  await rp0.getByRole("button", { name: /Session details/ }).click();
  const coachDd = (await rp0.locator('#session-details-panel dd').first().innerText()).trim();
  L.check("G", "register Session details: the coachless class reads No coach assigned", coachDd === "No coach assigned", coachDd);
  await regCtx.close();
  // The cover page row of the coachless class.
  const cpCtx = await context(browser, "10.98.7.24", { ...VIEW["390"], storageState: ownerFirst });
  const cp0 = await cpCtx.newPage();
  watch(cp0, "cover-page");
  await openBoard(cp0);
  const ncRow = cp0.locator(`[data-testid="cover-week"] li[data-session-id="${DASH[1].instanceId}"]`);
  await ncRow.waitFor({ timeout: 60000 });
  const nc = await ncRow.getByTestId("cover-state").evaluate((el) => ({ text: el.textContent.trim(), muted: el.className.includes("text-tx-3") }));
  L.check("A@390", "cover page: the coachless class with no request reads No coach assigned (muted), never Cover needed", nc.text === "No coach assigned" && nc.muted, nc);
  await cpCtx.close();

  // ── 1. The owner requests cover for the first Thursday (desktop) ───────────────────────────────────────────────
  stage = "owner-request";
  const oc = await context(browser, "10.98.7.1", VIEW["1280"]);
  const op = await oc.newPage();
  lastPage = op;
  watch(op, "owner");
  await ownerSignIn(op, club);
  const ownerState = await oc.storageState();
  await openBoard(op);
  let row = await sessionRow(op, ids.thu1);
  L.check("A", "the first Thursday's session is listed with its regular coach and Request cover", (await row.innerText()).includes("Alex Regular"), (await row.innerText()).replace(/\s+/g, " "));
  // Keyboard: reach Request cover with Tab-free focus, open it with Enter, close it with Escape.
  const requestBtn = row.getByRole("button", { name: "Request cover" });
  await requestBtn.focus();
  await op.keyboard.press("Enter");
  const dialog = op.getByRole("dialog");
  await dialog.waitFor();
  const title = (await dialog.getByRole("heading").first().innerText()).trim();
  const wantTitle = `Request cover for ${THU1_LABEL}, 19:00–20:30, Mat 2?`;
  L.check("A", "confirmation names the date, time and mat exactly", title === wantTitle, { title, wantTitle });
  L.check("A", "confirmation says this Thursday only", (await dialog.innerText()).includes("This Thursday only."), (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 200));
  await op.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  L.check("A", "Escape closes it and nothing is saved", (await coverRow(ids.thu1)) === null, await coverRow(ids.thu1));

  // Forced failures: a dropped connection, then a server error. The message stays in the dialog; nothing is saved.
  await requestBtn.click();
  await dialog.waitFor();
  await op.route("**/api/coach/instances/*/cover", (r) => r.abort());
  await dialog.getByRole("button", { name: "Request cover" }).click();
  const dialogError = dialog.getByTestId("cover-dialog-error");
  await dialogError.waitFor();
  L.check("F", "network failure: the message stays beside the action and the dialog stays open", /connection/.test(await dialogError.innerText()), await dialogError.innerText());
  await op.unroute("**/api/coach/instances/*/cover");
  await op.route("**/api/coach/instances/*/cover", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "x" }) }));
  await dialog.getByRole("button", { name: "Request cover" }).click();
  await op.waitForFunction(() => /try again/.test(document.querySelector('[data-testid="cover-dialog-error"]')?.textContent ?? ""));
  L.check("F", "server error: said in the dialog, and nothing was saved", (await coverRow(ids.thu1)) === null, await coverRow(ids.thu1));
  await op.unroute("**/api/coach/instances/*/cover");
  // Retry: exactly one request.
  const sent = [];
  op.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/cover")) sent.push(r.url()); });
  await dialog.getByRole("button", { name: "Request cover" }).click();
  await dialog.waitFor({ state: "detached", timeout: 60000 });
  row = await sessionRow(op, ids.thu1);
  await row.getByTestId("cover-state").filter({ hasText: "Cover needed" }).waitFor({ timeout: 60000 });
  L.check("F", "the retry sends exactly one request and it is saved", sent.length === 1 && (await coverRow(ids.thu1))?.status === "open", { sent: sent.length, row: await coverRow(ids.thu1) });
  L.check("A", "staff see Cover needed with the regular coach marked away", (await row.getByTestId("cover-state").innerText()).includes("Cover needed · Alex Regular away"), await row.getByTestId("cover-state").innerText());
  await op.reload();
  await op.getByTestId("cover-board").waitFor();
  const openCard = op.locator(`[data-testid="cover-open"] [data-session-id="${ids.thu1}"]`);
  L.check("A", "after reload the request is listed under Needs cover with class, full date, time and mat", (await openCard.count()) === 1 && (await openCard.innerText()).includes(THU1_LABEL) && (await openCard.innerText()).includes("19:00–20:30, Mat 2"), (await openCard.innerText().catch(() => "")).replace(/\s+/g, " "));
  await shot(op, "session-cover-owner-requested-1280");
  // Kim's Kids BJJ (Mat 1, same time) and the Mat 1 class straight after it need cover too.
  await requestVia(op, ids.kidsThu1);
  // No coach -> Cover needed: a class with no coach reads "No coach assigned" in quiet text, never "Cover needed".
  const lateState = (await sessionRow(op, ids.lateThu1)).getByTestId("cover-state");
  const quiet = await lateState.evaluate((el) => ({ text: el.textContent.trim(), muted: el.className.includes("text-tx-3") }));
  L.check("A", "a class with no coach reads No coach assigned, muted, and is not offered to claim", quiet.text === "No coach assigned" && quiet.muted && (await (await sessionRow(op, ids.lateThu1)).getByRole("button", { name: "I'll cover this class" }).count()) === 0, quiet);
  await requestVia(op, ids.lateThu1);
  L.check("A", "once asked for, it reads Cover needed", ((await (await sessionRow(op, ids.lateThu1)).getByTestId("cover-state").innerText()).trim()) === "Cover needed", await (await sessionRow(op, ids.lateThu1)).getByTestId("cover-state").innerText());

  // ── 2. A member while cover is open (phone) ──────────────────────────────────────────────────────────────────────
  stage = "member-open";
  const member = await memberLogin(club, "Member 1");
  // The member's first-run questions would cover the home page; this member has answered them.
  await q(`update "Member" set "onboardingCompleted" = true where id = $1 and "tenantId" = $2`, [member.id, t]);
  const mc = await context(browser, "10.98.7.2", VIEW["390"]);
  const mp = await mc.newPage();
  lastPage = mp;
  watch(mp, "member");
  await memberSignIn(mp, club, member);
  const schedOpen = await (await mp.request.get(`/api/member/schedule?date=${thu1}`)).json();
  const entryOpen = schedOpen.find((e) => e.classId === ids.adults && e.dayOfWeek === 4);
  L.check("M", "member schedule for that Thursday: Coach to be confirmed, no names, no request detail", entryOpen?.coach === "Coach to be confirmed" && !JSON.stringify(entryOpen).match(/Alex|cover_|requested|away/), entryOpen);
  await mp.goto("/member/home");
  await mp.getByText("Next class").first().waitFor({ timeout: 90000 });
  await mp.getByText(CLASSES[0]).first().waitFor({ timeout: 60000 });
  const meOpen = (await (await mp.request.get("/api/member/me")).json()).nextClass;
  L.check("M", "member's next class (member API) is Adults Gi with Coach to be confirmed", meOpen?.name === CLASSES[0] && meOpen?.coach === "Coach to be confirmed", meOpen);
  const nextCard = mp.getByText("Next class").first().locator("xpath=ancestor::*[.//p[contains(., 'Cover Adults Gi')]][1]");
  const homeOpen = await nextCard.innerText().catch(async () => mp.locator("main").innerText());
  L.check("M@390", "member home: the next class reads Coach to be confirmed, not the away regular coach", homeOpen.includes("Coach to be confirmed") && !homeOpen.includes("Alex Regular"), homeOpen.replace(/\s+/g, " ").slice(0, 400));
  await shot(mp, "session-cover-member-open-390");

  // ── 3. Kim, teaching Kids BJJ on Mat 1 at the same time, is refused ─────────────────────────────────────────────
  stage = "overlap";
  const kc = await context(browser, "10.98.7.3", VIEW["390"]);
  const kp = await kc.newPage();
  lastPage = kp;
  watch(kp, "kim");
  await staffSignIn(kp, club, kim);
  await openBoard(kp);
  const kimCard = kp.locator(`[data-testid="cover-open"] [data-session-id="${ids.thu1}"]`);
  await kimCard.waitFor();
  const claimBtn = kimCard.getByRole("button", { name: "I'll cover this class" });
  const box = await claimBtn.boundingBox();
  L.check("P@390", "I'll cover this class is reachable and at least 44 px tall", !!box && box.height >= 44, box);
  await claimBtn.click();
  await kp.getByRole("dialog").getByRole("button", { name: "I'll cover this class" }).click();
  const kimNote = kimCard.getByTestId("cover-note");
  await kimNote.waitFor({ timeout: 60000 });
  const wantOverlap = `You're already teaching ${CLASSES[1]} on ${THU1_LABEL}, 19:00–20:30, Mat 1.`;
  L.check("O", "an overlapping claim is refused and names the conflicting session", (await kimNote.innerText()).trim() === wantOverlap, { saw: await kimNote.innerText(), want: wantOverlap });
  L.check("O", "nothing changed: the request is still open", (await coverRow(ids.thu1))?.status === "open", await coverRow(ids.thu1));
  const kimSide = await noSideways(kp);
  L.check("P@390", "coach's cover page has no sideways scroll at 390", !kimSide.document && !kimSide.main, kimSide);
  await shot(kp, "session-cover-overlap-390");

  // ── 3b. Who is actually teaching: Alex's own Adults Gi is only requested, so Alex is still its teacher ───────────
  stage = "alex-not-released";
  const ac = await context(browser, "10.98.7.10", VIEW["1280"]);
  const ap = await ac.newPage();
  watch(ap, "alex");
  await staffSignIn(ap, club, alex);
  await openBoard(ap);
  const alexEarly = await actOn(ap, '[data-testid="cover-open"]', ids.kidsThu1, "I'll cover this class");
  L.check("W", "an open request does not release the regular coach: Alex is refused Kids BJJ, naming his own session", alexEarly === `You're already teaching ${CLASSES[0]} on ${THU1_LABEL}, 19:00–20:30, Mat 2.`, alexEarly);

  // The simultaneous Mat 1 session and next Thursday's Mat 2 session, as staff, a member and the database see them.
  const others = async () => {
    const staff = async (day, id) => ((await (await op.request.get(`/api/coach/cover?from=${day}&days=1`)).json()).sessions || []).filter((x) => x.id === id).map((x) => ({ state: x.state, coachLabel: x.coachLabel, coverUserId: x.coverUserId }));
    const memberView = async (day, classId) => ((await (await mp.request.get(`/api/member/schedule?date=${day}`)).json()) || []).filter((e) => e.classId === classId && e.dayOfWeek === 4).map((e) => ({ coach: e.coach, classInstanceId: e.classInstanceId }));
    const db = async (id) => q(`select status, "coverUserId", "needsReconfirm", "closedReason" from "SessionCover" where "tenantId" = $1 and "classInstanceId" = $2`, [t, id]);
    return {
      mat1ThisThursday: { staff: await staff(thu1, ids.kidsThu1), member: await memberView(thu1, ids.kids), db: await db(ids.kidsThu1) },
      mat2NextThursday: { staff: await staff(thu2, ids.thu2), member: await memberView(thu2, ids.adults), db: await db(ids.thu2) },
    };
  };
  const beforeClaim = await others();

  // ── 4. Two coaches confirm at the same moment ────────────────────────────────────────────────────────────────────
  stage = "race";
  const cc = await context(browser, "10.98.7.4", VIEW["1280"]);
  const rc = await context(browser, "10.98.7.5", VIEW["390"]);
  const cp = await cc.newPage();
  const rp = await rc.newPage();
  watch(cp, "casey");
  watch(rp, "robin");
  await staffSignIn(cp, club, casey);
  await staffSignIn(rp, club, robin);
  await Promise.all([openBoard(cp), openBoard(rp)]);
  const card = (page) => page.locator(`[data-testid="cover-open"] [data-session-id="${ids.thu1}"]`);
  await card(cp).getByRole("button", { name: "I'll cover this class" }).click();
  await card(rp).getByRole("button", { name: "I'll cover this class" }).click();
  const confirmOf = (page) => page.getByRole("dialog").getByRole("button", { name: "I'll cover this class" });
  await Promise.all([confirmOf(cp).waitFor(), confirmOf(rp).waitFor()]);
  await Promise.all([confirmOf(cp).click(), confirmOf(rp).click()]);
  await Promise.all([cp.getByRole("dialog").waitFor({ state: "detached", timeout: 90000 }), rp.getByRole("dialog").waitFor({ state: "detached", timeout: 90000 })]);
  const won = await coverRow(ids.thu1);
  const winner = won?.coverUserId === casey.id ? { who: casey, page: cp, tag: "1280" } : won?.coverUserId === robin.id ? { who: robin, page: rp, tag: "390" } : null;
  const loser = winner?.who === casey ? { who: robin, page: rp } : { who: casey, page: cp };
  L.check("R", "exactly one claim won and the session is covered by that coach", !!winner && won.status === "covered", won);
  const coverRows = Number((await q(`select count(*)::int as n from "SessionCover" where "tenantId" = $1 and "classInstanceId" = $2`, [t, ids.thu1]))[0].n);
  L.check("R", "one cover row for the session", coverRows === 1, { coverRows });
  if (winner) {
    const loserNote = loser.page.locator(`[data-session-id="${ids.thu1}"] [data-testid="cover-note"]`).first();
    await loserNote.waitFor({ timeout: 60000 }).catch(() => {});
    const loserText = (await loserNote.innerText().catch(() => "")).trim();
    L.check("R", "the other coach sees Already covered by [name].", loserText === `Already covered by ${winner.who.name}.`, loserText);
    const mineCard = winner.page.locator(`[data-testid="cover-mine"] [data-session-id="${ids.thu1}"]`);
    await mineCard.waitFor({ timeout: 60000 });
    L.check(`C@${winner.tag}`, "the winner sees You're covering this class, with Give up cover", (await mineCard.innerText()).includes("You're covering this class") && (await mineCard.getByRole("button", { name: "Give up cover" }).count()) === 1, (await mineCard.innerText()).replace(/\s+/g, " "));
    await shot(winner.page, `session-cover-coach-covering-${winner.tag}`);
  }
  // Nobody covers two sessions that Thursday, and the coach teaching Kids BJJ then covers nothing.
  const doubled = await q(
    `select sc."coverUserId", count(*)::int as n from "SessionCover" sc join "ClassInstance" ci on ci.id = sc."classInstanceId"
      where sc."tenantId" = $1 and sc.status = 'covered' and ci.date = $2 group by sc."coverUserId"`,
    [t, new Date(`${thu1}T00:00:00Z`)],
  );
  const doubledOk = doubled.every((d) => d.n === 1) && !doubled.some((d) => d.coverUserId === kim.id);
  L.check("R", "nobody is double-booked that Thursday", doubledOk, doubled);
  const afterClaim = await others();
  L.check("I", "the claim changed only this Thursday's Mat 2 session: the Mat 1 session and next Thursday's Mat 2 session are identical before and after, for staff, members and the database", JSON.stringify(beforeClaim) === JSON.stringify(afterClaim) && afterClaim.mat2NextThursday.db.length === 0, { before: beforeClaim, after: afterClaim });

  // ── 4b. Alex is released once the cover is confirmed; back to back is allowed; taking the cover away is refused ──
  stage = "alex-released";
  await openBoard(ap);
  const alexNow = await actOn(ap, '[data-testid="cover-open"]', ids.kidsThu1, "I'll cover this class");
  L.check("W", "once someone is confirmed on Adults Gi, Alex can take Kids BJJ at the same time", alexNow === "You're covering this class." && (await coverRow(ids.kidsThu1))?.coverUserId === alex.id, { alexNow, row: await coverRow(ids.kidsThu1) });
  await openBoard(ap);
  const alexLate = await actOn(ap, '[data-testid="cover-open"]', ids.lateThu1, "I'll cover this class");
  L.check("W", "back to back is allowed: Alex also takes the Mat 1 class starting as Kids BJJ ends", alexLate === "You're covering this class." && (await coverRow(ids.lateThu1))?.coverUserId === alex.id, alexLate);
  await shot(ap, "session-cover-alex-released-1280");
  await ac.close();
  await openBoard(op);
  const withdrawNote = await actOn(op, '[data-testid="cover-week"]', ids.thu1, "Withdraw request");
  const busyText = `would put Alex Regular back on this class while they teach ${CLASSES[1]} on ${THU1_LABEL}, 19:00–20:30, Mat 1.`;
  L.check("X", "withdrawing the cover would double-book Alex: refused, naming the conflict", withdrawNote.includes(busyText), withdrawNote);
  await openBoard(op);
  const returnNote = await actOn(op, '[data-testid="cover-week"]', ids.thu1, "Return to regular coach");
  L.check("X", "returning the session to Alex would double-book him: refused, naming the conflict", returnNote.includes(busyText), returnNote);
  L.check("X", "nothing changed: the session is still covered by the winner", (await coverRow(ids.thu1))?.coverUserId === won?.coverUserId && (await coverRow(ids.thu1))?.status === "covered", await coverRow(ids.thu1));
  await shot(op, "session-cover-withdraw-conflict-1280");

  // ── 4c. Same date is not same session: one class twice on Thursday, then a weekly-slot edit ────────────────────
  stage = "slot-edit";
  const spare = loser.who;
  await openBoard(op);
  const morningRow = await sessionRow(op, ids.morning);
  await morningRow.getByRole("button", { name: "Assign" }).click();
  const assignDialog = op.getByRole("dialog");
  await assignDialog.getByLabel("Coach").selectOption(spare.id);
  await assignDialog.getByRole("button", { name: "Assign" }).click();
  await assignDialog.waitFor({ state: "detached", timeout: 60000 });
  await requestVia(op, ids.noon);
  L.check("S", "the morning session is assigned directly and the 12:00 session is requested", (await coverRow(ids.morning))?.coverUserId === spare.id && (await coverRow(ids.noon))?.status === "open", { morning: await coverRow(ids.morning), noon: await coverRow(ids.noon) });
  const edit1 = await editSlots(op, ids.twice, CLASSES[3], [{ dayOfWeek: 4, startTime: "07:30", endTime: "08:30" }, { dayOfWeek: 4, startTime: "12:00", endTime: "13:00" }]);
  const moved = (await q(`select sc."needsReconfirm", sc."coverUserId", ci."startTime", ci.date from "SessionCover" sc join "ClassInstance" ci on ci.id = sc."classInstanceId" where sc."tenantId" = $1 and ci."classId" = $2 and sc.status = 'covered'`, [t, ids.twice]))[0];
  L.check("S", "moving the 07:00 slot to 07:30 carries the morning cover to 07:30 on the same Thursday only, awaiting reconfirmation", edit1.status === 200 && edit1.body?.scheduleChange?.coverMoved === 1 && moved?.startTime === "07:30" && moved?.needsReconfirm === true && moved?.coverUserId === spare.id, { status: edit1.status, change: edit1.body?.scheduleChange, moved });
  L.check("S", "the 12:00 session keeps its own open request: the morning cover never lands on it", (await coverRow(ids.noon))?.status === "open", await coverRow(ids.noon));
  const sc = await context(browser, "10.98.7.11", VIEW["390"]);
  const sp = await sc.newPage();
  watch(sp, "spare");
  await staffSignIn(sp, club, spare);
  await openBoard(sp);
  const awaiting = sp.locator('[data-testid="cover-mine"] article').filter({ hasText: CLASSES[3] }).first();
  await awaiting.waitFor({ timeout: 60000 });
  L.check("S@390", "the covering coach sees Awaiting reconfirmation with Reconfirm", (await awaiting.innerText()).includes("Awaiting reconfirmation") && (await awaiting.getByRole("button", { name: "Reconfirm" }).count()) === 1, (await awaiting.innerText()).replace(/\s+/g, " "));
  await shot(sp, "session-cover-awaiting-reconfirmation-390");
  await awaiting.getByRole("button", { name: "Reconfirm" }).click();
  await sp.getByRole("dialog").getByRole("button", { name: "Reconfirm" }).click();
  await sp.getByRole("dialog").waitFor({ state: "detached", timeout: 60000 });
  await sp.getByText("Reconfirmed.").first().waitFor({ timeout: 60000 });
  const after = (await q(`select sc."needsReconfirm" from "SessionCover" sc join "ClassInstance" ci on ci.id = sc."classInstanceId" where sc."tenantId" = $1 and ci."classId" = $2 and sc.status = 'covered'`, [t, ids.twice]))[0];
  L.check("S", "after Reconfirm the cover is confirmed for the new time", after?.needsReconfirm === false, after);
  await sc.close();
  const edit2 = await editSlots(op, ids.twice, CLASSES[3], [{ dayOfWeek: 4, startTime: "08:00", endTime: "09:00" }, { dayOfWeek: 4, startTime: "12:30", endTime: "13:30" }]);
  const closed = await q(`select status, "closedReason", "classInstanceId" from "SessionCover" where "tenantId" = $1 and "closedReason" = 'replacement_ambiguous'`, [t]);
  L.check("S", "changing both Thursday slots at once is ambiguous: both requests are closed with the reason, not moved", edit2.status === 200 && closed.length === 2 && closed.every((r) => r.status === "closed" && r.classInstanceId === null) && (edit2.body?.scheduleChange?.coverClosed ?? []).length === 2, { status: edit2.status, closed, change: edit2.body?.scheduleChange });

  // ── 5. The other views of the covered session, desktop and phone ────────────────────────────────────────────────
  stage = "views";
  if (winner) {
    // The covering coach at the other width.
    const otherTag = winner.tag === "1280" ? "390" : "1280";
    const wc = await context(browser, "10.98.7.6", VIEW[otherTag]);
    const wp = await wc.newPage();
    watch(wp, "winner-2");
    await staffSignIn(wp, club, winner.who);
    await openBoard(wp);
    const mine2 = wp.locator(`[data-testid="cover-mine"] [data-session-id="${ids.thu1}"]`);
    await mine2.waitFor({ timeout: 60000 });
    L.check(`C@${otherTag}`, "the covering coach sees You're covering this class", (await mine2.innerText()).includes("You're covering this class"), (await mine2.innerText()).replace(/\s+/g, " "));
    await shot(wp, `session-cover-coach-covering-${otherTag}`);
    await wc.close();
  }
  for (const [tag, lane] of [["1280", 7], ["390", 8]]) {
    const ctx = await context(browser, `10.98.7.${lane}`, { ...VIEW[tag], storageState: ownerState });
    const page = await ctx.newPage();
    lastPage = page;
    watch(page, `owner-${tag}`);
    await openBoard(page);
    const r1 = await sessionRow(page, ids.thu1);
    const s1 = (await r1.getByTestId("cover-state").innerText()).trim();
    L.check(`K@${tag}`, "the owner sees Covered by [name]", !!winner && s1 === `Covered by ${winner.who.name}`, s1);
    L.check(`K@${tag}`, "the owner can Replace or Return to regular coach", (await r1.getByRole("button", { name: "Replace" }).count()) === 1 && (await r1.getByRole("button", { name: "Return to regular coach" }).count()) === 1, (await r1.innerText()).replace(/\s+/g, " "));
    const side = await noSideways(page);
    L.check(`P@${tag}`, "owner's cover page has no sideways scroll", !side.document && !side.main, side);
    await shot(page, `session-cover-owner-covered-${tag}`);
    // Next Thursday: untouched.
    const r2 = await sessionRow(page, ids.thu2);
    const s2 = (await r2.getByTestId("cover-state").innerText()).trim();
    L.check(`N@${tag}`, "next Thursday still shows its regular coach and can still be requested", s2 === "Alex Regular" && (await r2.getByRole("button", { name: "Request cover" }).count()) === 1, s2);
    await ctx.close();
  }
  L.check("N", "next Thursday has no cover row, and the weekly class keeps its coach", (await coverRow(ids.thu2)) === null && (await q(`select "coachUserId" from "Class" where id = $1`, [ids.adults]))[0].coachUserId === alex.id, { thu2: await coverRow(ids.thu2) });

  // The staff timetable's read of the dated week carries the cover label.
  const coverApi = await (await op.request.get(`/api/coach/cover?from=${thu1}&days=1`)).json();
  const apiRow = coverApi.sessions?.find((s) => s.id === ids.thu1);
  L.check("T", "the staff timetable's week read labels the session Covered by [name]", !!winner && apiRow?.coachLabel === `Covered by ${winner.who.name}`, apiRow?.coachLabel);

  // ── 6. The member after cover is accepted, phone and desktop ───────────────────────────────────────────────────
  stage = "member-covered";
  const schedCov = await (await mp.request.get(`/api/member/schedule?date=${thu1}`)).json();
  const entryCov = schedCov.find((e) => e.classId === ids.adults && e.dayOfWeek === 4);
  L.check("M", "member schedule for that Thursday names the confirmed covering coach only", !!winner && entryCov?.coach === winner.who.name && !JSON.stringify(entryCov).match(/Alex|cover_|requested/), entryCov);
  const schedNext = await (await mp.request.get(`/api/member/schedule?date=${thu2}`)).json();
  const entryNext = schedNext.find((e) => e.classId === ids.adults && e.dayOfWeek === 4);
  L.check("M", "member schedule for next Thursday: the regular coach", entryNext?.coach === "Alex Regular", entryNext?.coach);
  const meCovered = (await (await mp.request.get("/api/member/me")).json()).nextClass;
  L.check("M", "member's next class (member API) names the covering coach", !!winner && meCovered?.name === CLASSES[0] && meCovered?.coach === winner.who.name, meCovered);
  for (const [tag, page] of [["390", mp]]) {
    await page.goto("/member/home");
    await page.getByText(CLASSES[0]).first().waitFor({ timeout: 60000 });
    const home = await page.getByText("Next class").first().locator("xpath=ancestor::*[.//p[contains(., 'Cover Adults Gi')]][1]").innerText();
    L.check(`M@${tag}`, "member home: the next class names the covering coach", !!winner && home.includes(winner.who.name) && !home.includes("Coach to be confirmed"), home.replace(/\s+/g, " ").slice(0, 400));
    await shot(page, `session-cover-member-covered-${tag}`);
  }
  const mdc = await context(browser, "10.98.7.9", { ...VIEW["1280"], storageState: await mc.storageState() });
  const mdp = await mdc.newPage();
  watch(mdp, "member-1280");
  await mdp.goto("/member/home");
  await mdp.getByText(CLASSES[0]).first().waitFor({ timeout: 60000 });
  const homeDesk = await mdp.getByText("Next class").first().locator("xpath=ancestor::*[.//p[contains(., 'Cover Adults Gi')]][1]").innerText();
  L.check("M@1280", "member home on desktop: the next class names the covering coach", !!winner && homeDesk.includes(winner.who.name), homeDesk.replace(/\s+/g, " ").slice(0, 300));
  await shot(mdp, "session-cover-member-covered-1280");
  await mdc.close();

  // ── 7. Activity records who requested and who accepted ─────────────────────────────────────────────────────────
  stage = "activity";
  const audit = await q(`select action, "userId" from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action like 'class.cover_%' order by "createdAt"`, [t, ids.thu1]);
  L.check("V", "Activity rows: cover_requested by the owner, cover_claimed by the winner, nothing else for this session", audit.length === 2 && audit[0].action === "class.cover_requested" && audit[0].userId === club.owner.id && audit[1].action === "class.cover_claimed" && audit[1].userId === winner?.who.id, audit);
  await op.goto("/dashboard/activity");
  await op.getByText("asked for cover for").first().waitFor({ timeout: 90000 });
  const feed = await op.locator("main").innerText();
  L.check("V", "the Activity page says who asked for cover and who is covering", feed.includes("asked for cover for") && !!winner && feed.includes(`${winner.who.name} is covering`), feed.replace(/\s+/g, " ").slice(0, 500));
  L.check("V", "Activity tells staff to request cover on the intended session after the ambiguous edit", feed.includes("request cover on the intended session"), feed.replace(/\s+/g, " ").slice(0, 500));
  await shot(op, "session-cover-activity-1280");

  // ── 8. The rest of the transitions on the first Thursday, next Thursday untouched throughout ─────────────────────
  stage = "transitions";
  const untouched = [];
  const step = async (label) => untouched.push([label, await nextWeekUntouched()]);
  await step("after the race and the views");
  // Alex hands back Kids BJJ and the late class (Kim teaches Kids BJJ again), so Alex is free to take Adults Gi back.
  const ac2 = await context(browser, "10.98.7.12", VIEW["390"]);
  const ap2 = await ac2.newPage();
  watch(ap2, "alex-2");
  await staffSignIn(ap2, club, alex);
  for (const id of [ids.kidsThu1, ids.lateThu1]) {
    await openBoard(ap2);
    await actOn(ap2, '[data-testid="cover-mine"]', id, "Give up cover");
  }
  L.check("G", "Alex gives up Kids BJJ and the late class: both need cover again", (await coverRow(ids.kidsThu1))?.status === "open" && (await coverRow(ids.lateThu1))?.status === "open", { kids: await coverRow(ids.kidsThu1), late: await coverRow(ids.lateThu1) });
  await ac2.close();
  // The winner gives up Adults Gi: explained, reopened, visible to the owner.
  if (winner) {
    await openBoard(winner.page);
    const mineCard = winner.page.locator(`[data-testid="cover-mine"] [data-session-id="${ids.thu1}"]`);
    await mineCard.getByRole("button", { name: "Give up cover" }).click();
    const giveUp = winner.page.getByRole("dialog");
    const giveText = (await giveUp.innerText()).replace(/\s+/g, " ");
    L.check("G", "Give up cover explains that it reopens the request and the owner will see it", giveText.includes("This reopens the request") && giveText.includes("owner"), giveText.slice(0, 240));
    await giveUp.getByRole("button", { name: "Give up cover" }).click();
    await giveUp.waitFor({ state: "detached", timeout: 60000 });
  }
  await step("after give up");
  await openBoard(op);
  let st = await stateAfter(op, ids.thu1, "Cover needed");
  L.check("G", "covered by name -> given up -> the owner sees Cover needed again", st === "Cover needed · Alex Regular away" && (await coverRow(ids.thu1))?.status === "open", st);
  // Assigned directly by the owner.
  const row1 = await sessionRow(op, ids.thu1);
  await row1.getByRole("button", { name: "Assign" }).click();
  const ad = op.getByRole("dialog");
  await ad.getByLabel("Coach").selectOption(loser.who.id);
  await ad.getByRole("button", { name: "Assign" }).click();
  await ad.waitFor({ state: "detached", timeout: 60000 });
  await step("after assign");
  st = await stateAfter(op, ids.thu1, `Covered by ${loser.who.name}`);
  L.check("G", "cover needed -> assigned directly: Covered by the coach the owner chose", st === `Covered by ${loser.who.name}` && (await coverRow(ids.thu1))?.coverUserId === loser.who.id, st);
  // Returned to the regular coach (Alex is free now).
  const retNote = await actOn(op, '[data-testid="cover-week"]', ids.thu1, "Return to regular coach");
  await step("after return");
  st = await stateAfter(op, ids.thu1, "Alex Regular");
  L.check("G", "assigned -> returned to the regular coach: the session reads Alex Regular again", st === "Alex Regular" && (await coverRow(ids.thu1))?.closedReason === "returned_to_regular", { st, retNote });
  await shot(op, "session-cover-returned-1280");
  // Asked for again, then the session is cancelled (closes the request) and restored (reinstates no one).
  await requestVia(op, ids.thu1);
  const setCancelled = (isCancelled) => op.evaluate(async ({ classId, id, isCancelled }) => (await fetch(`/api/classes/${classId}/instances/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isCancelled }) })).status, { classId: ids.adults, id: ids.thu1, isCancelled });
  L.check("Z", "cancel answered 200", (await setCancelled(true)) === 200);
  await step("after cancel");
  await openBoard(op);
  st = (await (await sessionRow(op, ids.thu1)).getByTestId("cover-state").innerText()).trim();
  L.check("Z", "cancelling closes the request: the session reads Cancelled and is not under Needs cover", st === "Cancelled" && (await coverRow(ids.thu1))?.closedReason === "session_cancelled" && (await op.locator(`[data-testid="cover-open"] [data-session-id="${ids.thu1}"]`).count()) === 0, { st, row: await coverRow(ids.thu1) });
  L.check("Z", "restore answered 200", (await setCancelled(false)) === 200);
  await step("after restore");
  await openBoard(op);
  const restored = await sessionRow(op, ids.thu1);
  st = (await restored.getByTestId("cover-state").innerText()).trim();
  L.check("Z", "restoring reinstates no one: Alex Regular, no cover, and Request cover is offered again", st === "Alex Regular" && (await coverRow(ids.thu1))?.status === "closed" && (await restored.getByRole("button", { name: "Request cover" }).count()) === 1, { st, row: await coverRow(ids.thu1) });
  await shot(op, "session-cover-restored-1280");
  L.check("N", "next Thursday untouched after every transition", untouched.every(([, ok]) => ok), untouched);
  const trail = await q(`select action from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action like 'class.cover_%' order by "createdAt"`, [t, ids.thu1]);
  L.check("V", "Activity holds every transition of the session in order", JSON.stringify(trail.map((r) => r.action)) === JSON.stringify(["class.cover_requested", "class.cover_claimed", "class.cover_given_up", "class.cover_assigned", "class.cover_returned_to_regular", "class.cover_requested", "class.cover_closed"]), trail.map((r) => r.action));

  // ── 9. Round 2: cancel after a claim, deactivation of the covering coach, archive and restore ────────────────────
  const memberCoach = async () => ((await (await mp.request.get(`/api/member/schedule?date=${thu1}`)).json()) || []).find((e) => e.classId === ids.adults && e.dayOfWeek === 4) ?? null;
  const assignVia = async (who) => {
    await openBoard(op);
    const row = await sessionRow(op, ids.thu1);
    await row.getByRole("button", { name: "Assign" }).click();
    const d = op.getByRole("dialog");
    await d.getByLabel("Coach").selectOption(who.id);
    await d.getByRole("button", { name: "Assign" }).click();
    await d.waitFor({ state: "detached", timeout: 60000 });
    return stateAfter(op, ids.thu1, `Covered by ${who.name}`);
  };
  const ownerFetch = (url, method, body) => op.evaluate(async ({ url, method, body }) => (await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).status, { url, method, body });
  const mineCount = async (page) => { await openBoard(page); return page.locator(`[data-testid="cover-mine"] [data-session-id="${ids.thu1}"]`).count(); };

  // 9a. A coach claims, then the session is cancelled and restored: the cancel closes the cover; nobody is recommitted.
  stage = "cancel-after-claim";
  await openBoard(op);
  await requestVia(op, ids.thu1);
  await openBoard(loser.page);
  const claimNote = await actOn(loser.page, '[data-testid="cover-open"]', ids.thu1, "I'll cover this class");
  L.check("Z2", "a coach claims the asked-for session", (await coverRow(ids.thu1))?.coverUserId === loser.who.id, { claimNote, row: await coverRow(ids.thu1) });
  L.check("Z2", "cancel after the claim answered 200", (await setCancelled(true)) === 200);
  await openBoard(op);
  st = (await (await sessionRow(op, ids.thu1)).getByTestId("cover-state").innerText()).trim();
  L.check("Z2", "cancelling closes the claimed cover: Cancelled, no covering coach", st === "Cancelled" && (await coverRow(ids.thu1))?.closedReason === "session_cancelled" && (await coverRow(ids.thu1))?.coverUserId === null, { st, row: await coverRow(ids.thu1) });
  L.check("Z2@" + (loser.page === cp ? "1280" : "390"), "the coach who claimed no longer has it under their covers", (await mineCount(loser.page)) === 0);
  L.check("Z2", "restore answered 200", (await setCancelled(false)) === 200);
  await openBoard(op);
  st = await stateAfter(op, ids.thu1, "Alex Regular");
  const mAfterRestore = await memberCoach();
  L.check("Z2", "restored: staff read Alex Regular, the cover stays closed, the coach is not recommitted", st === "Alex Regular" && (await coverRow(ids.thu1))?.status === "closed" && (await mineCount(loser.page)) === 0, { st, row: await coverRow(ids.thu1) });
  L.check("Z2@390", "restored: the member reads Alex Regular, not the coach who had claimed", mAfterRestore?.coach === "Alex Regular" && !JSON.stringify(mAfterRestore).includes(loser.who.name), mAfterRestore);
  await shot(op, "session-cover-cancel-after-claim-restored-1280");

  // 9b. The owner assigns a coach, then deactivates that coach: the session needs cover again, for staff and members.
  stage = "deactivated-coach";
  if (winner) {
    st = await assignVia(winner.who);
    const mAssigned = await memberCoach();
    L.check("D", "assigned: staff read Covered by the coach, the member reads that coach", st === `Covered by ${winner.who.name}` && mAssigned?.coach === winner.who.name, { st, member: mAssigned });
    L.check("D", "deactivating the covering coach answered 200", (await ownerFetch(`/api/staff/${winner.who.id}`, "DELETE")) === 200);
    await openBoard(op);
    st = await stateAfter(op, ids.thu1, "Cover needed");
    L.check("D@1280", "staff: the session reads Cover needed again, never Covered by the deactivated coach", st === "Cover needed · Alex Regular away" && (await coverRow(ids.thu1))?.status === "open" && (await coverRow(ids.thu1))?.coverUserId === null, { st, row: await coverRow(ids.thu1) });
    const mDeact = await memberCoach();
    L.check("D", "member schedule: Coach to be confirmed, the deactivated coach's name nowhere", mDeact?.coach === "Coach to be confirmed" && !JSON.stringify(mDeact).includes(winner.who.name), mDeact);
    await mp.goto("/member/home");
    await mp.getByText("Next class").first().waitFor({ timeout: 90000 });
    const homeDeact = await mp.locator("main").innerText();
    L.check("D@390", "member home: Coach to be confirmed, the deactivated coach's name nowhere", homeDeact.includes("Coach to be confirmed") && !homeDeact.includes(winner.who.name), homeDeact.replace(/\s+/g, " ").slice(0, 400));
    await shot(mp, "session-cover-member-deactivated-390");
    await shot(op, "session-cover-deactivated-1280");
    const why = await q(`select metadata->>'reason' as reason from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action = 'class.cover_given_up' order by "createdAt" desc limit 1`, [t, ids.thu1]);
    L.check("D", "Activity records that the deactivation reopened the cover", why[0]?.reason === "coach_deactivated", why);
  } else {
    L.check("D", "a race winner to deactivate", false);
  }

  // 9c. A covered session, then the class is archived and restored: the cover ends with the archive and stays ended.
  stage = "archive-restore";
  st = await assignVia(loser.who);
  L.check("A2", "assigned before the archive", st === `Covered by ${loser.who.name}`, st);
  L.check("A2", "archive answered 200", (await ownerFetch(`/api/classes/${ids.adults}`, "DELETE")) === 200);
  L.check("A2", "archiving closed the cover with its reason", (await coverRow(ids.thu1))?.closedReason === "class_archived" && (await coverRow(ids.thu1))?.coverUserId === null, await coverRow(ids.thu1));
  L.check("A2", "restore answered 200", (await ownerFetch(`/api/classes/${ids.adults}`, "PATCH", { isActive: true })) === 200);
  await openBoard(op);
  st = await stateAfter(op, ids.thu1, "Alex Regular");
  const mArchived = await memberCoach();
  L.check("A2@1280", "restored class: staff read Alex Regular, the cover stays closed, the coach is not recommitted", st === "Alex Regular" && (await coverRow(ids.thu1))?.status === "closed" && (await mineCount(loser.page)) === 0, { st, row: await coverRow(ids.thu1) });
  L.check("A2@390", "restored class: the member reads Alex Regular", mArchived?.coach === "Alex Regular", mArchived);
  await shot(op, "session-cover-archive-restored-1280");
  const trail2 = await q(`select action, metadata->>'closedReason' as reason from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action like 'class.cover_%' order by "createdAt"`, [t, ids.thu1]);
  L.check("V", "Activity holds the round-2 transitions in order", JSON.stringify(trail2.slice(7).map((r) => r.reason ? `${r.action}:${r.reason}` : r.action)) === JSON.stringify(["class.cover_requested", "class.cover_claimed", "class.cover_closed:session_cancelled", "class.cover_assigned", "class.cover_given_up", "class.cover_assigned", "class.cover_closed:class_archived"]), trail2.slice(7));

  // ── 10. Round 3 (review of 7d7b17df) ────────────────────────────────────────────────────────────────────────────
  // 10a. The archived-and-restored class, on the owner's phone: no cover came back.
  stage = "round3-archive-restore-phone";
  const ownerPhoneCtx = await context(browser, "10.98.7.25", { ...VIEW["390"], storageState: ownerFirst });
  const opPhone = await ownerPhoneCtx.newPage();
  watch(opPhone, "owner-390");
  await openBoard(opPhone);
  st = await stateAfter(opPhone, ids.thu1, "Alex Regular");
  L.check("R3A@390", "after archive and restore the owner's phone shows Alex Regular, no cover, and Request cover again", st === "Alex Regular" && (await coverRow(ids.thu1))?.status === "closed" && (await (await sessionRow(opPhone, ids.thu1)).getByRole("button", { name: "Request cover" }).count()) === 1, { st, row: await coverRow(ids.thu1) });
  L.check("R3A@390", "no sideways scroll on the owner's phone board", !Object.values(await noSideways(opPhone)).some(Boolean), await noSideways(opPhone));
  await shot(opPhone, "session-cover-r3-archive-restored-390");

  // 10b. Drew covers Alex's Adults Gi; Alex (free) takes Kids BJJ at the same time; Drew is deactivated, so Adults Gi
  // needs cover again. Withdraw and Return would put Alex on both: refused by name, and nobody is assigned.
  stage = "round3-deactivate-withdraw";
  const drew = await coach("drew", "Drew Relief");
  st = await assignVia(drew);
  L.check("R3B", "Drew is assigned to Adults Gi", st === `Covered by ${drew.name}`, st);
  {
    const kidsRow = await sessionRow(op, ids.kidsThu1);
    await kidsRow.getByRole("button", { name: "Assign" }).click();
    const d = op.getByRole("dialog");
    await d.getByLabel("Coach").selectOption(alex.id);
    await d.getByRole("button", { name: "Assign" }).click();
    await d.waitFor({ state: "detached", timeout: 60000 });
  }
  L.check("R3B", "Alex, free while Drew covers his class, is assigned Kids BJJ at the same time", (await coverRow(ids.kidsThu1))?.coverUserId === alex.id, await coverRow(ids.kidsThu1));
  L.check("R3B", "deactivating Drew answered 200", (await ownerFetch(`/api/staff/${drew.id}`, "DELETE")) === 200);
  await openBoard(op);
  st = await stateAfter(op, ids.thu1, "Cover needed");
  L.check("R3B@1280", "Adults Gi reads Cover needed again after the deactivation", st === "Cover needed · Alex Regular away" && (await coverRow(ids.thu1))?.status === "open", { st, row: await coverRow(ids.thu1) });
  const conflictSentence = `would put Alex Regular back on this class while they teach ${CLASSES[1]} on ${THU1_LABEL}, 19:00–20:30, Mat 1.`;
  for (const [label, confirm] of [["Withdraw request", "Withdraw request"], ["Return to regular coach", "Return to regular coach"]]) {
    await openBoard(op);
    const note = await actOn(op, '[data-testid="cover-week"]', ids.thu1, label, confirm);
    L.check("R3B@1280", `${label}: refused, naming the session Alex is teaching`, note.includes(conflictSentence), note);
    L.check("R3B", `${label}: nobody assigned; the request stays open; Alex still covers Kids BJJ only`, (await coverRow(ids.thu1))?.status === "open" && (await coverRow(ids.thu1))?.coverUserId === null && (await coverRow(ids.kidsThu1))?.coverUserId === alex.id, { thu1: await coverRow(ids.thu1), kids: await coverRow(ids.kidsThu1) });
  }
  await shot(op, "session-cover-r3-withdraw-refused-1280");
  await openBoard(opPhone);
  st = await stateAfter(opPhone, ids.thu1, "Cover needed");
  L.check("R3B@390", "the owner's phone still shows Cover needed (no silent double booking)", st === "Cover needed · Alex Regular away", st);
  await shot(opPhone, "session-cover-r3-withdraw-refused-390");
  const mBusy = await memberCoach();
  L.check("R3B@390", "the member reads Coach to be confirmed, not Alex", mBusy?.coach === "Coach to be confirmed", mBusy);
  L.check("R3B", "no withdraw or return was recorded in Activity", Number((await q(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action in ('class.cover_withdrawn', 'class.cover_returned_to_regular') and "createdAt" > now() - interval '10 minutes'`, [t, ids.thu1]))[0].n) === 0);
  L.check("N", "next Thursday untouched after round 3's changes", await nextWeekUntouched());

  // 10c. Making a coach the regular coach of a class that overlaps a session they cover: the class form refuses by name.
  stage = "round3-coach-change";
  const ellis = await coach("ellis", "Ellis Cover");
  const reqDash = DASH.find((d) => d.key === "requested");
  const noCoachDash = DASH.find((d) => d.key === "nocoach");
  const assignEllis = await op.evaluate(async ({ id, coachUserId }) => (await fetch(`/api/coach/instances/${id}/cover`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "assign", coachUserId }) })).status, { id: reqDash.instanceId, coachUserId: ellis.id });
  L.check("R3C", "Ellis is assigned to cover Dash Requested (today 22:00, Mat 8)", assignEllis === 200 && (await coverRow(reqDash.instanceId))?.coverUserId === ellis.id, assignEllis);
  const todayLabel = dayLabel(todayKey);
  const wantRefusal = `Ellis Cover is covering ${reqDash.name} on ${todayLabel}, 22:00–22:30, ${reqDash.place}, which overlaps this class on ${todayLabel}, 22:00–22:30, ${noCoachDash.place}. Choose another regular coach, or give up or replace that cover first.`;
  for (const [tag, page] of [["1280", op], ["390", opPhone]]) {
    await page.goto("/dashboard/timetable");
    const chip = page.locator(`button[aria-label^="Edit ${noCoachDash.name}, "]:visible`).first();
    await chip.waitFor({ timeout: 90000 });
    await chip.click();
    const coachSelect = page.getByRole("combobox", { name: "Coach", exact: true });
    await coachSelect.waitFor({ timeout: 30000 });
    await coachSelect.selectOption(ellis.id);
    await page.getByRole("button", { name: "Save changes" }).click();
    const refusal = page.getByTestId("class-form-save-error");
    await refusal.waitFor({ timeout: 60000 });
    const text = (await refusal.innerText()).trim();
    L.check(`R3C@${tag}`, "the class form refuses the new coach, naming the session they cover and this class's session", text === wantRefusal, text);
    L.check(`R3C@${tag}`, "nothing saved: the class still has no linked coach", (await q(`select "coachUserId" from "Class" where id = $1`, [noCoachDash.classId]))[0].coachUserId === null);
    await shot(page, `session-cover-r3-coach-change-refused-${tag}`);
  }

  await round4({ op, opPhone, mp, ownerFetch });
  await ownerPhoneCtx.close();
  }
} catch (e) {
  if (lastPage && !lastPage.isClosed()) await shot(lastPage, "session-cover-failure").catch(() => {});
  L.check("run", "ran to the end", false, { stage, error: String(e).split("\n")[0].slice(0, 300) });
} finally {
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  await browser.close().catch(() => {});
  await cleanup();
  const left = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = any($2)`, [t, ALL_CLASSES]))[0].n);
  L.check("cleanup", "the two classes, their sessions and cover rows are removed", left === 0, { left });
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
