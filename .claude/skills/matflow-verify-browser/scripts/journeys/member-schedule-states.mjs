// Journey: the members' schedule never passes off loading or failure as "No classes" (24 Nov 2026, audit F3).
//   S1 a slow schedule response: within 300 ms the day says it is loading, and never "No classes today";
//   S2 a genuinely empty day: "No classes today", and no loading line;
//   S3 a failed request: an error with "Try again" in place of the day (no "No classes today"); the retry sends one
//      request and the day's classes appear;
//   S4 a late response after switching days: the day chosen while loading shows that day's classes and no other's.
// Phone width (390 x 844, touch). Synthetic club; seeds one Thursday class and removes it.
//   node journeys/member-schedule-states.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("member-schedule-states");
const errors = [];
const NAME = "States Thursday Class";
const classId = randomUUID();

const pane = (page) => page.getByTestId("schedule-pane");
const paneText = (page) => pane(page).innerText().catch(() => "");
const pickDay = (page, d) => page.getByRole("button", { name: new RegExp(`^${d}\\s*\\d`, "i") }).first().click();

let browser;
try {
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 30)`, [classId, tenantId, NAME]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, 4, '18:00', '19:00')`, [randomUUID(), classId]);
  const member = await memberLogin(club);
  browser = await chromium.launch();
  const ctx = await context(browser, "10.95.6.1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(page, club, member);

  // S1: slow response.
  await page.route("**/api/member/schedule*", async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue(); });
  await page.goto("/member/schedule", { waitUntil: "domcontentloaded" });
  await pane(page).waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  const during = await paneText(page);
  const loadingShown = /Loading/i.test(during);
  const noClassesDuring = /No classes/i.test(during);
  L.check("S1", "a slow schedule: the day says it is loading, and does not say there are no classes", loadingShown && !noClassesDuring, { during: during.slice(0, 120) });
  await shot(page, "member-states-S1-loading");

  // S4 (same slow route): switch to Thursday while loading; when the answer lands, Thursday shows Thursday's class.
  await pickDay(page, "thu");
  const switchedDuring = await paneText(page);
  await page.waitForResponse((r) => r.url().includes("/api/member/schedule"), { timeout: 30000 }).catch(() => {});
  await page.getByText(NAME).filter({ visible: true }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const thursday = await paneText(page);
  L.check("S4", "a late answer after switching day: the day chosen while loading (Thursday) shows its own class, and said loading meanwhile",
    thursday.includes(NAME) && !/No classes/i.test(switchedDuring) && /Loading/i.test(switchedDuring), { switchedDuring: switchedDuring.slice(0, 120), thursday: thursday.slice(0, 160) });
  await page.unroute("**/api/member/schedule*");

  // S2: a genuinely empty day (Sunday): "No classes today", no loading line.
  await pickDay(page, "sun");
  await page.waitForTimeout(400);
  const sunday = await paneText(page);
  L.check("S2", "a genuinely empty day says No classes today and nothing about loading", /No classes today/.test(sunday) && !/Loading/i.test(sunday) && !sunday.includes(NAME), { sunday: sunday.slice(0, 120) });

  // S3: a failed request, then Try again.
  let fail = true;
  await page.route("**/api/member/schedule*", (r) => (fail ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) }) : r.continue()));
  await page.goto("/member/schedule");
  const tryAgain = page.getByRole("button", { name: "Try again", exact: true });
  const errShown = await tryAgain.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const body = await page.locator("main").innerText().catch(() => "");
  L.check("S3", "a failed load shows an error with Try again in place of the day, never No classes today", errShown && !/No classes/i.test(body) && /Couldn.t load/i.test(body), { body: body.slice(0, 160) });
  await shot(page, "member-states-S3-error");
  fail = false;
  let sent = 0;
  page.on("request", (r) => { if (r.url().includes("/api/member/schedule")) sent++; });
  if (errShown) await tryAgain.click();
  await pickDay(page, "thu").catch(() => {});
  const recovered = await page.getByText(NAME).filter({ visible: true }).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  L.check("S3", "Try again sends one schedule request and the day's classes appear", recovered && sent === 1, { recovered, sent });
} catch (e) {
  L.check("journey", "ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]).catch(() => {});
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
