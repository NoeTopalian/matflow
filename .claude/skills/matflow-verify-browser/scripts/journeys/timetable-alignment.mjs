// Journey: timetable alignment and the member empty-day colour (24 Nov 2026, from the UI/UX audit of that date).
// Positions are asserted, never judged from a picture:
//   T1 the week grid (768 and 1280) and the staff phone's day (320 and 390) keep every layout rule (lib gridInvariants:
//      same start = same line in every day, a later start never higher, over ten minutes later strictly lower, no two
//      chips intersect, each inside its day and its mat column, nothing cut) for classes that overlap, last 45 and
//      75 minutes, start off the hour, and a day with no classes;
//   T2 every chip sits on the time axis: its row carries a label, the label reads the chip's own start time and the
//      chip's top is 1.5 px (within 1) below it; every day header shares one top and one bottom;
//   T3 a day with no classes keeps its column and says so;
//   C1 the members' "No classes today" reads at WCAG AA (4.5:1) on every member theme preset (8 dark, 4 light),
//      measured from the computed colour against the shell's computed background.
// Needs `fixture.mjs create` and `server.mjs start`. Seeds its own classes (synthetic names) and removes them.
//   node journeys/timetable-alignment.mjs
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, gridInvariants, phoneNoSidewaysScroll, OUT } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const tenantId = club.tenantId;
const L = ledger("timetable-alignment");
const errors = [];

// Mon–Sat carry the same awkward day; Sunday has nothing.
const DAY_CLASSES = [
  ["Al Overlap A", "18:00", "19:00"],
  ["Al Overlap B", "18:00", "19:00"],
  ["Al Overlap C", "18:30", "19:15"], // overlaps both, off the hour, 45 minutes
  ["Al Forty-five", "07:00", "07:45"],
  ["Al Seventy-five", "12:00", "13:15"],
  ["Al Off hour", "06:30", "07:15"], // off the hour, overlaps the 07:00
  ["Al Quarter past", "17:15", "18:30"], // 75 minutes, off the hour, runs into the 18:00 clash
  ["Al Twenty past", "11:20", "12:10"], // the pilot club's 11:00 / 11:20 pair
  ["Al Eleven", "11:00", "12:00"],
];
const DAYS = [1, 2, 3, 4, 5, 6]; // Prisma dayOfWeek: 0 = Sunday
const SESSIONS = DAY_CLASSES.length * DAYS.length;
const PRESETS = ["#111111", "#0a0a0a", "#0d0d0d", "#0f0a1a", "#080f0a", "#050d12", "#0a0a14", "#120508", "#f8fafc", "#f0fdf4", "#fffbeb", "#f0f9ff"];

const seeded = [];
async function cleanup() {
  for (const id of seeded) {
    for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch((e) => console.log(`  (could not remove class ${id}: ${String(e).slice(0, 120)})`));
  }
}

/** The axis and the headers, measured in the page: T2. */
const axis = (page, testId) => page.evaluate((testId) => {
  const grid = document.querySelector(`[data-testid="${testId}"]`);
  if (!grid) return { problems: [`no ${testId}`] };
  const ticks = [...grid.querySelectorAll(".pg-tick")].map((t) => ({ row: Number(/^(\d+)/.exec(t.style.gridRow)?.[1]), top: t.getBoundingClientRect().top, text: t.textContent.trim() }));
  const offsets = [];
  const problems = [];
  // The chip itself (not its cell) against the time label of the row it starts on: the label must read the chip's own
  // start time (this journey runs By time, so nothing is levelled onto another class's line), and the chip's top must
  // sit on the label's line (the cell's 1.5 px inset, within 1 px).
  for (const cell of grid.querySelectorAll("[data-cell-key]")) {
    const row = Number(cell.getAttribute("data-row-start"));
    const tick = ticks.find((t) => t.row === row);
    const button = cell.querySelector("button");
    const time = (button?.querySelector('[data-chip-part="time"], [data-block-part="time"]')?.textContent ?? "").trim().slice(0, 5);
    if (!tick || !button) { problems.push(`${button?.getAttribute("aria-label") ?? cell.getAttribute("data-cell-key")}: ${button ? `no time label on row ${row}` : "no chip in the cell"}`); continue; }
    const off = button.getBoundingClientRect().top - tick.top;
    offsets.push({ row, off, tick: tick.text, time });
    if (tick.text !== time) problems.push(`${button.getAttribute("aria-label")}: drawn on the ${tick.text} line but starts ${time}`);
    if (Math.abs(off - 1.5) > 1) problems.push(`${button.getAttribute("aria-label")}: ${off.toFixed(1)} px from its ${tick.text} label (expected 1.5 ± 1)`);
  }
  if (offsets.length === 0) problems.push("no chip starts on a labelled row");
  const offs = offsets.map((o) => o.off);
  const heads = [...grid.querySelectorAll("[data-day-head]")].map((h) => { const r = h.getBoundingClientRect(); return { day: h.getAttribute("data-day-head"), top: r.top, bottom: r.bottom, width: r.width }; });
  if (heads.length) {
    const tops = heads.map((h) => h.top), bottoms = heads.map((h) => h.bottom);
    if (Math.max(...tops) - Math.min(...tops) > 1) problems.push(`day headers start at different heights: ${JSON.stringify(heads.map((h) => [h.day, Math.round(h.top)]))}`);
    if (Math.max(...bottoms) - Math.min(...bottoms) > 1) problems.push(`day headers end at different heights: ${JSON.stringify(heads.map((h) => [h.day, Math.round(h.bottom)]))}`);
  }
  return { problems, labelled: offsets.length, ticks: ticks.length, offset: offs.length ? Math.round(offs[0] * 10) / 10 : null, heads: heads.map((h) => [h.day, Math.round(h.width)]) };
}, testId);

