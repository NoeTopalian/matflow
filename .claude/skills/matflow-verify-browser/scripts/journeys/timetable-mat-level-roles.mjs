// Journey: two 11:00 classes on two mats line up for every role (24 Nov 2026, the owner's own timetable requirement).
// On one club-local day (Wednesday) Mat Pair A is 11:00-12:00 on Mat 1 and Mat Pair B 11:00-12:00 on Mat 2. Signed in
// separately as admin, owner, coach and member, on a phone (390 px) and a desktop (1280 px):
//   P1 By mat: each card sits under its own mat's heading; their rendered tops differ by at most 1 CSS px; equal
//      durations end level. P2: B ends at 12:30 (tops level, B's bottom lower). P3: an earlier 10:30-11:30 class on
//      Mat 1 only (on screen, under Mat 1, above A; the pair as before).
//   D  The P1 pair again in the staff desktop Day view (admin, owner, coach at 1280 px): the grid's third staff surface.
//   F  Thursday has four 11:00 classes on four mats: more than a phone's three tracks, so the staff phone and the
//      members' day (three tracks at every width) must fall back to time and say so; the staff week at 1280 keeps
//      mat columns. Either way the pair shares one logical start row.
//   T  The club switched to By time: the page must draw no mat columns, and the pair shares one start row.
// Only the active, visible pane is measured (the members' day keeps yesterday's and tomorrow's panes off screen, and a
// card behind another layer is not visible). The layout reported is the one the page drew, never the one requested.
// Every row of the matrix names the role, width, the view drawn and what was measured.
// Synthetic data only. Needs `fixture.mjs create` and `server.mjs start`; removes its classes and mats and puts the
// club's layout back as it found it.
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
const DAY_SLUG = { Wednesday: "wed", Thursday: "thu" };

const setLayout = (page, layout) => page.evaluate(async (l) => (await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: l }) })).status, layout);

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [tenantId, NAMES]);
  for (const { id } of rows) {
    for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch((e) => console.log(`  (could not remove ${id}: ${String(e).slice(0, 120)})`));
  }
}

/**
 * The active grid for a surface: the staff phone's day, the staff week, or the members' day on screen (not the panes
 * either side). Each named card is looked for in that grid only, brought into view, and measured there: how many
 * copies the grid holds, whether the one measured is really visible (on screen and the top-most element at its
 * centre), its mat column and that column's heading, its start row, and which day the grid shows.
 */
const measure = (page, surface, width, names) => page.evaluate(({ surface, width, names }) => {
  const grid = surface === "member"
    ? document.querySelector('[data-testid="schedule-pane"] [data-testid="schedule-day"]')
    : width === "390" ? document.querySelector('[data-testid="phone-day-grid"]')
    : width === "day" ? document.querySelector('[data-testid="day-view"] [data-testid="phone-day-grid"]')
    : document.querySelector('[data-testid="week-grid"]');
  if (!grid) return { grid: false };
  const out = { grid: true, cards: {} };
  const found = names.map((name) => [name, [...grid.querySelectorAll("[data-cell-key] button")].filter((el) => (el.getAttribute("aria-label") ?? "").includes(`${name}, `) && !el.closest("[inert]"))]);
  // One scroll, to the first card, then every card is measured at that same scroll: scrolling to each in turn moved
  // the page between readings (B, 18 px taller in P2, read 9 px "higher" than A).
  found[0][1][0]?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  for (const [name, all] of found) {
    if (all.length === 0) { out.cards[name] = { name, missing: true, copies: 0 }; continue; }
    const btn = all[0];
    const r = btn.getBoundingClientRect();
    const hitEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cell = btn.closest("[data-cell-key]");
    const day = cell.closest("[data-day]");
    const matId = cell.getAttribute("data-mat");
    const head = matId && day ? day.querySelector(`[data-mat-head="${matId}"]`) : null;
    const h = head?.getBoundingClientRect();
    // Visible: wholly on screen, and what answers at its centre is this card or its own cell. A card a role cannot
    // open is not a hit target itself (the hit lands on its cell); anything else answering there is a layer over it.
    const hitDesc = hitEl ? `${hitEl.tagName.toLowerCase()}${hitEl.getAttribute("data-testid") ? `[${hitEl.getAttribute("data-testid")}]` : ""}.${String(hitEl.className).split(" ")[0]}${cell.contains(hitEl) ? " (own cell)" : ""}` : null;
    out.cards[name] = {
      name, copies: all.length, day: day?.getAttribute("data-day") ?? null,
      hit: hitDesc, pointer: getComputedStyle(btn).pointerEvents, disabled: btn.disabled,
      visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && !!hitEl && (hitEl === btn || cell.contains(hitEl)),
      top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10,
      rowStart: cell.getAttribute("data-row-start"),
      heading: head ? (head.textContent ?? "").trim() : null,
      underHeading: !!h && r.left >= h.left - 1 && r.right <= h.right + 1,
      matHeadsInDay: day ? [...day.querySelectorAll("[data-mat-head]")].length : 0,
    };
  }
  // The fallback note of the active pane only.
  const scope = surface === "member" ? document.querySelector('[data-testid="schedule-pane"]') : document;
  const note = scope?.querySelector('[data-testid="phone-day-fallback"], [data-testid="schedule-fallback"]');
  out.fellBack = !!note && note.getBoundingClientRect().height > 0;
  return out;
}, { surface, width, names });

