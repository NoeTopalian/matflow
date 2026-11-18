// Round 13 walk (brief: "Owner — set up the club, manage plans/classes, edit members, inspect reports and handle import
// conflicts"). The set-up half had no end-to-end walk (round13-acceptance-matrix §C: "no single new club from zero";
// plans, classes, members, reports and import conflicts have their own journeys). The fixture club is put back into
// first set-up (it is this run's own synthetic club). The owner signs in and walks the wizard: name, discipline, the
// BJJ belt system, one class, branding (skipped), questionnaire, payment rail, authenticator (already enrolled), member
// import (manual), then the dashboard. Every saved step is checked in the database and on the page that shows it.
// A forced failure of the first save is MEASURED (note): the wizard does not check save results today, a known defect
// owned by draft PR #35 ("honest saves"); this walk records the behaviour rather than inventing a fix.
// Needs `fixture.mjs create` and `server.mjs start` (or run-journeys.mjs).
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("walk-owner-new-club");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 6);
const GYM = `Walk Gym ${TAG}`;
const CLASS = "Beginner BJJ";
const errors = [];

await q(`update "Tenant" set "onboardingCompleted" = false where id = $1`, [tenantId]);
const tenant = async () => (await q(`select name, "onboardingCompleted" as done, timezone from "Tenant" where id = $1`, [tenantId]))[0];
const classesBefore = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = $2`, [tenantId, CLASS]))[0].n);
const nameBefore = (await tenant()).name;
// The forward button says "Continue →" (steps 1–2), "Save 1 class →" (step 4) or "Next →" (steps 6–7).
const cont = (page) => page.getByRole("button", { name: /^(Continue|Save \d+ class|Next)/ }).first();
const stepLabel = (page) => page.getByText(/^Step \d of 9$/).first().textContent().catch(() => null);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.133.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  await page.waitForURL(/\/onboarding/, { timeout: 60000 }).catch(() => {});
  L.check("journey", "O1 an owner whose club is in first set-up lands in the set-up wizard", /\/onboarding/.test(page.url()), new URL(page.url()).pathname);

  // Step 1: the gym's name. First a forced failure of its save (measured), then the real save.
  const name = page.getByLabel("Gym Name");
  await name.waitFor({ timeout: 60000 });
  await name.fill(`${GYM} (lost)`);
  await page.route("**/api/settings", (r) => (r.request().method() === "PATCH" ? r.abort("failed") : r.continue()));
  await cont(page).click();
  await page.waitForTimeout(1500);
  const afterLost = await stepLabel(page);
  L.note("failure", "N1 MEASURED (known defect, draft PR #35): with the name save lost, the wizard still moves on", { step: afterLost, storedName: (await tenant()).name === nameBefore ? "unchanged" : "changed" });
  await page.unroute("**/api/settings");
  if (afterLost !== "Step 1 of 9") await page.getByRole("button", { name: "Back" }).click();
  await name.waitFor({ timeout: 20000 });
  await name.fill(GYM);
  // Keyboard: Tab from the name field reaches Continue, Enter submits.
  await name.focus();
  let reached = false;
  for (let i = 0; i < 6 && !reached; i++) { await page.keyboard.press("Tab"); reached = await cont(page).evaluate((el) => el === document.activeElement).catch(() => false); }
  L.check("keyboard", "K1 Tab reaches Continue from the name field", reached);
  const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings", { timeout: 60000 });
  await page.keyboard.press("Enter");
  const s1 = await saved;
  L.check("setup", "S1 the gym name is saved", s1.ok() && (await tenant()).name === GYM, { status: s1.status() });

  // Step 2: discipline.
  await page.getByRole("button", { name: /BJJ/ }).first().click();
  await cont(page).click();
  // Step 3: the BJJ belt system (pre-selected for BJJ, or chosen), then add it.
  await page.getByText(/^Step 3 of 9$/).first().waitFor({ timeout: 30000 });
  const add = page.getByRole("button", { name: /^Add \d+ system/ });
  if (!(await add.isVisible().catch(() => false))) await page.getByRole("button", { name: /BJJ/ }).first().click();
  const rankPosts = [];
  page.on("response", (r) => { if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/ranks") rankPosts.push(r.status()); });
  await page.getByRole("button", { name: /^Add \d+ system/ }).click();
  await page.getByText(/^Step 4 of 9$/).first().waitFor({ timeout: 60000 });
  const ranks = Number((await q(`select count(*)::int as n from "RankSystem" where "tenantId" = $1 and discipline = 'BJJ'`, [tenantId]))[0].n);
  L.check("setup", "S2 the BJJ belt system is created", rankPosts.length > 0 && rankPosts.every((s) => s < 300 || s === 409) && ranks > 0, { posts: rankPosts.length, ranks });

  // Step 4: one class from the quick-add list, on Monday and Wednesday, 18:00–19:00.
  await page.getByRole("button", { name: CLASS }).first().click();
  for (const d of ["Mon", "Wed"]) await page.getByRole("button", { name: d, exact: true }).first().click();
  const classPost = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/classes", { timeout: 60000 });
  await cont(page).click();
  const cp = await classPost;
  await page.getByText(/^Step 5 of 9$/).first().waitFor({ timeout: 60000 });
  const cls = await q(`select c.id, array_agg(s."dayOfWeek" order by s."dayOfWeek") as days from "Class" c join "ClassSchedule" s on s."classId" = c.id where c."tenantId" = $1 and c.name = $2 group by c.id`, [tenantId, CLASS]);
  L.check("setup", "S3 the class is created with its Monday and Wednesday sessions", cp.ok() && cls.length === classesBefore + 1 && cls.some((c) => JSON.stringify(c.days) === "[1,3]"), { status: cp.status(), classes: cls.length });

  // Step 5 branding: skipped. Step 6: questionnaire. Step 7: payment rail. Step 8: authenticator already enrolled.
  await page.getByRole("button", { name: "Skip" }).first().click();
  await page.getByText(/^Step 6 of 9$/).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "21–50" }).click();
  await cont(page).click();
  await page.getByText(/^Step 7 of 9$/).first().waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: /Pay at desk only/ }).click();
  await cont(page).click();
  const reached9 = await page.getByText(/^Step 9 of 9$/).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("setup", "S4 with an authenticator already enrolled, the wizard passes its own two-factor step", reached9);

  // Step 9: members added manually later. Finish.
  await page.getByRole("button", { name: /add members manually later/ }).click();
  const done = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings", { timeout: 60000 });
  await page.getByRole("button", { name: /^Finish setup/ }).click();
  const dr = await done;
  await page.getByText("Your gym is ready!").waitFor({ timeout: 30000 });
  L.check("setup", "S5 finishing marks set-up complete", dr.ok() && (await tenant()).done === true, { status: dr.status() });
  await shot(page, "walk-owner-ready");
  await page.getByRole("button", { name: /Go to Dashboard/ }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60000 });
  L.check("journey", "O2 the owner reaches the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // What was set up shows where the owner manages it.
  await page.goto("/dashboard/timetable");
  const onTimetable = await page.getByText(CLASS).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("manage", "W1 the class from set-up is on the timetable", onTimetable);
  await page.goto("/dashboard/reports");
  const reportsOk = await page.getByRole("heading").first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  L.check("manage", "W2 Reports opens for the new club", reportsOk && /\/dashboard\/reports/.test(page.url()));
  await page.goto("/onboarding");
  await page.waitForLoadState("load");
  L.note("journey", "N2 /onboarding after completion (where it leads)", new URL(page.url()).pathname);

  // Phone width: the dashboard after set-up has no sideways scroll.
  const phone = await context(browser, "10.133.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/dashboard");
  await p2.waitForLoadState("load");
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 the dashboard at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  await shot(p2, "walk-owner-dashboard-mobile");

  const other = errors.filter((e) => !/Minified React error #418/.test(e));
  if (other.length !== errors.length) L.note("journey", "N3 pre-existing hydration text mismatch (#418) seen", errors.length - other.length);
  L.check("journey", "O3 no other uncaught page errors", other.length === 0, other);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
