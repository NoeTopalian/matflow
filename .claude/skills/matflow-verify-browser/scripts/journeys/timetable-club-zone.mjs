// Round 6: the staff timetable's "today" is the club's day, in a browser in another zone (synthetic data only).
//   node run-journeys.mjs timetable-club-zone
// The browser runs in Bali (Asia/Makassar, UTC+8). The fixture club's zone is set, for this run only, to one whose
// calendar date differs from Bali's right now: Pacific/Kiritimati (UTC+14) from 10:00 to 16:00 UTC, else
// Pacific/Pago_Pago (UTC-11). The server's clock cannot be frozen, so the zone is chosen from the real time; the
// frozen-clock cases (club midnight, London's clock change) are unit tests (tests/unit/timetable-club-zone.test.tsx).
// Checks: the Today marker and the week shown are the club's; the club's cancellation for today lands on the club's
// day; Monday/Tuesday sessions and an overnight session sit on their own days; next / previous / Today move by the
// club's week, by keyboard too; the phone's day picker agrees; no hydration error. The club's zone is put back after.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-club-zone");
const errors = [];
const BROWSER_ZONE = "Asia/Makassar";
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A zone's calendar date and weekday at an instant. */
function wall(at, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: DAYS.indexOf(p.weekday) };
}
const ymd = (w) => `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
/** "9 Nov – 15 Nov" for the week (Monday first) holding a calendar date, `offset` weeks on. */
function weekLabel(w, offset = 0) {
  const monday = new Date(Date.UTC(w.y, w.m - 1, w.d - ((w.dow + 6) % 7) + offset * 7));
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const f = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(monday)} – ${f(sunday)}`;
}

async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) await shot(main, `timetable-club-zone-fail-${id}`);
  }
}