/** What the page drew for the measured day: mat columns, a stated fallback to time, or plain time. */
const drawn = (m, name) => (m.cards[name]?.matHeadsInDay > 0 ? "By mat" : m.fellBack ? "By mat, fell back to time" : "By time");

/** Open the day on this surface and confirm the switch landed. */
async function openDay(page, surface, width, day) {
  if (surface === "member") {
    await page.goto("/member/schedule");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: new RegExp(`^${day.slice(0, 3)}\\s*\\d`, "i") }).first().click();
  } else {
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    if (width === "390") {
      const tab = page.getByRole("tab", { name: new RegExp(`^${day.slice(0, 3)}`) }).first();
      await tab.waitFor({ timeout: 60000 });
      await tab.click();
    } else if (width === "day") {
      // The desktop Day view: switch to it (retried until it reports pressed), then the day's tab inside it.
      const dayButton = page.getByTestId("timetable-view-day");
      await dayButton.waitFor({ timeout: 60000 });
      for (let i = 0; i < 10 && (await dayButton.getAttribute("aria-pressed")) !== "true"; i++) { await dayButton.click(); await page.waitForTimeout(500); }
      const tab = page.getByTestId("day-view").getByRole("tab", { name: new RegExp(`^${day}`) }).first();
      await tab.waitFor({ timeout: 60000 });
      await tab.click();
    }
  }
  await page.waitForTimeout(800);
}

