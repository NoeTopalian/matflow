// Journey: Reports clarity (31 Oct 2026), for a club in Sean's state: years of TeamUp attendance imported up to the
// export, and no check-in recorded in MatFlow since.
//
//   C  the coverage: /api/reports knows where the imported history ends (the club day after the last imported
//      visit), that MatFlow check-ins have not resumed, and that this week has no records ("gap");
//   R  the screen: "Attendance this week" is "—" with the reason, never 0; the weekly chart shades the weeks since
//      the import as no data; the Class composition legend and Top Classes print full class names;
//   F  the Kids filter: every figure it does not narrow says "Whole club", the attendance ones do not, and "All"
//      removes every tag;
//   W  "What counts": opens in place (never navigates), by keyboard too;
//   M  390 px: no horizontal scroll, names wrap inside their card, tags stay inside their tile.
//
// Seed (written with `q`, in the shape lib/attendance-import.ts writes: checkInMethod "import"): two kids classes
// whose names share a long prefix, one kids member, and imported visits on four Saturdays, the last one the
// Saturday before this week. Read-only feature: there is no save to fail or retry (NOTE N1). Deletes its seed.
//
// Needs `fixture.mjs create` and `server.mjs start`. Run it on a fresh fixture, before journeys that check people
// in: a MatFlow check-in after the seeded history (or a later imported visit) changes the expected coverage, and
// the precondition checks P1–P2 say so instead of reporting a product failure.
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, sleep } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("reports-clarity");
const tenantId = club.tenantId;
const errors = [];
const TAG = randomUUID().slice(0, 6);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const noHScroll = (p) => p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));

// ── Dates: the server's week (lib/reports.ts startOfWeek runs in the server's zone; this harness serves from this
// machine, in the club's zone, Europe/London) ─────────────────────────────────────────────────────────────────────
const clubZone = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0]?.timezone || "Europe/London";
const now = new Date();
const monday = new Date(now); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); monday.setHours(0, 0, 0, 0);
const dayAt = (base, days, h, m = 0) => { const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
// Four Saturdays, the last one two days before this Monday; visits at 10:05+ and 11:05+.
const saturdays = [3, 2, 1, 0].map((k) => dayAt(monday, -2 - 7 * k, 0));
const visitAt = (sat, c, i) => dayAt(sat, 0, c === 0 ? 10 : 11, 5 + i);
const lastVisit = visitAt(saturdays[3], 1, 3);
const historyEnd = dayAt(lastVisit, 1, 0); // the club day after the last imported visit (Sunday 00:00)
const longDate = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: clubZone });
const GAP_NOTE = `No attendance records for this period (imported history ends ${longDate(lastVisit)}; no check-ins recorded in MatFlow since)`;

// ── Seed ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const CLASS_A = `Kids BJJ (Age 4–7) Little Grapplers Fundamentals ${TAG}`;
const CLASS_B = `Kids BJJ (Age 4–7) Little Grapplers Advanced ${TAG}`;
const seeded = { classes: [], instances: [], members: [], records: [] };
async function seed() {
  for (const name of [CLASS_A, CLASS_B]) {
    const id = randomUUID();
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [id, tenantId, name]);
    seeded.classes.push(id);
  }
  const kid = randomUUID();
  await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'kids', true, now())`,
    [kid, tenantId, `${club.slug}-kid-${TAG}@example.test`.toLowerCase(), `Kid Clarity ${TAG}`]);
  seeded.members.push(kid);
  for (const [i, sat] of saturdays.entries()) {
    for (const [c, classId] of seeded.classes.entries()) {
      const inst = randomUUID();
      const iso = `${sat.getFullYear()}-${String(sat.getMonth() + 1).padStart(2, "0")}-${String(sat.getDate()).padStart(2, "0")}`;
      await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3::timestamp, $4, $4)`, [inst, classId, `${iso}T00:00:00.000Z`, c === 0 ? "10:00" : "11:00"]);
      seeded.instances.push(inst);
      const rec = randomUUID();
      const at = visitAt(sat, c, i);
      await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod") values ($1, $2, $3, $4, $5, 'import')`,
        [rec, tenantId, kid, inst, at]);
      seeded.records.push(rec);
    }
  }
}
async function cleanup() {
  if (seeded.records.length) await q(`delete from "AttendanceRecord" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.records]);
  if (seeded.instances.length) await q(`delete from "ClassInstance" where id = any($1::text[])`, [seeded.instances]);
  if (seeded.classes.length) await q(`delete from "Class" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.classes]);
  if (seeded.members.length) await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.members]);
  const left = Number((await q(`select (select count(*) from "AttendanceRecord" where id = any($1::text[])) + (select count(*) from "Class" where id = any($2::text[])) + (select count(*) from "Member" where id = any($3::text[])) as n`,
    [seeded.records, seeded.classes, seeded.members]))[0].n);
  L.check("teardown", "T1 the journey's seed is deleted (rows left = 0)", left === 0, { left });
}