/** WCAG contrast of an element's text against the member shell background, both as the browser computed them. */
const contrastOf = (page, selector) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  // rgb()/rgba() only: any other colour syntax (oklch, color()) would be misread, so it fails loudly instead.
  const parse = (c) => { if (!/^rgba?\(/.test(c)) throw new Error(`unexpected colour format: ${c}`); return (c.match(/[\d.]+/g) ?? []).map(Number); };
  const shell = document.getElementById("member-app");
  const [br, bg, bb] = parse(getComputedStyle(shell).backgroundColor);
  const [r, g, b, a = 1] = parse(getComputedStyle(el).color);
  const mix = [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
  const lum = (c) => { const [x, y, z] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
  const [l1, l2] = [lum(mix), lum([br, bg, bb])].sort((p, q2) => q2 - p);
  return { ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, text: getComputedStyle(el).color, shell: getComputedStyle(shell).backgroundColor };
}, selector);

let browser;
// Read before anything can fail, so the restore below never writes a value that was not read.
const startLayout = (await q(`select "timetableLayout" from "Tenant" where id = $1`, [tenantId]))[0]?.timetableLayout ?? null;
try {
  for (const r of await q(`select id from "Class" where "tenantId" = $1 and name like 'Al %'`, [tenantId])) seeded.push(r.id);
  await cleanup();
  seeded.length = 0;
  browser = await chromium.launch();
  const oc = await context(browser, "10.95.4.1", { timezoneId: "Europe/London" });
  const op = await oc.newPage();
  op.on("pageerror", (e) => errors.push(`owner: ${String(e).slice(0, 200)}`));
  await ownerSignIn(op, club);
  const ownerState = await oc.storageState();
  // This week has no mats: measure it By time whatever an earlier journey left the club on, and put that back after.
  const toTime = await op.evaluate(async () => (await fetch("/api/timetable/layout", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: "time" }) })).status);
  L.check("setup", "the club is set to By time for this week", toTime === 200, { toTime, startLayout });

  // ── C1: the members' empty day, on every theme preset (before any class exists, so today is empty) ──
  const startBg = (await q(`select "bgColor" from "Tenant" where id = $1`, [tenantId]))[0]?.bgColor ?? null;
  const member = await memberLogin(club);
  const mc = await context(browser, "10.95.4.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const mp = await mc.newPage();
  mp.on("pageerror", (e) => errors.push(`member: ${String(e).slice(0, 200)}`));
  await memberSignIn(mp, club, member);
  const ratios = [];
  try {
    for (const bg of PRESETS) {
      await op.goto("/dashboard/settings");
      const status = await op.evaluate(async (b) => (await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bgColor: b }) })).status, bg);
      await mp.goto("/member/schedule");
      await mp.waitForLoadState("networkidle");
      // The members' day is three panes (yesterday, today, tomorrow): the one on screen.
      const empty = mp.getByText("No classes today", { exact: true }).filter({ visible: true }).first();
      const shown = await empty.waitFor({ timeout: 30000 }).then(() => true, () => false);
      // The preset must really be the one on screen, or this row measures the previous theme under the wrong name.
      const applied = await mp.waitForFunction((b) => {
        const s = getComputedStyle(document.getElementById("member-app")).backgroundColor.match(/\d+/g).map(Number);
        const want = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
        return s.slice(0, 3).every((v, i) => v === want[i]);
      }, bg, { timeout: 90000 }).then(() => true, () => false);
      const c = shown && applied ? await empty.evaluate((el) => { el.setAttribute("data-probe", "empty"); return true; }).then(() => contrastOf(mp, '[data-probe="empty"]')) : null;
      ratios.push({ bg, status, shown, applied, ...c });
      if (bg === "#111111") await shot(mp, "alignment-member-empty-111111");
    }
  } finally {
    // Back to how the club started; a club with none set gets the app's default shell colour.
    await op.evaluate(async (b) => fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bgColor: b }) }), startBg ?? "#111111").catch(() => {});
  }
  const low = ratios.filter((r) => !(r.status === 200 && r.applied && r.shown && r.ratio >= 4.5));
  L.check("C1", 'members\' "No classes today" reads at 4.5:1 or better on all 12 theme presets, each one saved (200) and confirmed on screen before it is measured', low.length === 0, { low, ratios: ratios.map((r) => `${r.bg} ${r.status} ${r.applied ? "applied" : "NOT applied"} ${r.ratio}`) });
  await mc.close();

  // ── Seed the awkward week ──
  for (const [name, start, end] of DAY_CLASSES) {
    const id = randomUUID();
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, $4, 30)`, [id, tenantId, name, mins(end) - mins(start)]);
    for (const d of DAYS) await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), id, d, start, end]);
    seeded.push(id);
  }

  // ── T1–T3 on the week grid ──
  for (const [tag, viewport] of [["1280", { width: 1280, height: 800 }], ["768", { width: 768, height: 1024 }]]) {
    const ctx = await context(browser, `10.95.4.${tag === "1280" ? 10 : 11}`, { viewport, storageState: ownerState, timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${tag}: ${String(e).slice(0, 200)}`));
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    const grid = page.getByTestId("week-grid");
    const visible = await grid.waitFor({ timeout: 90000 }).then(() => true, () => false);
    if (!visible) { L.check(`T1@${tag}`, "the week grid is on the page", false, page.url()); await ctx.close(); continue; }
    const inv = await gridInvariants(page, { sessions: SESSIONS });
    L.check(`T1@${tag}`, `week grid: every layout rule holds for overlaps, 45 and 75 minute classes and off-the-hour starts (${SESSIONS} sessions)`, inv.problems.length === 0, inv);
    const ax = await axis(page, "week-grid");
    L.check(`T2@${tag}`, "week grid: every chip sits on a time label that reads its own start (1.5 px below, within 1), and the day headers share one top and bottom", ax.problems.length === 0, ax);
    // An empty day is drawn narrow by design (a header and a dash); what must hold is that it is there, marked, and
    // nothing of it leaves its column.
    const sunday = await page.evaluate(() => {
      const day = document.querySelector('[data-testid="week-grid"] [data-day="sun"]');
      const head = day?.querySelector("[data-day-head]");
      const mark = day?.querySelector(".pg-empty");
      const R = (el) => el.getBoundingClientRect();
      const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1;
      return {
        present: !!day, cells: day?.querySelectorAll("[data-cell-key]").length ?? null, empty: mark?.textContent?.trim() ?? null,
        width: head ? Math.round(R(head).width) : null,
        headCut: head ? head.scrollWidth > head.clientWidth + 1 : null,
        markInside: head && mark ? inside(R(mark), R(day)) : null,
      };
    });
    L.check(`T3@${tag}`, "week grid: the day with no classes keeps its column, header and empty mark, nothing spilling out of it", sunday.present && sunday.cells === 0 && !!sunday.empty && sunday.headCut === false && sunday.markInside === true, sunday);
    await shot(page, `alignment-week-${tag}`);
    await ctx.close();
  }

  // ── T1–T3 on the staff phone's day ──
  for (const width of [320, 390]) {
    const ctx = await context(browser, `10.95.4.${width === 320 ? 20 : 21}`, { viewport: { width, height: width === 320 ? 568 : 844 }, isMobile: true, hasTouch: true, storageState: ownerState, timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${width}: ${String(e).slice(0, 200)}`));
    await page.goto("/dashboard/timetable");
    await page.waitForLoadState("networkidle");
    const tab = (d) => page.getByRole("tab", { name: new RegExp(`^${d}`) });
    await tab("Mon").waitFor({ timeout: 90000 });
    for (const d of ["Mon", "Sat"]) {
      await tab(d).tap();
      await page.waitForTimeout(400);
      // Every day carries the same classes, so a tap that did not switch would measure the same day twice.
      const shownDay = await page.getByTestId("phone-day-grid").getAttribute("data-day");
      L.check(`T0@${width}`, `phone: the ${d} tab shows ${d}`, shownDay === d.toLowerCase(), { shownDay });
      const inv = await gridInvariants(page, { sessions: DAY_CLASSES.length, grid: "phone-day-grid" });
      L.check(`T1@${width}`, `phone ${d}: every layout rule holds (${DAY_CLASSES.length} sessions)`, inv.problems.length === 0, inv);
      const ax = await axis(page, "phone-day-grid");
      L.check(`T2@${width}`, `phone ${d}: every chip sits on a time label that reads its own start (1.5 px below, within 1)`, ax.problems.length === 0, ax);
      const side = await phoneNoSidewaysScroll(page);
      L.check(`T1@${width}`, `phone ${d}: nothing scrolls sideways and no chip leaves the day`, side.ok, side);
      if (d === "Mon") await shot(page, `alignment-phone-${width}`);
    }
    await tab("Sun").tap();
    await page.waitForTimeout(400);
    const sun = await page.evaluate(() => ({ grid: !!document.querySelector('[data-testid="phone-day-grid"] [data-cell-key]'), text: document.querySelector("main")?.innerText.match(/No classes[^\n]*/)?.[0] ?? null }));
    L.check(`T3@${width}`, "phone Sunday: no chips and the page says there are no classes", !sun.grid && !!sun.text, sun);
    await ctx.close();
  }
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  await q(`update "Tenant" set "timetableLayout" = $2 where id = $1`, [tenantId, startLayout]).catch(() => {});
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
  fs.writeFileSync(`${OUT}/timetable-alignment-done.txt`, L.summary());
}