let browser;
let startLayout;
try {
  await cleanup();
  startLayout = (await q(`select "timetableLayout" from "Tenant" where id = $1`, [tenantId]))[0]?.timetableLayout ?? null;
  browser = await chromium.launch();
  // Owner: seeds the week through the app (classes, then the mats adopted from their places), split by mat.
  const oc = await context(browser, "10.95.9.1", { viewport: { width: 1280, height: 800 }, timezoneId: "Europe/London" });
  const op = await oc.newPage();
  op.on("pageerror", (e) => errors.push(`owner: ${String(e).slice(0, 200)}`));
  await ownerSignIn(op, club);
  await op.goto("/dashboard/timetable");
  await seedWeek(op, WEEK, { adopt: true });
  const stored = await q(`select c.name, m.name as mat, s."dayOfWeek", s."startTime", s."endTime" from "Class" c join "ClassSchedule" s on s."classId" = c.id left join "Mat" m on m.id = c."matId" where c."tenantId" = $1 and c.name = any($2) order by c.name`, [tenantId, NAMES]);
  L.check("seed", "stored: six classes, one slot each, on the mat they were made for (counted in the database)",
    stored.length === WEEK.rows.length && WEEK.rows.every(([, , , name, , mat]) => stored.some((s) => s.name === name && s.mat === `Mat ${mat}`)), stored);
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
  const DAY_VIEW = [{ tag: "day", opts: { viewport: { width: 1280, height: 800 } } }];
  const run = async (phase, day, names, expectView, expect, { roles = ["admin", "owner", "coach", "member"], widths = WIDTHS } = {}) => {
    for (const role of roles) {
      for (const w of widths) {
        const surface = role === "member" ? "member" : "staff";
        const ctx = await context(browser, `10.95.9.${20 + matrix.length % 200}`, { ...w.opts, storageState: sessions[role], timezoneId: "Europe/London" });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errors.push(`${role}@${w.tag}: ${String(e).slice(0, 200)}`));
        try {
          await openDay(page, surface, w.tag, day);
          const m = await measure(page, surface, w.tag, names);
          const [a, b] = [m.cards?.[names[0]] ?? { missing: true }, m.cards?.[names[1]] ?? { missing: true }];
          const view = m.grid ? drawn(m, names[0]) : "no grid";
          const want = expectView(surface, w.tag);
          const both = !a.missing && !b.missing;
          const dTop = both ? Math.round(Math.abs(a.top - b.top) * 10) / 10 : null;
          const row = { phase, role, width: w.tag, view, expectedView: want, day: a.day ?? null, a, b, topDiff: dTop, bottomBminusA: both ? Math.round((b.bottom - a.bottom) * 10) / 10 : null, extra: names[2] ? m.cards?.[names[2]] : undefined };
          matrix.push(row);
          const common = m.grid && both && a.copies === 1 && b.copies === 1 && a.visible && b.visible && a.day === DAY_SLUG[day] && view === want;
          const ok = common && expect(a, b, m);
          L.check(`${phase}@${role}@${w.tag}`, `${phase}: drew ${view} (expected ${want}) on ${a.day ?? "?"}: ${names[0]} and ${names[1]}`, ok, row);
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
  const byMat = () => "By mat";
  const matPair = (a, b) => a.heading === "Mat 1" && b.heading === "Mat 2" && a.underHeading && b.underHeading && Math.abs(a.top - b.top) <= 1;

  // P1: equal durations: own headings, tops level, bottoms level.
  await run("P1", "Wednesday", ["Mat Pair A", "Mat Pair B"], byMat, (a, b) => matPair(a, b) && Math.abs(a.bottom - b.bottom) <= 1);
  // D: the same pair in the staff desktop Day view (1280 px), the third staff surface that draws the grid.
  await run("D", "Wednesday", ["Mat Pair A", "Mat Pair B"], byMat, (a, b) => matPair(a, b) && Math.abs(a.bottom - b.bottom) <= 1, { roles: ["admin", "owner", "coach"], widths: DAY_VIEW });

  // P2: B ends at 12:30. Tops level, B's bottom lower.
  const pairB = (await q(`select id from "Class" where "tenantId" = $1 and name = 'Mat Pair B'`, [tenantId]))[0].id;
  await q(`update "ClassSchedule" set "endTime" = '12:30' where "classId" = $1`, [pairB]);
  await q(`update "Class" set duration = 90 where id = $1 and "tenantId" = $2`, [pairB, tenantId]);
  await run("P2", "Wednesday", ["Mat Pair A", "Mat Pair B"], byMat, (a, b) => matPair(a, b) && b.bottom > a.bottom + 2);

  // P3: an earlier 10:30-11:30 class on Mat 1 only, overlapping A: on screen, under Mat 1, above A; the pair as before.
  const mat1 = await q(`select id from "Mat" where "tenantId" = $1 and name = 'Mat 1'`, [tenantId]);
  if (mat1.length !== 1) throw new Error(`expected one "Mat 1", found ${mat1.length}`);
  const early = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "matId", location) values ($1, $2, 'Mat Early', 60, 30, $3, 'Mat 1')`, [early, tenantId, mat1[0].id]);
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, 3, '10:30', '11:30')`, [randomUUID(), early]);
  await run("P3", "Wednesday", ["Mat Pair A", "Mat Pair B", "Mat Early"], byMat, (a, b, m) => {
    const e = m.cards["Mat Early"];
    return matPair(a, b) && b.bottom > a.bottom + 2 && !!e && !e.missing && e.copies === 1 && e.heading === "Mat 1" && e.underHeading && e.top < a.top;
  });

  // F: the fallback where it must happen (staff phone; the members' day at both widths); mat columns on the staff week.
  await run("F", "Thursday", ["Busy One", "Busy Two"], (surface, width) => (surface === "staff" && width === "1280" ? "By mat" : "By mat, fell back to time"),
    (a, b) => a.rowStart !== null && a.rowStart === b.rowStart && Math.abs(a.top - b.top) <= 1);

  // T: By time; the page must draw no mat columns; the pair shares one start row.
  const toTime = await setLayout(op, "time");
  L.check("T", "the club is switched to By time", toTime === 200, { toTime });
  try {
    await run("T", "Wednesday", ["Mat Pair A", "Mat Pair B"], () => "By time", (a, b) => a.rowStart !== null && a.rowStart === b.rowStart && Math.abs(a.top - b.top) <= 1);
  } finally {
    await setLayout(op, "mat").catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  // Leave the club as found: its layout, and none of the mats this journey adopted.
  await q(`update "Tenant" set "timetableLayout" = $2 where id = $1`, [tenantId, startLayout ?? null]).catch(() => {});
  await q(`delete from "Mat" where "tenantId" = $1 and name = any($2)`, [tenantId, WEEK.mats]).catch((e) => console.log(`  (mats kept: ${String(e).slice(0, 120)})`));
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  fs.writeFileSync(`${OUT}/mat-level-roles-matrix.json`, JSON.stringify(matrix, null, 2));
  console.log("\nMATRIX phase | role | width | view drawn (expected) | day | top diff | B bottom - A bottom | A heading/B heading | rows | copies");
  for (const r of matrix) {
    if (r.error) { console.log(`${r.phase} | ${r.role} | ${r.width} | ERROR ${r.error}`); continue; }
    console.log(`${r.phase} | ${r.role} | ${r.width} | ${r.view} (${r.expectedView}) | ${r.day} | ${r.topDiff} | ${r.bottomBminusA} | ${r.a.heading ?? "-"}${r.a.underHeading ? "" : "(outside)"}/${r.b.heading ?? "-"}${r.b.underHeading ? "" : "(outside)"} | ${r.a.rowStart}/${r.b.rowStart} | ${r.a.copies}/${r.b.copies}`);
  }
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