await seed();
L.note("seed", "N0 seeded imported visits on four Saturdays; the last is the Saturday before this week", { lastVisit: lastVisit.toISOString(), historyEnd: historyEnd.toISOString(), monday: monday.toISOString(), zone: clubZone });
L.note("seed", "N1 read-only change: no save exists to force a failure on or to retry; the failure paths of the page are unchanged", "n/a");
const liveAfter = Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "checkInMethod" <> 'import' and "importJobId" is null and "checkInTime" >= $2`, [tenantId, historyEnd]))[0].n);
const lastImported = (await q(`select max("checkInTime") as t from "AttendanceRecord" where "tenantId" = $1 and ("checkInMethod" = 'import' or "importJobId" is not null)`, [tenantId]))[0].t;
L.check("seed", "P1 precondition: no MatFlow check-in in this club since the seeded history ends", liveAfter === 0, { liveAfter });
L.check("seed", "P2 precondition: the seeded visit is the club's latest imported visit", new Date(lastImported).getTime() === lastVisit.getTime(),
  { lastImported, seededLast: lastVisit.toISOString() });

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.97.0.31", { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);

  // C: the coverage the server computes. The report is cached for up to 60 s per club: wait for this seed to show.
  let api = null;
  for (let i = 0; i < 16; i++) {
    api = await page.request.get("/api/reports").then((r) => r.json()).catch(() => null);
    if (api?.attendanceCoverage?.historyEnd) break;
    await sleep(6000);
  }
  const cov = api?.attendanceCoverage ?? null;
  L.check("coverage", "C1 /api/reports knows where the imported history ends: the club day after the last imported visit",
    cov?.historyEnd === historyEnd.toISOString(), { saw: cov?.historyEnd ?? null, expected: historyEnd.toISOString() });
  L.check("coverage", "C2 MatFlow check-ins have not resumed, and this week has no records (\"gap\"), not a covered zero",
    cov?.resumes === null && cov?.thisWeek === "gap", { resumes: cov?.resumes, thisWeek: cov?.thisWeek, lastWeek: cov?.lastWeek });

  // R: the screen.
  await page.goto("/dashboard/reports?period=3m");
  await page.getByTestId("reports-filters").waitFor({ timeout: 90000 });
  const weekTile = page.getByTestId("metric-card").filter({ has: page.getByText("Attendance this week", { exact: true }) }).first();
  const weekLines = (await weekTile.locator("p").allInnerTexts()).map(norm);
  L.check("reports", "R1 \"Attendance this week\" is \"—\" and says the imported history ended with nothing recorded in MatFlow since (never 0)",
    weekLines[0] === "—" && weekLines[2] === `Now · ${GAP_NOTE}`, { saw: weekLines.slice(0, 3), expected: ["—", "Attendance this week", `Now · ${GAP_NOTE}`] });
  const weekly = page.locator("[data-slot='card']").filter({ has: page.getByRole("heading", { name: "Weekly Attendance" }) }).first();
  const weeklyText = norm(await weekly.innerText());
  L.check("reports", "R2 the weekly chart shades the weeks since the import as no data and says so",
    weeklyText.includes("weeks without records shaded as no data") && weeklyText.includes("No records since import"),
    { around: weeklyText.slice(0, 260) });
  const legendNames = (await page.getByTestId("donut-legend-ratio").locator("xpath=ancestor::li[1]").allInnerTexts()).map(norm);
  const fullA = legendNames.some((t) => t.startsWith(CLASS_A)), fullB = legendNames.some((t) => t.startsWith(CLASS_B));
  const legendCut = await page.locator("ul li span", { hasText: TAG }).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  L.check("reports", "R3 the Class composition legend prints both long class names in full (they share a prefix), none cut off",
    fullA && fullB && legendCut === 0, { legend: legendNames.filter((t) => t.includes(TAG)), cut: legendCut });
  const topText = norm(await page.locator("[data-slot='card']").filter({ has: page.getByRole("heading", { name: "Top Classes" }) }).first().innerText());
  L.check("reports", "R4 Top Classes prints the full names too", topText.includes(CLASS_A) && topText.includes(CLASS_B), { around: topText.slice(0, 300) });
  await shot(page, "reports-clarity-desktop");

  // F: the Kids filter.
  await page.getByRole("group", { name: "Age group" }).getByRole("button", { name: "Kids", exact: true }).click();
  await page.waitForURL(/ageGroup=kids/, { timeout: 60000 });
  await page.getByTestId("whole-club-tag").first().waitFor({ timeout: 60000 });
  const label = async (text) => norm(await page.getByTestId("metric-card").filter({ has: page.locator("p", { hasText: new RegExp(`^${text}`) }) }).first().locator("p").nth(1).innerText());
  const tagged = {
    active: await label("Active members"), classes: await label("Active classes"), churn: await label("Churn"),
    recovery: await label("Payment recovery rate"),
    health: norm(await page.getByRole("heading", { name: /Health Metrics/ }).innerText()),
    joined: norm(await page.getByTestId("reports-joined-tile").locator("p").nth(1).innerText()),
  };
  const untagged = { checkins: await label("Check-ins"), busiest: await label("Busiest class"), week: await label("Attendance this week") };
  L.check("filter", "F1 with Kids picked, every figure the filter does not narrow says \"Whole club\"",
    Object.values(tagged).every((t) => t.endsWith("Whole club")), tagged);
  L.check("filter", "F2 the figures the filter does narrow carry no tag", Object.values(untagged).every((t) => !t.includes("Whole club")), untagged);
  await shot(page, "reports-clarity-kids");
  await page.getByRole("group", { name: "Age group" }).getByRole("button", { name: "All", exact: true }).click();
  await page.waitForURL((u) => !u.searchParams.has("ageGroup"), { timeout: 60000 });
  await sleep(1500);
  L.check("filter", "F3 \"All\" removes every tag", (await page.getByTestId("whole-club-tag").count()) === 0, { tags: await page.getByTestId("whole-club-tag").count() });

  // W: "What counts" — in place, by keyboard.
  const churnCard = page.getByTestId("metric-card").filter({ has: page.locator("p", { hasText: /^Churn$/ }) }).first();
  const summary = churnCard.getByText("What counts", { exact: true });
  const before = page.url();
  await summary.focus();
  const focusVisible = await summary.evaluate((el) => el === document.activeElement && getComputedStyle(el).outlineStyle !== "none");
  await page.keyboard.press("Enter");
  const open = await churnCard.getByTestId("metric-card-more").evaluate((el) => el.open);
  const moreText = norm(await churnCard.getByTestId("metric-card-more").locator("p").innerText());
  L.check("keyboard", "W1 \"What counts\" is reached by focus, opens with Enter, stays on the page and shows churn's full wording",
    open && page.url() === before && moreText.includes("Every cancellation in the period"),
    { open, stayed: page.url() === before, focusVisible, moreText: moreText.slice(0, 160) });
  L.note("keyboard", "N2 focus ring on the summary (global :focus-visible)", { focusVisible });
  await page.keyboard.press("Enter");
  L.check("keyboard", "W2 Enter again closes it", !(await churnCard.getByTestId("metric-card-more").evaluate((el) => el.open)), {});

  // M: phone width.
  const pctx = await context(browser, "10.97.0.32", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await pctx.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(p2, club);
  await p2.goto("/dashboard/reports?period=3m&ageGroup=kids");
  await p2.getByTestId("whole-club-tag").first().waitFor({ timeout: 90000 });
  await p2.waitForTimeout(1500);
  const m = await noHScroll(p2);
  L.check("mobile", "M1 /dashboard/reports at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  const tagsInside = await p2.getByTestId("whole-club-tag").evaluateAll((els) => els.every((t) => {
    const card = t.closest("[data-slot='card']") ?? t.closest("[data-testid='metric-card']") ?? document.body;
    const a = t.getBoundingClientRect(), b = card.getBoundingClientRect();
    return a.right <= b.right + 1 && a.left >= b.left - 1;
  }));
  L.check("mobile", "M2 every Whole club tag stays inside its tile or card", tagsInside, {});
  const mLegendCut = await p2.locator("ul li span", { hasText: TAG }).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
  L.check("mobile", "M3 the long class names wrap at 390 px, none cut off", mLegendCut === 0, { cut: mLegendCut });
  const tap = await p2.getByText("What counts", { exact: true }).first().boundingBox();
  L.note("mobile", "N3 the \"What counts\" tap target (summary line; the tile's link above it is the card-sized target)", tap);
  await shot(p2, "reports-clarity-mobile");

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await cleanup().catch((e) => L.check("teardown", "T1 the journey's seed is deleted", false, String(e).slice(0, 200)));
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
