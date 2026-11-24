// Journey: two 11:00 classes on two mats line up for every role (24 Nov 2026, the owner's own timetable requirement).
// On one club-local day (Wednesday) Mat Pair A is 11:00-12:00 on Mat 1 and Mat Pair B 11:00-12:00 on Mat 2. Signed in
// separately as admin, owner, coach and member, on a phone (390 px) and a desktop (1280 px), in By mat:
//   each card sits under its own mat's heading; their rendered tops differ by at most 1 CSS px; equal durations end
//   level. Then B ends at 12:30 (tops level, B's bottom lower), then an earlier 10:30-11:30 class is added on Mat 1
//   only (the same again). In By time, and in the narrow-phone fallback (Thursday: four 11:00 classes on four mats,
//   more than a phone's three tracks), the two 11:00 classes share one logical start row (data-row-start).
// Every row of the matrix names the role, width, the view the screen actually drew, and what was measured.
// Synthetic data only. Needs `fixture.mjs create` and `server.mjs start`; cleans up its own classes.
//   node journeys/timetable-mat-level-roles.mjs
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, memberLogin, memberSignIn, OUT } from "../lib.mjs";
import { seedWeek } from "./data/timetable-weeks.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("timetable-mat-level-roles");
const errors = [];
const matrix = [];

// Rows: [day (0 = Monday), start, end, name, colour, mat (1-based)]. Wednesday is the pair; Thursday overflows a phone.
const WEEK = {
  key: "mat-level-roles",
  mats: ["Mat 1", "Mat 2", "Mat 3", "Mat 4"],
  noMatPlace: "Sports hall",
  dark: [],
  rows: [
    [2, "11:00", "12:00", "Mat Pair A", "#3b82f6", 1],
    [2, "11:00", "12:00", "Mat Pair B", "#f97316", 2],
    [3, "11:00", "12:00", "Busy One", "#22c55e", 1],
    [3, "11:00", "12:00", "Busy Two", "#eab308", 2],
    [3, "11:00", "12:00", "Busy Three", "#ec4899", 3],
    [3, "11:00", "12:00", "Busy Four", "#14b8a6", 4],
  ],
};
const NAMES = ["Mat Pair A", "Mat Pair B", "Busy One", "Busy Two", "Busy Three", "Busy Four", "Mat Early"];

const setLayout = (page, layout) => page.evaluate(async (l) => (await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: l }) })).status, layout);

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [tenantId, NAMES]);
  for (const { id } of rows) {
    for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch((e) => console.log(`  (could not remove ${id}: ${String(e).slice(0, 120)})`));
  }
}

/**
 * Both cards, measured in the page: rect, the mat column each sits in and that column's heading, the row it starts on,
 * and whether the screen says it fell back to time. `prefix` is how a card's accessible name starts or contains.
 */
const measure = (page, a, b) => page.evaluate(([a, b]) => {
  const card = (name) => [...document.querySelectorAll("[data-cell-key] button")].find((el) => (el.getAttribute("aria-label") ?? "").includes(`${name}, `) && el.getBoundingClientRect().width > 0);
  const one = (name) => {
    const btn = card(name);
    if (!btn) return { name, missing: true };
    const r = btn.getBoundingClientRect();
    const cell = btn.closest("[data-cell-key]");
    const matId = cell?.getAttribute("data-mat") ?? null;
    let head = null;
    for (let up = cell?.parentElement; up && !head; up = up.parentElement) head = matId ? up.querySelector(`[data-mat-head="${matId}"]`) : null;
    const h = head?.getBoundingClientRect();
    return {
      name, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, left: Math.round(r.left), right: Math.round(r.right),
      rowStart: cell?.getAttribute("data-row-start") ?? null,
      heading: head ? (head.textContent ?? "").trim() : null,
      underHeading: !!h && r.left >= h.left - 1 && r.right <= h.right + 1,
    };
  };
  const fellBack = [...document.querySelectorAll('[data-testid="phone-day-fallback"], [data-testid="schedule-fallback"]')].some((el) => el.getBoundingClientRect().height > 0);
  const matHeads = [...document.querySelectorAll("[data-mat-head]")].filter((el) => el.getBoundingClientRect().width > 0).length;
  return { a: one(a), b: one(b), fellBack, matHeads };
}, [a, b]);