const h = new Date().getUTCHours();
const CLUB_ZONE = h >= 10 && h < 16 ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
const [{ timezone: originalZone }] = await q(`select "timezone" from "Tenant" where "id" = $1`, [club.id]);
const created = [];
const browser = await chromium.launch();
let main;
try {
  await q(`update "Tenant" set "timezone" = $1 where "id" = $2`, [CLUB_ZONE, club.id]);
  const now = new Date();
  const clubDay = wall(now, CLUB_ZONE);
  const baliDay = wall(now, BROWSER_ZONE);
  L.note("setup", "zones", { clubZone: CLUB_ZONE, clubDay: ymd(clubDay), baliDay: ymd(baliDay), utc: now.toISOString() });
  if (ymd(clubDay) === ymd(baliDay)) throw new Error("club and browser are on the same date: the zone choice is wrong for this hour");
  // Within ten minutes of a zone's midnight the two dates may move under the run: start again later.
  const minutesToMidnight = (z) => { const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now); const hh = Number(p.find((x) => x.type === "hour").value), mm = Number(p.find((x) => x.type === "minute").value); return 1440 - (hh * 60 + mm); };
  if (Math.min(minutesToMidnight(CLUB_ZONE), minutesToMidnight(BROWSER_ZONE)) < 10) throw new Error("within ten minutes of a midnight: run again in a quarter of an hour");

  const ctx = await context(browser, "10.94.6.1", { timezoneId: BROWSER_ZONE });
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  await main.goto("/dashboard/timetable");
  await main.getByRole("button", { name: "Next week" }).waitFor();

  // Through the real routes, from the signed-in page: a class on the club's day AND the browser's day at the same
  // time; Sean's Monday/Tuesday shape; an overnight session on the club's day.
  const api = (path, method, body) => main.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [path, method, body]);
  const make = async (name, schedules) => {
    const r = await api("/api/classes", "POST", { name, duration: 60, schedules });
    if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    created.push(r.body.id);
    return r.body;
  };
  const both = await make("Zone Evening", [{ dayOfWeek: clubDay.dow, startTime: "23:15", endTime: "23:45" }, { dayOfWeek: baliDay.dow, startTime: "23:15", endTime: "23:45" }]);
  await make("Zone Beginners Gi", [{ dayOfWeek: 1, startTime: "18:40", endTime: "19:30" }, { dayOfWeek: 2, startTime: "17:50", endTime: "18:40" }]);
  await make("Zone Late Mat", [{ dayOfWeek: clubDay.dow, startTime: "23:30", endTime: "01:00" }]);
  // The club's today, as the register sees it: its sessions exist once /api/coach/today is read. Cancel Zone Evening's.
  const today = await api("/api/coach/today", "GET");
  const inst = (today.body ?? []).find((s) => s.classId === both.id);
  if (!inst) throw new Error(`no session of Zone Evening in the club's today (${today.status})`);
  const cancel = await api(`/api/classes/${both.id}/instances/${inst.id}`, "PATCH", { isCancelled: true, cancellationReason: "Synthetic: coach away" });
  if (cancel.status !== 200) throw new Error(`cancel: ${cancel.status}`);

  await main.reload();
  const grid = main.getByTestId("week-grid");
  const todayHead = () => grid.locator('[aria-label$=", today"], [aria-label*=", today,"]');

  await section("today", "the Today marker and the week shown are the club's, not the browser's", async () => {
    await expect(main.getByText(weekLabel(clubDay), { exact: true })).toBeVisible();
    await expect(todayHead()).toHaveCount(1);
    const label = await todayHead().getAttribute("aria-label");
    expect(label.startsWith(`${DAYS_FULL[clubDay.dow]} ${clubDay.d} `)).toBe(true);
    return { weekLabel: weekLabel(clubDay), todayLabel: label };
  });

  await section("cancelled", "the club's cancellation lands on the club's day; the same class on the browser's day carries no state", async () => {
    const chip = (dow) => grid.getByRole("button", { name: new RegExp(`^Edit Zone Evening, ${DAYS_FULL[dow]} 23:15 to `) });
    await expect(chip(clubDay.dow)).toHaveAttribute("data-session-state", "cancelled");
    expect(await chip(baliDay.dow).getAttribute("data-session-state")).toBeNull();
    return { clubDay: DAYS_FULL[clubDay.dow], browserDay: DAYS_FULL[baliDay.dow] };
  });

  await section("placement", "Monday/Tuesday sessions sit on Monday and Tuesday; the overnight session on its start day", async () => {
    await expect(grid.getByRole("button", { name: /^Edit Zone Beginners Gi, Monday 18:40 to 19:30/ })).toHaveCount(1);
    await expect(grid.getByRole("button", { name: /^Edit Zone Beginners Gi, Tuesday 17:50 to 18:40/ })).toHaveCount(1);
    await expect(grid.getByRole("button", { name: new RegExp(`^Edit Zone Late Mat, ${DAYS_FULL[clubDay.dow]} 23:30 to 01:00`) })).toHaveCount(1);
    return "Mon 18:40, Tue 17:50, overnight on its start day";
  });

  await section("weeks", "next, previous and Today move by the club's week, by keyboard", async () => {
    await main.getByRole("button", { name: "Next week" }).focus();
    await main.keyboard.press("Enter");
    await expect(main.getByText(weekLabel(clubDay, 1), { exact: true })).toBeVisible();
    await expect(todayHead()).toHaveCount(0);
    await expect(grid.getByRole("button", { name: /^Edit Zone Beginners Gi, Monday 18:40 to/ })).toHaveCount(1);
    await main.getByRole("button", { name: "Previous week" }).focus();
    await main.keyboard.press("Enter");
    await main.keyboard.press("Enter");
    await expect(main.getByText(weekLabel(clubDay, -1), { exact: true })).toBeVisible();
    const back = main.getByRole("button", { name: "Today", exact: true });
    await back.focus();
    await main.keyboard.press("Enter");
    await expect(main.getByText(weekLabel(clubDay), { exact: true })).toBeVisible();
    await expect(todayHead()).toHaveCount(1);
    return { next: weekLabel(clubDay, 1), previous: weekLabel(clubDay, -1) };
  });
  await shot(main, "timetable-club-zone-desktop");

  await section("phone", "375 x 812 in Bali: the day picker marks the club's today and opens on it", async () => {
    const mobile = await context(browser, "10.94.6.2", { viewport: { width: 375, height: 812 }, isMobile: true, timezoneId: BROWSER_ZONE, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/timetable");
      const tab = phone.locator('[role="tab"][data-today]');
      await expect(tab).toHaveCount(1);
      const label = await tab.getAttribute("aria-label");
      expect(label.startsWith(`${DAYS_FULL[clubDay.dow]} ${clubDay.d}, today`)).toBe(true);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await shot(phone, "timetable-club-zone-phone");
      return { tab: label };
    } finally {
      await mobile.close();
    }
  });

  L.check("errors", "no uncaught browser errors (no hydration mismatch between the server's and the browser's today)", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "timetable-club-zone-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  // Leave the fixture as found: the club's zone back, this run's classes gone (synthetic rows only).
  await q(`update "Tenant" set "timezone" = $1 where "id" = $2`, [originalZone, club.id]);
  for (const id of created) {
    await q(`delete from "ClassInstance" where "classId" = $1`, [id]);
    await q(`delete from "ClassSchedule" where "classId" = $1`, [id]);
    await q(`delete from "Class" where "id" = $1`, [id]);
  }
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
