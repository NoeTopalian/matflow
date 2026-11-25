// The member's day on the CLUB's clock (synthetic club only). A London club; the member's phone a day AHEAD of it
// (Bali, UTC+8) and a day BEHIND it (Honolulu, UTC-10), at frozen instants in a GMT week and a BST week. Expected
// values are written by hand from a calendar, not from any MatFlow helper.
//   node run-journeys.mjs member-club-date
import { createRequire } from "node:module";
import { launchWithScrollbars, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("member-club-date");
const BALI = "Asia/Makassar";
const HONOLULU = "Pacific/Honolulu";

// API dayOfWeek: 0 = Sun … 6 = Sat.
const CLASSES = [
  { name: "Fundamentals", dayOfWeek: 1, start: "18:00", end: "19:00" },
  { name: "Tuesday Morning", dayOfWeek: 2, start: "07:00", end: "08:00" },
  { name: "Evening Gi", dayOfWeek: 3, start: "20:00", end: "21:00" },
  { name: "Thursday Morning", dayOfWeek: 4, start: "07:00", end: "08:00" },
  { name: "Friday Drills", dayOfWeek: 5, start: "12:30", end: "13:30" },
];
// Each case: the device zone, the frozen instant, the club's wall clock then (by hand), the day it must open on,
// and the class that must be live.
const CASES = [
  { id: "ahead-gmt", zone: BALI, at: "2026-11-25T20:30:00Z", club: "Wed 25 Nov 2026 20:30 GMT", device: "Thu 26 Nov 04:30", opens: "Wednesday", live: "Evening Gi", week: "23–29 November" },
  { id: "behind-gmt", zone: HONOLULU, at: "2026-11-26T07:30:00Z", club: "Thu 26 Nov 2026 07:30 GMT", device: "Wed 25 Nov 21:30", opens: "Thursday", live: "Thursday Morning", week: "23–29 November" },
  { id: "ahead-gmt-mar", zone: BALI, at: "2027-03-22T18:30:00Z", club: "Mon 22 Mar 2027 18:30 GMT", device: "Tue 23 Mar 02:30", opens: "Monday", live: "Fundamentals" },
  { id: "ahead-bst", zone: BALI, at: "2027-03-29T17:30:00Z", club: "Mon 29 Mar 2027 18:30 BST", device: "Tue 30 Mar 01:30", opens: "Monday", live: "Fundamentals" },
  { id: "behind-gmt-mar", zone: HONOLULU, at: "2027-03-23T07:30:00Z", club: "Tue 23 Mar 2027 07:30 GMT", device: "Mon 22 Mar 21:30", opens: "Tuesday", live: "Tuesday Morning" },
  { id: "behind-bst", zone: HONOLULU, at: "2027-03-30T06:30:00Z", club: "Tue 30 Mar 2027 07:30 BST", device: "Mon 29 Mar 20:30", opens: "Tuesday", live: "Tuesday Morning" },
];

const browser = await launchWithScrollbars();
const errors = [];
const watch = (p) => p.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 160)));
const api = (page, method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const created = [];
let failed = false;
const check = (id, expected, observed, pass, evidence = "") => { L.check(id, `${expected} → ${observed}`, pass, evidence); if (!pass) failed = true; };
async function guard(id, fn) {
  try { await fn(); } catch (e) { failed = true; L.check(id, "section ran", false, String(e.message ?? e).split("\n").slice(0, 2).join(" | ")); }
}

// Page readers.
const pills = (p) => p.locator("div.scrollbar-hide > button");
const dayLine = (p) => p.locator("p.text-gray-400.text-xs.font-medium").first();
const loaded = async (p) => {
  await expect(p.getByTestId("schedule-pane").getByTestId("schedule-day")).toBeVisible({ timeout: 30_000 });
  await expect(dayLine(p)).toHaveText(/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/, { timeout: 30_000 });
};
const states = (p) => p.getByTestId("schedule-pane").getByTestId("schedule-day").evaluate((el) =>
  Object.fromEntries([...el.querySelectorAll("[data-session-state]")].map((b) => [(b.getAttribute("aria-label") ?? "").split(",")[0], b.getAttribute("data-session-state")])));
const pillOf = (p, short, n) => pills(p).filter({ hasText: new RegExp(`${short}\\s*${n}\\b`, "i") });

try {
  await q(`update "Tenant" set timezone = 'Europe/London' where id = $1`, [club.tenantId]);
  const setup = await context(browser, "10.99.2.1", { timezoneId: "Europe/London" });
  const sp = await setup.newPage(); watch(sp);
  await ownerSignIn(sp, club);
  for (const c of CLASSES) {
    const [h1, m1] = c.start.split(":").map(Number), [h2, m2] = c.end.split(":").map(Number);
    const res = await api(sp, "POST", "/api/classes", { name: c.name, duration: h2 * 60 + m2 - (h1 * 60 + m1), schedules: [{ dayOfWeek: c.dayOfWeek, startTime: c.start, endTime: c.end }] });
    if (res.status !== 201) throw new Error(`create ${c.name}: ${res.status} ${JSON.stringify(res.body)}`);
    created.push(res.body.id);
  }
  await setup.close();
  const member = await memberLogin(club);

  for (const c of CASES) {
    await guard(c.id, async () => {
      const ctx = await context(browser, "10.99.2.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: c.zone });
      const p = await ctx.newPage(); watch(p);
      await memberSignIn(p, club, member);
      await ctx.clock.setFixedTime(new Date(c.at));
      // The first read held for 1.5 s: until it names the club's zone, no day is shown (never the phone's first).
      let held = 0;
      await p.route("**/api/member/schedule?*", async (route) => { held++; if (held === 1) await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
      const zoneHeader = p.waitForResponse((r) => r.url().includes("/api/member/schedule?date=today"), { timeout: 30_000 });
      await p.goto("/member/schedule");
      await expect(pills(p)).toHaveCount(7, { timeout: 30_000 });
      const before = ((await dayLine(p).textContent()) ?? "").trim();
      check(`${c.id} · before the read`, "no day named", before || "(blank)", !/day/.test(before));
      const res = await zoneHeader;
      check(`${c.id} · reply names the zone`, "X-Club-Zone: Europe/London", res.headers()["x-club-zone"] ?? "none", res.headers()["x-club-zone"] === "Europe/London");
      await loaded(p);
      const opened = ((await dayLine(p).textContent()) ?? "").trim();
      check(`${c.id} · opens on (club ${c.club}; device ${c.device})`, c.opens, opened, opened.startsWith(c.opens));
      const s = await states(p);
      check(`${c.id} · ${c.live} at club time`, "live", s[c.live] ?? "none", s[c.live] === "live", JSON.stringify(s));
      if (c.week) {
        const week = ((await p.locator("h1").first().textContent()) ?? "").trim();
        check(`${c.id} · week heading`, c.week, week, week === c.week);
      }
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${c.id} · phone 390 no horizontal scroll`, "0 px", `${overflow} px`, overflow <= 0);

      if (c.id === "ahead-gmt") {
        await shot(p, "member-club-date-ahead-wed");
        // The phone's today (Thursday) is tomorrow at the club: its 07:00 is neither live nor next.
        await pillOf(p, "Thu", 26).tap();
        await expect(dayLine(p)).toHaveText(/^Thursday/);
        const thu = await states(p);
        check("ahead-gmt · Thursday 07:00 (club tomorrow)", "upcoming", thu["Thursday Morning"] ?? "none", thu["Thursday Morning"] === "upcoming");
        // A day picked by hand stays; Today returns to the club's today.
        await pillOf(p, "Fri", 27).tap();
        await p.waitForTimeout(1000);
        const fri = ((await dayLine(p).textContent()) ?? "").trim();
        check("ahead-gmt · picked Friday stays", "Friday", fri, fri.startsWith("Friday"));
        await p.getByRole("button", { name: "Today", exact: true }).tap();
        await expect(dayLine(p)).toHaveText(/^Wednesday/, { timeout: 10_000 }).catch(() => {});
        const back = ((await dayLine(p).textContent()) ?? "").trim();
        check("ahead-gmt · Today button", "Wednesday (club today, not the phone's Thursday)", back, back.startsWith("Wednesday"));
        // Keyboard: Tab to the Saturday pill and press Enter.
        await pillOf(p, "Sat", 28).focus();
        await p.keyboard.press("Enter");
        await expect(dayLine(p)).toHaveText(/^Saturday/, { timeout: 10_000 }).catch(() => {});
        const sat = ((await dayLine(p).textContent()) ?? "").trim();
        check("ahead-gmt · keyboard picks Saturday", "Saturday", sat, sat.startsWith("Saturday"));
      }
      if (c.id === "behind-gmt") {
        await shot(p, "member-club-date-behind-thu");
        // The phone's today (Wednesday) is yesterday at the club: Evening Gi is not live.
        await pillOf(p, "Wed", 25).tap();
        await expect(dayLine(p)).toHaveText(/^Wednesday/);
        const wed = await states(p);
        check("behind-gmt · Wednesday Evening Gi (club yesterday)", "not live (upcoming, no state)", wed["Evening Gi"] ?? "none", wed["Evening Gi"] === "upcoming");
      }
      await ctx.close();
    });
  }
  // A failed read: the error replaces the grid, the retry sends one request and then opens on the club's day.
  await guard("failed-read", async () => {
    const ctx = await context(browser, "10.99.2.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: BALI });
    const p = await ctx.newPage(); watch(p);
    await memberSignIn(p, club, member);
    await ctx.clock.setFixedTime(new Date(CASES[0].at));
    let n = 0;
    await p.route("**/api/member/schedule?*", (route) => { n++; return n === 1 ? route.fulfill({ status: 500, body: "{}" }) : route.continue(); });
    await p.goto("/member/schedule");
    await expect(p.getByRole("button", { name: /Try again/ })).toBeVisible({ timeout: 30_000 });
    await p.getByRole("button", { name: /Try again/ }).tap();
    await loaded(p);
    const opened = ((await dayLine(p).textContent()) ?? "").trim();
    check("failed-read · retry", "one more request, then opens on Wednesday", `${n - 1} more; opens on ${opened}`, n === 2 && opened.startsWith("Wednesday"));
    await ctx.close();
  });
  const hydration = errors.filter((e) => /#418|#425|#423|hydrat/i.test(e));
  const other = errors.filter((e) => !hydration.includes(e));
  if (hydration.length) L.note("hydration", "expected with a frozen browser clock and a server on the real clock", hydration.length);
  check("errors", "no other uncaught page errors", other.length ? other.slice(0, 3).join(" | ") : "none", other.length === 0);
} catch (e) {
  failed = true;
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
} finally {
  if (created.length) await q(`update "Class" set "deletedAt" = now() where "tenantId" = $1 and id = any($2::text[])`, [club.tenantId, created]).catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exitCode = failed ? 1 : 0;
}