const viewOf = (layout, m) => (layout === "time" ? "By time" : m.fellBack ? "By mat, fell back to time" : m.matHeads > 0 ? "By mat" : "By mat (no mat headings drawn)");

/** Open the right day for this surface and wait for both cards. */
async function openDay(page, surface, day) {
  if (surface === "member") {
    await page.goto("/member/schedule");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: new RegExp(`^${day.slice(0, 3)}\\s*\\d`, "i") }).first().click();
  } else {
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    const tab = page.getByRole("tab", { name: new RegExp(`^${day.slice(0, 3)}`) });
    if (await tab.count()) await tab.first().click();
  }
  await page.waitForTimeout(800);
}

let browser;
try {
  await cleanup();
  browser = await chromium.launch();
  // Owner: seeds the week through the app (classes, then the mats adopted from their places), split by mat.
  const oc = await context(browser, "10.95.9.1", { viewport: { width: 1280, height: 800 }, timezoneId: "Europe/London" });
  const op = await oc.newPage();
  op.on("pageerror", (e) => errors.push(`owner: ${String(e).slice(0, 200)}`));
  await ownerSignIn(op, club);
  await op.goto("/dashboard/timetable");
  const seeded = await seedWeek(op, WEEK, { adopt: true });
  L.check("seed", "Wednesday pair on Mat 1 and Mat 2, Thursday four on four mats, created through the app and adopted as mats", seeded.sessions === WEEK.rows.length, seeded);
  const layoutStatus = await setLayout(op, "mat");
  L.check("seed", "the club is split by mat", layoutStatus === 200, { layoutStatus });

  // Accounts: admin and coach created for this club; the owner is the fixture's; the member is the fixture's Member 1.
  const admin = await seedStaff(club, "admin", { name: "Fixture Admin" });
  const coach = await seedStaff(club, "coach", { name: "Fixture Coach" });
  const member = await memberLogin(club);
  const sessions = {};
  for (const [role, lane] of [["owner", 2], ["admin", 3], ["coach", 4], ["member", 5]]) {
    const c = await context(browser, `10.95.9.${lane}`, { timezoneId: "Europe/London" });
    const p = await c.newPage();
    if (role === "owner") await ownerSignIn(p, club);
    else if (role === "member") await memberSignIn(p, club, member);
    else await staffSignIn(p, club, role === "admin" ? admin : coach);
    sessions[role] = await c.storageState();
    await c.close();
  }

  const WIDTHS = [
    { tag: "390", opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { tag: "1280", opts: { viewport: { width: 1280, height: 800 } } },
  ];
  const run = async (phase, layout, day, a, b, expect) => {
    for (const role of ["admin", "owner", "coach", "member"]) {
      for (const w of WIDTHS) {
        const surface = role === "member" ? "member" : "staff";
        const ctx = await context(browser, `10.95.9.${20 + matrix.length % 200}`, { ...w.opts, storageState: sessions[role], timezoneId: "Europe/London" });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(`${role}@${w.tag}: ${String(e).slice(0, 200)}`));
        try {
          await openDay(page, surface, day);
          const m = await measure(page, a, b);
          const view = viewOf(layout, m);
          const dTop = m.a.missing || m.b.missing ? null : Math.round(Math.abs(m.a.top - m.b.top) * 10) / 10;
          const dBottom = m.a.missing || m.b.missing ? null : Math.round((m.b.bottom - m.a.bottom) * 10) / 10;
          const row = { phase, role, width: w.tag, view, a: m.a, b: m.b, topDiff: dTop, bottomBminusA: dBottom };
          matrix.push(row);
          const ok = expect(m, view);
          L.check(`${phase}@${role}@${w.tag}`, `${phase}: ${view}, ${a} and ${b}`, ok, row);
          if (!ok) await shot(page, `mat-level-${phase}-${role}-${w.tag}`);
          if (role === "owner" && phase === "P1") await shot(page, `mat-level-P1-owner-${w.tag}`);
        } catch (e) {
          matrix.push({ phase, role, width: w.tag, error: String(e).slice(0, 200) });
          L.check(`${phase}@${role}@${w.tag}`, `${phase}: ran to the end`, false, String(e).slice(0, 300));
        } finally {
          await ctx.close();
        }
      }
    }
  };
  const matPair = ({ a, b }) => !a.missing && !b.missing && a.heading === "Mat 1" && b.heading === "Mat 2" && a.underHeading && b.underHeading && Math.abs(a.top - b.top) <= 1;

  // P1: equal durations, By mat: own headings, tops level, bottoms level.
  await run("P1", "mat", "Wednesday", "Mat Pair A", "Mat Pair B", (m, view) => view === "By mat" && matPair(m) && Math.abs(m.a.bottom - m.b.bottom) <= 1);

  // P2: B ends at 12:30. Tops level, B's bottom lower.
  const pairB = (await q(`select id from "Class" where "tenantId" = $1 and name = 'Mat Pair B'`, [tenantId]))[0].id;
  await q(`update "ClassSchedule" set "endTime" = '12:30' where "classId" = $1`, [pairB]);
  await q(`update "Class" set duration = 90 where id = $1 and "tenantId" = $2`, [pairB, tenantId]);
  await run("P2", "mat", "Wednesday", "Mat Pair A", "Mat Pair B", (m, view) => view === "By mat" && matPair(m) && m.b.bottom > m.a.bottom + 2);

  // P3: an earlier 10:30-11:30 class on Mat 1 only, overlapping A. The same again.
  const mat1 = (await q(`select id from "Mat" where "tenantId" = $1 and name = 'Mat 1'`, [tenantId]))[0]?.id;
  const early = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "matId", location) values ($1, $2, 'Mat Early', 60, 30, $3, 'Mat 1')`, [early, tenantId, mat1]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, 3, '10:30', '11:30')`, [randomUUID(), early]);
  await run("P3", "mat", "Wednesday", "Mat Pair A", "Mat Pair B", (m, view) => view === "By mat" && matPair(m) && m.b.bottom > m.a.bottom + 2);

  // The narrow-phone fallback (still By mat): Thursday's four mats are more than a phone's three tracks.
  await run("F", "mat", "Thursday", "Busy One", "Busy Two", (m, view) => (view === "By mat, fell back to time" || view === "By mat")
    && !m.a.missing && !m.b.missing && m.a.rowStart !== null && m.a.rowStart === m.b.rowStart && Math.abs(m.a.top - m.b.top) <= 1);

  // By time: the pair (with P2 and P3's changes) shares one logical start row.
  const toTime = await setLayout(op, "time");
  L.check("T", "the club is switched to By time", toTime === 200, { toTime });
  await run("T", "time", "Wednesday", "Mat Pair A", "Mat Pair B", (m) => !m.a.missing && !m.b.missing && m.a.rowStart !== null && m.a.rowStart === m.b.rowStart && Math.abs(m.a.top - m.b.top) <= 1);
  const back = await setLayout(op, "mat");
  L.check("T", "the club is put back to By mat", back === 200, { back });
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  fs.writeFileSync(`${OUT}/mat-level-roles-matrix.json`, JSON.stringify(matrix, null, 2));
  console.log("\nMATRIX phase | role | width | view | top diff | B bottom - A bottom | A heading/B heading | rows");
  for (const r of matrix) {
    if (r.error) { console.log(`${r.phase} | ${r.role} | ${r.width} | ERROR ${r.error}`); continue; }
    console.log(`${r.phase} | ${r.role} | ${r.width} | ${r.view} | ${r.topDiff} | ${r.bottomBminusA} | ${r.a.heading ?? "-"}${r.a.underHeading ? "" : "(outside)"}/${r.b.heading ?? "-"}${r.b.underHeading ? "" : "(outside)"} | ${r.a.rowStart}/${r.b.rowStart}`);
  }
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
