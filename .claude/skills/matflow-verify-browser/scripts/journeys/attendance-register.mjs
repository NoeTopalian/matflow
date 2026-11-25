// Journey: the staff "Mark attendance" page (25 Nov 2026 redesign) on a synthetic club.
// One selected-class card, Change class (popover on a wide window, sheet on a phone), By name / Scan QR, Session
// details, the kiosk last. The checks that matter most compare the DATABASE with what the screen said:
//   A  auto-selection from the club's clock: on now, two classes on now, mat order, the coach's own class;
//   G  layout at 390x844, 320x568, 768, 1280 and 200% zoom: card and both methods in view, no sideways page scroll;
//   P  the picker by touch and by keyboard: order, the last session reachable, one switch, focus back;
//   M  PRIMARY: pick the last session, mark by name at once: the record is in that session and no other;
//   S  Scan QR: a card "seen" while the picker is open, and across a class switch, is not sent; one scan after
//      the switch goes into the new class once. The camera is SIMULATED (fake detector and stream);
//   R  an out-of-order register answer and a failed register load never show one class's rows under another;
//   W  a mark made by name and answered after the coach switched class is announced with the first class's name;
//   Q  (owner, Scan QR) a card held while the picker or the cancel confirmation is open is never sent; after
//      dismissal one hold records once into the class on screen. SIMULATED camera;
//   N  the club's midnight passes under an open page with no focus event (Playwright's page clock): the next mark
//      or card read writes nothing and the dated Reload notice shows, the class unchanged;
//   X  390 wide: the bottom navigation's More menu and the class picker never stack, and focus comes back;
//   D  dismissing the picker (Close, Escape, outside tap) changes nothing, returns focus, and the next tap works;
//   C  cancel and kiosk for the owner; neither for a coach; the bottom navigation never covers the last control.
//   node journeys/attendance-register.mjs            (the redesign)
//   node journeys/attendance-register.mjs --before   (seed the same data and take the "before" pictures only)
import { createHmac, randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, noSidewaysScroll } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const BEFORE = process.argv.includes("--before");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger(BEFORE ? "attendance-register-before" : "attendance-register");
const t = club.tenantId;
const errors = [];
let stage = "start";
let lastPage = null;

// ── The club's day and clock ────────────────────────────────────────────────
// The day needs room either side of now, so this synthetic club is put on a zone where it is daytime at this moment
// (and back on its own afterwards). The phones below are then set to a DIFFERENT zone, so nothing passes by reading
// the phone's clock.
const startTz = (await q(`select timezone from "Tenant" where id = $1`, [t]))[0]?.timezone ?? null;
const hourIn = (zone) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const tz = ["Europe/London", "Asia/Makassar", "America/Los_Angeles", "America/New_York", "Asia/Dubai", "Pacific/Auckland", "Asia/Tokyo"].find((z) => hourIn(z) >= 6 && hourIn(z) <= 15);
if (!tz) throw new Error("no candidate zone is in its daytime");
const PHONE_TZ = tz === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";
await q(`update "Tenant" set timezone = $2 where id = $1`, [t, tz]);
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayMarker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(new Date());
const startNow = Math.floor((nowMin - 30) / 5) * 5; // started about half an hour ago

const LONG = "Women's Only Fundamentals and Self-Defence Foundations (Beginners Welcome)";
// name, start, end, mat ("1" | "2" | null)
const DAY = [
  ["Reg Early Drilling", startNow - 120, startNow - 60, "1"],
  ["Reg Fundamentals", startNow, startNow + 90, "1"],
  ["Reg No-Gi Advanced", startNow, startNow + 90, "2"],
  [LONG, startNow + 90, startNow + 150, "1"],
  ["Reg Kids Tigers", startNow + 90, startNow + 150, "2"],
  ["Reg Sparring", startNow + 150, startNow + 180, "1"],
  ["Reg Wrestling", startNow + 150, startNow + 180, null],
  ["Reg Evening Gi", startNow + 180, startNow + 210, "2"],
  ["Reg Late Open Mat", startNow + 210, startNow + 235, "2"],
];
const NAMES = DAY.map((d) => d[0]);
const LAST = "Reg Late Open Mat";

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [t, NAMES]);
  for (const { id } of rows) {
    await q(`delete from "AttendanceRecord" where "classInstanceId" in (select id from "ClassInstance" where "classId" = $1)`, [id]).catch(() => {});
    for (const tb of ["ClassSubscription", "ClassSchedule", "ClassInstance"]) await q(`delete from "${tb}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, t]).catch(() => {});
  }
  await q(`delete from "Mat" where "tenantId" = $1 and name = any($2)`, [t, ["Reg Mat 1", "Reg Mat 2"]]).catch(() => {});
}
await cleanup();

const mats = { "1": randomUUID(), "2": randomUUID() };
// The club's order puts "Reg Mat 2" SECOND although it is created first: order, not creation or name, decides.
await q(`insert into "Mat" (id, "tenantId", name, "nameKey", "sortOrder", "updatedAt") values ($1, $2, 'Reg Mat 2', 'reg mat 2', 1, now()), ($3, $2, 'Reg Mat 1', 'reg mat 1', 0, now())`, [mats["2"], t, mats["1"]]);
const inst = {};
const cls = {};
for (const [name, start, end, mat] of DAY) {
  const c = randomUUID(); const i = randomUUID();
  cls[name] = c; inst[name] = i;
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "matId", location) values ($1, $2, $3, $4, 30, $5, $6)`, [c, t, name, end - start, mat ? mats[mat] : null, mat ? `Reg Mat ${mat}` : null]);
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [i, c, todayMarker, hm(start), hm(end)]);
}
const members = await q(`select id, name, "cardVersion" from "Member" where "tenantId" = $1 and name = any($2) order by name`, [t, ["Member 1", "Member 2"]]);
const [m1, m2] = members;
if (!m1 || !m2) throw new Error("fixture has no Member 1 and Member 2");
await q(`update "Member" set "waiverAccepted" = true where "tenantId" = $1 and id = any($2)`, [t, [m1.id, m2.id]]);
// Member 1 is booked into Fundamentals; Member 2 is the walk-in.
await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), m1.id, cls["Reg Fundamentals"]]);

const attendance = async () => {
  const rows = await q(`select c.name, a."memberId" from "AttendanceRecord" a join "ClassInstance" i on i.id = a."classInstanceId" join "Class" c on c.id = i."classId" where a."tenantId" = $1 and c.name = any($2) order by c.name`, [t, NAMES]);
  return rows.map((r) => `${r.name}:${r.memberId === m1.id ? "Member 1" : r.memberId === m2.id ? "Member 2" : r.memberId}`);
};

function signCardToken(args) {
  const env = testEnv();
  const secret = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
  if (!secret) throw new Error("no AUTH secret in .env.test");
  const key = createHmac("sha256", secret).update("matflow.card.v1").digest();
  const keyId = createHmac("sha256", key).update("matflow.card.keyid").digest().toString("base64url").slice(0, 6);
  const body = Buffer.from(JSON.stringify({ ...args, purpose: "card", keyId, exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

const VIEW = {
  "390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  "320": { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true },
  "768": { viewport: { width: 768, height: 1024 }, hasTouch: true },
  "1280": { viewport: { width: 1280, height: 800 } },
  // 200% zoom on a 1280 x 800 desktop is a 640 x 400 layout.
  "200%": { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
};
const card = (page) => page.getByTestId("selected-class");
const selectedName = (page) => page.getByTestId("selected-class-name").innerText();
const picker = (page) => page.getByRole("dialog", { name: "Change class" });
const ready = async (page) => { await page.goto("/dashboard/checkin"); await card(page).waitFor({ timeout: 60000 }); await page.waitForLoadState("networkidle").catch(() => {}); };
const inViewport = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vh: innerHeight, vw: innerWidth, inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });

const browser = await chromium.launch();
try {
  const oc = await context(browser, "10.96.1.1", { ...VIEW["1280"], timezoneId: PHONE_TZ });
  const op = await oc.newPage();
  await ownerSignIn(op, club);
  const owner = await oc.storageState();
  await oc.close();
  const open = async (tag, lane, extra = {}) => {
    const ctx = await context(browser, `10.96.1.${lane}`, { ...VIEW[tag], storageState: owner, timezoneId: PHONE_TZ, ...extra });
    const page = await ctx.newPage();
    lastPage = page;
    page.on("pageerror", (e) => errors.push(`${tag}: ${String(e).slice(0, 200)}`));
    return { ctx, page, touch: !!VIEW[tag].hasTouch };
  };

  if (BEFORE) {
    for (const [tag, lane] of [["1280", 2], ["390", 3]]) {
      const { ctx, page } = await open(tag, lane);
      await page.goto("/dashboard/checkin");
      await page.getByRole("heading", { name: "Mark attendance" }).waitFor({ timeout: 60000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);
      await shot(page, `attendance-before-${tag}`);
      L.note("before", `picture taken at ${tag}`, { url: new URL(page.url()).pathname });
      await ctx.close();
    }
  } else {
    // ── A: what opens, and why ──
    {
      const { ctx, page } = await open("1280", 2);
      await ready(page);
      const a = { name: await selectedName(page), label: await page.getByTestId("selected-class-label").innerText(), when: await page.getByTestId("selected-class-when").innerText(), onNow: await page.getByTestId("classes-on-now").innerText().catch(() => null) };
      L.check("A", "opens on the class on now, first in the club's mat order, with its time and mat, and says two are on now",
        a.name === "Reg Fundamentals" && /on now/i.test(a.label) && a.when === `${hm(startNow)}–${hm(startNow + 90)} · Reg Mat 1` && a.onNow === "2 classes on now", a);
      const tabs = await page.getByRole("tab").evaluateAll((els) => els.map((e) => ({ text: e.innerText.trim(), selected: e.getAttribute("aria-selected"), disabled: e.disabled, y: Math.round(e.getBoundingClientRect().top), w: Math.round(e.getBoundingClientRect().width) })));
      L.check("A", "By name and Scan QR sit side by side at the same size, one selected, neither disabled", tabs.length === 2 && tabs[0].text === "By name" && tabs[1].text === "Scan QR" && tabs[0].y === tabs[1].y && Math.abs(tabs[0].w - tabs[1].w) <= 1 && tabs[0].selected === "true" && tabs[1].selected === "false" && !tabs.some((x) => x.disabled), tabs);
      await shot(page, "attendance-after-1280");
      await ctx.close();
    }
    // The coach who teaches the Mat 2 class opens on it; a phone in another time zone still shows the club's day.
    {
      const coach = await seedStaff(club, "coach", { name: "Casey Coach" });
      await q(`update "Class" set "coachUserId" = $1 where id = $2`, [coach.id, cls["Reg No-Gi Advanced"]]);
      const cc = await context(browser, "10.96.1.9", { ...VIEW["390"], timezoneId: PHONE_TZ });
      const cp = await cc.newPage();
      cp.on("pageerror", (e) => errors.push(`coach: ${String(e).slice(0, 200)}`));
      await staffSignIn(cp, club, coach);
      await ready(cp);
      const name = await selectedName(cp);
      const cardText = await card(cp).innerText();
      L.check("A", "a coach opens on the class they teach when two are on now, tagged Yours (phone set to another time zone)", name === "Reg No-Gi Advanced" && /yours/i.test(cardText) && /on now/i.test(cardText), { name, cardText: cardText.replace(/\s+/g, " ") });
      await cp.getByRole("button", { name: "Change class" }).tap();
      const day = await picker(cp).innerText();
      L.check("A", "the picker names the club's date, not the phone's", day.includes(dateLabel), { dateLabel, has: day.includes(dateLabel), clubZone: tz, phoneZone: PHONE_TZ });
      await cp.keyboard.press("Escape");
      // C (coach): no cancel, no kiosk control.
      await cp.getByRole("button", { name: /Session details/ }).tap();
      const coachCancel = await cp.getByRole("button", { name: "Cancel this session" }).count();
      const coachKiosk = await cp.getByRole("button", { name: "Open kiosk" }).count();
      L.check("C", "a coach is offered neither Cancel this session nor Open kiosk", coachCancel === 0 && coachKiosk === 0, { coachCancel, coachKiosk });
      await cc.close();
      await q(`update "Class" set "coachUserId" = null where id = $1`, [cls["Reg No-Gi Advanced"]]);
    }

    // ── G: layout at every width ──
    for (const [tag, lane] of [["390", 3], ["320", 4], ["768", 5], ["1280", 6], ["200%", 7]]) {
      const { ctx, page } = await open(tag, lane);
      await ready(page);
      const c = await inViewport(card(page));
      const tabs = await inViewport(page.getByRole("tablist"));
      const side = await noSidewaysScroll(page);
      // On the two phones and the desktop the card and both methods are in view with no scrolling.
      const needFold = tag === "390" || tag === "1280" || tag === "768";
      L.check(`G@${tag}`, `${needFold ? "the selected class and both methods are in view without scrolling; " : ""}nothing scrolls the page sideways`, (!needFold || (c.inside && tabs.inside)) && !side.mainScrolls && !side.documentScrolls && c.right <= c.vw && tabs.right <= tabs.vw, { card: c, methods: tabs, side });
      if (tag === "320" || tag === "200%") {
        await page.getByRole("tablist").scrollIntoViewIfNeeded();
        const reach = await inViewport(page.getByRole("tablist"));
        L.check(`G@${tag}`, "both methods can be brought fully into view", reach.inside, reach);
      }
      if (tag === "390") await shot(page, "attendance-after-390");
      await ctx.close();
    }

    // ── P + M: the picker by touch on a phone, then the primary acceptance ──
    {
      const { ctx, page } = await open("390", 10);
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).waitFor();
      await page.waitForTimeout(500);
      const rows = picker(page).locator("[data-session-id]");
      const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-session-id")));
      const want = DAY.slice().sort((a, b) => a[1] - b[1] || (a[3] ?? "9").localeCompare(b[3] ?? "9") || a[0].localeCompare(b[0])).map((d) => inst[d[0]]);
      const current = await rows.evaluateAll((els) => els.filter((e) => e.getAttribute("aria-current") === "true").map((e) => e.innerText.replace(/\s+/g, " ")));
      L.check("P@390", "sheet: every session of the day, by start time then the club's mat order, the selected one ticked in place", JSON.stringify(order) === JSON.stringify(want) && current.length === 1 && current[0].includes("Reg Fundamentals"), { order: order.length, sameOrder: JSON.stringify(order) === JSON.stringify(want), current });
      const close = await inViewport(picker(page).getByRole("button", { name: "Close" }));
      const longRow = await rows.filter({ hasText: "Women's Only" }).evaluate((e) => ({ scrollW: e.scrollWidth, clientW: e.clientWidth, h: Math.round(e.getBoundingClientRect().height) }));
      await shot(page, "attendance-picker-390");
      const last = rows.last();
      await last.scrollIntoViewIfNeeded();
      const lastBox = await inViewport(last);
      L.check("P@390", "sheet: Close stays in view, the long name wraps, and the last session scrolls fully into view", close.inside && longRow.scrollW <= longRow.clientW + 1 && longRow.h > 56 && lastBox.inside, { close, longRow, lastBox });
      stage = "M: tap the last session";
      await last.tap();
      await picker(page).waitFor({ state: "detached" });
      const after = await selectedName(page);
      stage = "M: wait for Find a member";
      // PRIMARY: straight away, mark the walk-in by name.
      const search = page.getByLabel("Find a member");
      await search.waitFor({ timeout: 30000 });
      stage = "M: type the name";
      await search.fill("Member 2");
      await page.getByRole("button", { name: /Member 2/ }).first().waitFor({ timeout: 30000 });
      stage = "M: Enter, then wait for the row to show checked in";
      await search.press("Enter");
      await page.getByRole("button", { name: "Mark Member 2 absent" }).waitFor({ timeout: 30000 });
      const stored = await attendance();
      const count = await page.getByTestId("checked-in-count").innerText();
      L.check("M", "PRIMARY: after choosing the last session, the member marked by name is stored in that session and in no other", after === LAST && JSON.stringify(stored) === JSON.stringify([`${LAST}:Member 2`]) && /1 checked in/.test(count), { selected: after, stored, count });
      // Already checked in: the row shows it; a second Enter on the same name finds nobody left to add.
      await search.fill("Member 2");
      await page.waitForTimeout(600);
      const again = await page.getByRole("list", { name: "Members matching your search" }).innerText().catch(() => "");
      L.check("M", "already checked in: not offered again from the search", /No one matches/.test(again) && (await attendance()).length === 1, { again });
      await search.fill("");

      // ── D: dismissing changes nothing ──
      const mainTop = () => page.evaluate(() => document.querySelector("main")?.scrollTop ?? 0);
      const dismiss = async (how) => {
        const top = await mainTop();
        await page.getByRole("button", { name: "Change class" }).tap();
        await picker(page).waitFor();
        await page.waitForTimeout(400);
        if (how === "close") await picker(page).getByRole("button", { name: "Close" }).tap();
        else if (how === "escape") await page.keyboard.press("Escape");
        else await page.touchscreen.tap(195, 12); // the scrim, above the sheet, over the page header
        await picker(page).waitFor({ state: "detached" });
        await page.waitForTimeout(300);
        const focus = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
        return { how, selected: await selectedName(page), focus, scrollMoved: Math.abs((await mainTop()) - top), url: new URL(page.url()).pathname };
      };
      const d = [await dismiss("close"), await dismiss("escape"), await dismiss("outside")];
      // The next tap works: nothing invisible is left over the page.
      await page.getByRole("tab", { name: "Scan QR" }).tap();
      const scanOn = await page.getByRole("tab", { name: "Scan QR" }).getAttribute("aria-selected");
      await page.getByRole("tab", { name: "By name" }).tap();
      L.check("D@390", "Close, Escape and a tap outside each close the sheet, keep the class, return focus to Change class, do not scroll or navigate; the next tap works",
        d.every((x) => x.selected === LAST && x.focus === "Change class" && x.scrollMoved <= 1 && x.url === "/dashboard/checkin") && scanOn === "true" && (await attendance()).length === 1, { d, scanOn });

      // ── C: the bottom navigation never covers the last control ──
      const kiosk = page.getByTestId("kiosk-section");
      await kiosk.evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(400);
      const clear = await page.evaluate(() => {
        const navs = [...document.querySelectorAll("nav, div")].filter((el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.position === "fixed" && r.bottom >= innerHeight - 1 && r.height > 30 && r.height < 140 && r.width >= innerWidth - 2 && s.visibility !== "hidden"; });
        const navTop = Math.min(innerHeight, ...navs.map((n) => n.getBoundingClientRect().top));
        const k = document.querySelector('[data-testid="kiosk-section"]').getBoundingClientRect();
        const btn = [...document.querySelectorAll('[data-testid="kiosk-section"] button')].pop()?.getBoundingClientRect();
        return { navTop: Math.round(navTop), kioskBottom: Math.round(k.bottom), lastButtonBottom: btn ? Math.round(btn.bottom) : null };
      });
      L.check("C@390", "scrolled to the end, the kiosk section and its action sit above the fixed bottom navigation", clear.kioskBottom <= clear.navTop + 1 && (clear.lastButtonBottom ?? 0) <= clear.navTop + 1, clear);
      await ctx.close();
    }

    // ── P at 320 x 568: the short phone ──
    {
      const { ctx, page } = await open("320", 11);
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).waitFor();
      await page.waitForTimeout(500);
      const close = await inViewport(picker(page).getByRole("button", { name: "Close" }));
      const last = picker(page).locator("[data-session-id]").last();
      await last.scrollIntoViewIfNeeded();
      const lastBox = await inViewport(last);
      const side = await noSidewaysScroll(page);
      L.check("P@320", "320 x 568: Close in view, the last session reachable, nothing sideways", close.inside && lastBox.inside && !side.mainScrolls && !side.documentScrolls, { close, lastBox, side });
      await page.keyboard.press("Escape");
      await ctx.close();
    }

    // ── P: keyboard on the desktop (popover) ──
    {
      const { ctx, page } = await open("1280", 12);
      await ready(page);
      const trigger = page.getByRole("button", { name: "Change class" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await picker(page).waitFor();
      const pop = await page.locator('[data-slot="popover"]').count();
      const box = await inViewport(picker(page));
      await shot(page, "attendance-picker-1280");
      // Focus starts on the selected row; Tab walks to the last session.
      const startFocus = await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"));
      let guard = 0;
      while ((await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"))) !== inst[LAST] && guard++ < 30) await page.keyboard.press("Tab");
      const onLast = (await page.evaluate(() => document.activeElement?.getAttribute("data-session-id"))) === inst[LAST];
      const lastVisible = await inViewport(page.locator(`[data-session-id="${inst[LAST]}"]`));
      // Tab from the last row loops inside the popover (to Close), never out to the page.
      await page.keyboard.press("Tab");
      const looped = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Enter");
      await picker(page).waitFor({ state: "detached" });
      const focus = await page.evaluate(() => document.activeElement?.textContent?.trim());
      L.check("P@1280", "keyboard: Enter opens a popover inside the window with focus on the selected row; Tab reaches the last session and stays inside; Enter selects it once, closes, and focus returns to Change class",
        pop === 1 && box.inside && startFocus === inst["Reg Fundamentals"] && onLast && lastVisible.top >= box.top && lastVisible.bottom <= box.bottom + 1 && looped && (await selectedName(page)) === LAST && focus === "Change class", { pop, box, startFocus: startFocus === inst["Reg Fundamentals"], onLast, lastVisible, looped, focus });
      // D on the desktop: a click outside closes it and does not press what is underneath (the Scan QR tab).
      stage = "D@1280";
      await page.getByRole("tab", { name: "Scan QR" }).click();
      await trigger.click();
      await picker(page).waitFor();
      // The By name tab is under the dismissing layer and clear of the popover itself: a press that got through would select it.
      const tab = await page.getByRole("tab", { name: "By name" }).boundingBox();
      const panel = await page.locator('[data-slot="popover"]').boundingBox();
      const point = { x: tab.x + 40, y: tab.y + tab.height / 2 };
      const outside = point.x < panel.x || point.x > panel.x + panel.width || point.y < panel.y || point.y > panel.y + panel.height;
      await page.mouse.click(point.x, point.y);
      await picker(page).waitFor({ state: "detached" });
      const stillScan = await page.getByRole("tab", { name: "Scan QR" }).getAttribute("aria-selected");
      const kept = await selectedName(page);
      await page.getByRole("tab", { name: "By name" }).click();
      const nowByName = await page.getByRole("tab", { name: "By name" }).getAttribute("aria-selected");
      L.check("D@1280", "a click outside the popover closes it without pressing the control underneath; the class is kept and the next click works", outside && stillScan === "true" && nowByName === "true" && kept === LAST, { outside, stillScan, nowByName, kept });
      await ctx.close();
    }

    // ── P at 200% zoom: no room for a popover, so the sheet ──
    {
      const { ctx, page } = await open("200%", 13);
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).waitFor();
      await page.waitForTimeout(400);
      const pop = await page.locator('[data-slot="popover"]').count();
      const close = await inViewport(picker(page).getByRole("button", { name: "Close" }));
      const last = picker(page).locator("[data-session-id]").last();
      await last.scrollIntoViewIfNeeded();
      L.check("P@200%", "200% zoom: the sheet is used, Close is in view and the last session is reachable", pop === 0 && close.inside && (await inViewport(last)).inside, { pop, close });
      await page.keyboard.press("Escape");
      await ctx.close();
    }

    // ── R: answers out of order, and a failed load ──
    {
      stage = "R";
      const { ctx, page } = await open("1280", 14);
      // The Fundamentals register (Member 1 is booked into it) answers four seconds late.
      await page.route(`**/api/coach/instances/${inst["Reg Fundamentals"]}/register`, async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue().catch(() => {}); });
      let failB = true;
      await page.route(`**/api/coach/instances/${inst["Reg No-Gi Advanced"]}/register`, (route) => (failB ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The register could not be read." }) }) : route.continue()));
      await page.goto("/dashboard/checkin");
      await card(page).waitFor({ timeout: 60000 });
      // Straight to Kids Tigers while Fundamentals is still loading.
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).locator(`[data-session-id="${inst["Reg Kids Tigers"]}"]`).click();
      await page.getByText("No bookings yet. Search above to check someone in.").waitFor({ timeout: 30000 });
      await page.waitForTimeout(5000); // the late Fundamentals answer has arrived by now
      const r1 = { name: await selectedName(page), member1Row: await page.getByRole("button", { name: /Mark Member 1/ }).count(), empty: await page.getByText("No bookings yet. Search above to check someone in.").count(), count: await page.getByTestId("checked-in-count").innerText() };
      L.check("R", "a register that answers late for the class left behind does not appear under the new class (heading, rows and count all the new class's)", r1.name === "Reg Kids Tigers" && r1.member1Row === 0 && r1.empty === 1 && /^0 checked in/.test(r1.count), r1);
      // Now a class whose register fails to load.
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).locator(`[data-session-id="${inst["Reg No-Gi Advanced"]}"]`).click();
      await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 30000 });
      const r2 = { name: await selectedName(page), search: await page.getByLabel("Find a member").count(), marks: await page.getByRole("button", { name: /^Mark .* (attended|absent)$/ }).count(), empty: await page.getByText(/No bookings yet/).count(), count: (await page.getByTestId("checked-in-count").innerText()).trim() };
      L.check("R", "a failed register load: the new class's name, Try again, and no search, rows, count or 'no bookings' from anywhere", r2.name === "Reg No-Gi Advanced" && r2.search === 0 && r2.marks === 0 && r2.empty === 0 && r2.count === "", r2);
      failB = false;
      // From here the register request reaches the real server. The test branch's connection can drop mid-request
      // ("Connection terminated unexpectedly" in the server log, answered 500): that is the database link, not this
      // screen, so the coach's own remedy is used once more, and the drop is recorded. The check below still needs
      // Try again to load the register.
      for (let attempt = 1; ; attempt++) {
        const retried = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(`/instances/${inst["Reg No-Gi Advanced"]}/register`), { timeout: 60000 });
        await page.getByRole("button", { name: "Try again" }).click();
        const answer = await retried;
        if (answer.status() === 200) break;
        L.note("R", "the retried register request did not answer 200 (the real server answered; see the server log)", { attempt, status: answer.status(), body: (await answer.text().catch(() => "")).slice(0, 200) });
        if (answer.status() < 500 || attempt >= 2) break;
        await page.getByRole("button", { name: "Try again" }).waitFor({ timeout: 30000 });
      }
      await page.getByLabel("Find a member").waitFor({ timeout: 30000 });
      L.check("R", "Try again loads that class's register", (await selectedName(page)) === "Reg No-Gi Advanced" && (await page.getByText(/No bookings yet/).count()) === 1, {});
      await ctx.close();
    }

    // ── S: Scan QR across a class switch (SIMULATED camera) ──
    {
      const token = signCardToken({ tenantId: t, memberId: m1.id, cardVersion: m1.cardVersion });
      const { ctx, page } = await open("390", 15);
      await ctx.addInitScript((tok) => {
        window.__mfCard = false; // true = the card is under the lens
        class FakeBarcodeDetector {
          static async getSupportedFormats() { return ["qr_code"]; }
          async detect() { return window.__mfCard ? [{ rawValue: tok, format: "qr_code" }] : []; }
        }
        window.BarcodeDetector = FakeBarcodeDetector;
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 480;
        const g = canvas.getContext("2d");
        setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`; g.fillRect(0, 0, 640, 480); }, 50);
        if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
        navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(15);
      }, token);
      const posts = [];
      // The scanner's requests only: the journey's own warm-up request below (token "warm-up") is not a scan.
      page.on("request", (r) => {
        if (r.method() !== "POST" || new URL(r.url()).pathname !== "/api/checkin/card") return;
        const sent = JSON.parse(r.postData() ?? "{}");
        if (!(sent.tokens ?? []).includes("warm-up")) posts.push(sent.classInstanceId);
      });
      const before = await attendance();
      stage = "S";
      await ready(page);
      // The first request to a route of a freshly started server can outlast the scanner's own 10 s limit on this
      // link; a junk token (answered "invalid") warms it, so what is tested is the scanner, not a cold start.
      const warm = await page.evaluate(async (id) => { const t0 = Date.now(); const r = await fetch("/api/checkin/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, tokens: ["warm-up"] }) }); return { status: r.status, ms: Date.now() - t0 }; }, inst["Reg No-Gi Advanced"]);
      L.note("S", "warm-up request to the card route (junk token, records nothing)", warm);
      const permissionAsked = await page.evaluate(() => typeof window.__mfCard === "boolean" && !document.querySelector("video:not(.hidden)"));
      await page.getByRole("tab", { name: "Scan QR" }).tap();
      const stillSelected = await selectedName(page);
      const noWriteOnSwitch = posts.length === 0 && JSON.stringify(await attendance()) === JSON.stringify(before);
      L.check("S", "choosing Scan QR keeps the class in view, starts no camera by itself and writes nothing", stillSelected === "Reg Fundamentals" && noWriteOnSwitch && permissionAsked && (await page.getByRole("button", { name: "Start camera" }).count()) === 1, { stillSelected, posts: posts.length });
      await page.getByRole("button", { name: "Start camera" }).tap();
      await page.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 30000 });
      // The picker opens; a card is under the lens the whole time it is open.
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).waitFor();
      await page.evaluate(() => { window.__mfCard = true; });
      await page.waitForTimeout(2000);
      const whileOpen = posts.length;
      // Still under the lens while the coach switches class.
      await picker(page).locator(`[data-session-id="${inst["Reg No-Gi Advanced"]}"]`).tap();
      await picker(page).waitFor({ state: "detached" });
      await page.waitForTimeout(2500);
      const afterSwitch = { posts: posts.length, selected: await selectedName(page), method: await page.getByRole("tab", { name: "Scan QR" }).getAttribute("aria-selected"), cameraOff: await page.getByRole("button", { name: "Start camera" }).count(), stored: await attendance() };
      L.check("S", "a card under the lens while the picker is open and across the switch is never sent: no request, no attendance; the method is kept and the new class's camera is off until started",
        whileOpen === 0 && afterSwitch.posts === 0 && afterSwitch.selected === "Reg No-Gi Advanced" && afterSwitch.method === "true" && afterSwitch.cameraOff === 1 && JSON.stringify(afterSwitch.stored) === JSON.stringify(before), { whileOpen, ...afterSwitch });
      // A real scan after the switch: once, into the new class.
      await page.getByRole("button", { name: "Start camera" }).tap();
      // The card is still under the lens: one hold, one request. If the link is slower than the scanner's 10 s limit
      // the row says "No answer yet"; the coach lifts the card and holds it again, which is a second request.
      let holds = 1;
      for (;;) {
        const settled = await Promise.race([
          page.getByText(/Last: Member 1/).waitFor({ timeout: 40000 }).then(() => "member", () => "none"),
          page.getByText(/Last: No answer yet/).waitFor({ timeout: 40000 }).then(() => "timeout", () => "none"),
        ]);
        if (settled !== "timeout" || holds >= 3) break;
        await page.evaluate(() => { window.__mfCard = false; });
        await page.waitForTimeout(2500);
        await page.evaluate(() => { window.__mfCard = true; });
        holds += 1;
        await page.waitForTimeout(1500);
        if (await page.getByText(/Last: Member 1/).count()) break;
      }
      await page.getByText(/Last: Member 1/).waitFor({ timeout: 40000 });
      await page.waitForTimeout(2500);
      const stored = await attendance();
      const scanText = (await page.getByText(/Last: Member 1/).innerText()).slice(0, 80);
      // A hold while the last request for the same card is still unanswered sends nothing new, so a slow link can
      // give fewer requests than holds; never more, and never one to another class.
      L.check("S", "a scan after the switch goes into the new class: at most one request per hold, every one to the new class, one attendance record, none anywhere else",
        posts.length >= 1 && posts.length <= holds && posts.every((p) => p === inst["Reg No-Gi Advanced"]) && stored.filter((s) => s.endsWith("Member 1")).join() === "Reg No-Gi Advanced:Member 1" && JSON.stringify(stored.filter((s) => !s.endsWith("Member 1"))) === JSON.stringify(before), { holds, posts: posts.length, allToNewClass: posts.every((p) => p === inst["Reg No-Gi Advanced"]), stored, scanText });
      await ctx.close();
    }

    // ── W: mark by name, switch class at once; the answer is announced with the first class's name ──
    {
      stage = "W";
      const { ctx, page } = await open("1280", 18);
      const first = "Reg Sparring";
      const second = "Reg Evening Gi";
      const firstStart = hm(startNow + 150);
      // The mark's answer is held back three seconds, so the switch happens while it is on the wire.
      await page.route("**/api/checkin", async (route) => { if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 3000)); await route.continue().catch(() => {}); });
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).locator(`[data-session-id="${inst[first]}"]`).click();
      const search = page.getByLabel("Find a member");
      await search.waitFor({ timeout: 30000 });
      await search.fill("Member 1");
      await page.getByRole("button", { name: /Member 1/ }).first().waitFor({ timeout: 30000 });
      await search.press("Enter");
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).locator(`[data-session-id="${inst[second]}"]`).click();
      const switchedBeforeAnswer = (await selectedName(page)) === second;
      const want = `Marked in: Member 1 — ${first} at ${firstStart}`;
      const toast = await page.getByText(want).waitFor({ timeout: 30000 }).then(() => want, async () => (await page.getByRole("alert").allInnerTexts().catch(() => [])).join(" | "));
      await page.waitForTimeout(1500);
      const stored = (await attendance()).filter((x) => x.endsWith("Member 1"));
      L.check("W", "a mark by name answered after the switch: the toast names the class it went into (with its start), the record is in that class and not the one now on screen",
        switchedBeforeAnswer && toast === want && stored.includes(`${first}:Member 1`) && !stored.includes(`${second}:Member 1`) && (await selectedName(page)) === second, { switchedBeforeAnswer, toast, stored, selected: await selectedName(page) });
      await ctx.close();
    }

    // A page with the simulated camera: window.__mfCard says whether the card is under the lens.
    const withCamera = async (ctx, tok) => ctx.addInitScript((tk) => {
      window.__mfCard = false;
      class FakeBarcodeDetector {
        static async getSupportedFormats() { return ["qr_code"]; }
        async detect() { return window.__mfCard ? [{ rawValue: tk, format: "qr_code" }] : []; }
      }
      window.BarcodeDetector = FakeBarcodeDetector;
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 480;
      const g = canvas.getContext("2d");
      setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`; g.fillRect(0, 0, 640, 480); }, 50);
      if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
      navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(15);
    }, tok);
    const cardPosts = (page) => {
      const sentTo = [];
      page.on("request", (r) => {
        if (r.method() !== "POST" || new URL(r.url()).pathname !== "/api/checkin/card") return;
        const sent = JSON.parse(r.postData() ?? "{}");
        if (!(sent.tokens ?? []).includes("warm-up")) sentTo.push(sent.classInstanceId);
      });
      return sentTo;
    };

    // ── Q: the scanner is paused by the picker AND by the cancel confirmation (owner) ──
    {
      stage = "Q";
      const cls2 = "Reg Wrestling";
      const token2 = signCardToken({ tenantId: t, memberId: m2.id, cardVersion: m2.cardVersion });
      const { ctx, page } = await open("390", 19);
      await withCamera(ctx, token2);
      const posts = cardPosts(page);
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).locator(`[data-session-id="${inst[cls2]}"]`).tap();
      await picker(page).waitFor({ state: "detached" });
      await page.getByRole("tab", { name: "Scan QR" }).tap();
      await page.getByRole("button", { name: "Start camera" }).tap();
      await page.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 30000 });
      const before = await attendance();
      // (a) the picker is open with the card under the lens.
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).waitFor();
      await page.evaluate(() => { window.__mfCard = true; });
      await page.waitForTimeout(2500);
      const duringPicker = posts.length;
      await page.evaluate(() => { window.__mfCard = false; });
      await page.keyboard.press("Escape");
      await picker(page).waitFor({ state: "detached" });
      await page.waitForTimeout(1500);
      // (b) the cancel confirmation is open with the card under the lens.
      await page.getByRole("button", { name: /Session details/ }).tap();
      await page.getByRole("button", { name: "Cancel this session" }).tap();
      const confirm = page.getByRole("dialog", { name: /^Cancel / });
      await confirm.waitFor();
      await page.evaluate(() => { window.__mfCard = true; });
      await page.waitForTimeout(2500);
      const duringConfirm = posts.length;
      await page.evaluate(() => { window.__mfCard = false; });
      await confirm.getByRole("button", { name: "Keep it" }).tap();
      await confirm.waitFor({ state: "detached" });
      const afterDismiss = { posts: posts.length, stored: await attendance() };
      L.check("Q", "owner, Scan QR running: a card held while (a) the picker and (b) the cancel confirmation is open sends no request and records nothing",
        duringPicker === 0 && duringConfirm === 0 && afterDismiss.posts === 0 && JSON.stringify(afterDismiss.stored) === JSON.stringify(before), { duringPicker, duringConfirm, ...afterDismiss });
      // After dismissal: one hold records once, into the class on screen.
      await page.waitForTimeout(1500);
      await page.evaluate(() => { window.__mfCard = true; });
      const settled = await Promise.race([
        page.getByText(/Last: Member 2/).waitFor({ timeout: 40000 }).then(() => "member", () => "none"),
        page.getByText(/Last: No answer yet/).waitFor({ timeout: 40000 }).then(() => "timeout", () => "none"),
      ]);
      await page.evaluate(() => { window.__mfCard = false; });
      await page.waitForTimeout(3000);
      const added = (await attendance()).filter((x) => !before.includes(x));
      L.check("Q", "after dismissal one hold sends one request, to the class on screen, and records once there",
        posts.length === 1 && posts[0] === inst[cls2] && JSON.stringify(added) === JSON.stringify([`${cls2}:Member 2`]) && (await selectedName(page)) === cls2, { settled, posts: posts.length, toShown: posts[0] === inst[cls2], added });
      await ctx.close();
    }

    // ── N: the club's midnight passes under an open page, with no focus or visibility event ──
    {
      stage = "N";
      // Five minutes past the club's next midnight, as the page's clock (Playwright's page.clock: Date only; timers run).
      const nowMs = Date.now();
      const midnight = new Date(nowMs + ((1440 - nowMin) * 60 - new Date(nowMs).getUTCSeconds()) * 1000 + 5 * 60000);
      const fmt = (d) => new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(d);
      const notice = `It is now ${fmt(midnight)}. This register is for ${dateLabel}. Reload to see today\u2019s classes.`;
      // (i) by name: Member 1 is booked into Fundamentals, the class this page opens on.
      {
        const { ctx, page } = await open("390", 20);
        const writes = [];
        page.on("request", (r) => { if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/checkin")) writes.push(r.method()); });
        await ready(page);
        await page.getByRole("button", { name: "Mark Member 1 attended" }).waitFor({ timeout: 30000 });
        const before = await attendance();
        await page.clock.setFixedTime(midnight);
        const moved = await page.evaluate(() => new Date().toISOString());
        await page.getByRole("button", { name: "Mark Member 1 attended" }).tap();
        const shown = await page.getByTestId("stale-day").innerText({ timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(1500);
        L.check("N", "by name: after the club's midnight (page clock moved, no focus event) a mark writes nothing, the dated notice shows, the class is unchanged",
          moved === midnight.toISOString() && writes.length === 0 && JSON.stringify(await attendance()) === JSON.stringify(before) && (shown ?? "").includes(notice) && (await selectedName(page)) === "Reg Fundamentals" && (await page.getByRole("button", { name: "Reload" }).count()) === 1,
          { pageClock: moved, writes: writes.length, shown, selected: await selectedName(page) });
        await ctx.close();
      }
      // (ii) a card held after midnight.
      {
        const token1 = signCardToken({ tenantId: t, memberId: m1.id, cardVersion: m1.cardVersion });
        const { ctx, page } = await open("390", 21);
        await withCamera(ctx, token1);
        const posts = cardPosts(page);
        await ready(page);
        await page.getByRole("tab", { name: "Scan QR" }).tap();
        await page.getByRole("button", { name: "Start camera" }).tap();
        await page.getByRole("button", { name: "Stop camera" }).waitFor({ timeout: 30000 });
        const before = await attendance();
        await page.clock.setFixedTime(midnight);
        const moved = await page.evaluate(() => new Date().toISOString());
        await page.evaluate(() => { window.__mfCard = true; });
        const shown = await page.getByTestId("stale-day").innerText({ timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(2000);
        L.check("N", "card: after the club's midnight a card held is not sent, the dated notice shows, the class is unchanged",
          moved === midnight.toISOString() && posts.length === 0 && JSON.stringify(await attendance()) === JSON.stringify(before) && (shown ?? "").includes(notice) && (await selectedName(page)) === "Reg Fundamentals",
          { pageClock: moved, posts: posts.length, shown, selected: await selectedName(page) });
        await ctx.close();
      }
    }

    // ── X: the phone's More menu and the class picker (390 wide) ──
    {
      stage = "X";
      const { ctx, page } = await open("390", 22);
      await ready(page);
      const more = page.getByRole("button", { name: "More options" });
      const openDialogs = () => page.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].filter((d) => !d.closest("[inert]") && d.getAttribute("aria-hidden") !== "true" && d.getBoundingClientRect().height > 0 && d.getBoundingClientRect().top < innerHeight).map((d) => d.getAttribute("aria-label") || document.getElementById(d.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() || "?"));
      // Picker open: what is on top where the More button is, and what a tap there does.
      await page.getByRole("button", { name: "Change class" }).tap();
      await picker(page).waitFor();
      await page.waitForTimeout(400);
      const mb = await more.boundingBox();
      const atMore = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { insideNav: !!el?.closest('nav[aria-label="Main navigation"]'), isMore: !!el?.closest('[aria-label="More options"]'), insidePicker: !!el?.closest('[role="dialog"]') }; }, { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 });
      const dialogsWithPicker = await openDialogs();
      await page.touchscreen.tap(mb.x + mb.width / 2, mb.y + mb.height / 2);
      await page.waitForTimeout(600);
      const afterTap = { picker: await picker(page).count(), moreExpanded: await more.getAttribute("aria-expanded"), dialogs: await openDialogs(), focus: await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || null) };
      if (afterTap.picker) { await page.keyboard.press("Escape"); await picker(page).waitFor({ state: "detached" }); }
      L.check("X@390", "picker open: the More button is covered (not on top), and a tap where it is never opens More over the picker; never two overlays",
        !atMore.isMore && !atMore.insideNav && afterTap.moreExpanded !== "true" && dialogsWithPicker.length === 1 && afterTap.dialogs.length <= 1, { atMore, dialogsWithPicker, afterTap });
      // More open: what a tap on Change class does, and where focus goes.
      await more.tap();
      await page.waitForTimeout(500);
      const dialogsWithMore = await openDialogs();
      const cb = await page.getByRole("button", { name: "Change class" }).boundingBox();
      const atChange = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return { isChange: el?.closest("button")?.textContent?.trim() === "Change class" }; }, { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 });
      await page.touchscreen.tap(cb.x + cb.width / 2, cb.y + cb.height / 2);
      await page.waitForTimeout(600);
      const afterChangeTap = { picker: await picker(page).count(), moreExpanded: await more.getAttribute("aria-expanded"), dialogs: await openDialogs(), focus: await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || null) };
      // Then Change class works as normal, and closes back onto itself.
      if (afterChangeTap.picker) { await page.keyboard.press("Escape"); await picker(page).waitFor({ state: "detached" }); }
      await page.getByRole("button", { name: "Change class" }).tap();
      const pickerAgain = await picker(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
      const dialogsAgain = await openDialogs();
      await page.keyboard.press("Escape");
      await picker(page).waitFor({ state: "detached" }).catch(() => {});
      const focusBack = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
      L.check("X@390", "More open: Change class is under its backdrop (a tap there closes More and opens nothing); never two overlays; afterwards Change class opens the picker alone and focus returns to it",
        dialogsWithMore.length === 1 && !atChange.isChange && afterChangeTap.dialogs.length <= 1 && !(afterChangeTap.picker && afterChangeTap.moreExpanded === "true") && pickerAgain && dialogsAgain.length === 1 && focusBack === "Change class" && (await selectedName(page)) === "Reg Fundamentals",
        { dialogsWithMore, atChange, afterChangeTap, pickerAgain, dialogsAgain, focusBack });
      await ctx.close();
    }

    // ── A: an earlier class chosen on purpose stays chosen ──
    {
      stage = "A: earlier class";
      const { ctx, page } = await open("1280", 16);
      await ready(page);
      await page.getByRole("button", { name: "Change class" }).click();
      await picker(page).locator(`[data-session-id="${inst["Reg Early Drilling"]}"]`).click();
      await page.getByLabel("Find a member").waitFor({ timeout: 30000 });
      await page.getByRole("tab", { name: "Scan QR" }).click();
      await page.getByRole("tab", { name: "By name" }).click();
      // Leave it open; come back to the tab (the register re-reads on focus).
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(2000);
      const label = await page.getByTestId("selected-class-label").innerText();
      L.check("A", "an earlier class chosen by the coach stays selected through a change of method and a re-read", (await selectedName(page)) === "Reg Early Drilling" && /earlier today/i.test(label), { label });
      await ctx.close();
    }

    // ── C: owner's cancel and kiosk paths still open (nothing saved) ──
    {
      stage = "C: owner";
      const { ctx, page } = await open("1280", 17);
      await ready(page);
      const hiddenFirst = await page.getByRole("button", { name: "Cancel this session" }).count();
      await page.getByRole("button", { name: /Session details/ }).click();
      await page.getByRole("button", { name: "Cancel this session" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel(/Reason/).waitFor();
      const asked = await dialog.innerText();
      await dialog.getByRole("button", { name: "Keep it" }).click();
      const cancelled = Number((await q(`select count(*)::int as n from "ClassInstance" where "classId" = any($1) and "isCancelled"`, [Object.values(cls)]))[0].n);
      L.check("C", "owner: Cancel this session is under Session details, asks for a reason and confirmation as before; Keep it cancels nothing", hiddenFirst === 0 && /Reason/.test(asked) && cancelled === 0, { hiddenFirst, cancelled });
      const kiosk = page.getByTestId("kiosk-section");
      await kiosk.getByRole("button", { name: "Open kiosk" }).click();
      await kiosk.getByText("Kiosk Check-In").waitFor({ timeout: 30000 });
      const kioskText = (await kiosk.innerText()).replace(/\s+/g, " ");
      L.check("C", "owner: Open kiosk shows the existing kiosk control; the section is the last thing on the page", /Self-service kiosk/.test(kioskText) && /Let members check themselves in/.test(kioskText) && (await page.evaluate(() => { const k = document.querySelector('[data-testid="kiosk-section"]'); const d = document.querySelector('[data-testid="session-details"]'); return !!(d.compareDocumentPosition(k) & Node.DOCUMENT_POSITION_FOLLOWING); })), { kioskText: kioskText.slice(0, 160) });
      await ctx.close();
    }
  }
} catch (e) {
  const seen = lastPage && !lastPage.isClosed() ? await lastPage.evaluate(() => document.querySelector("main")?.innerText.replace(/\s+/g, " ").slice(0, 600)).catch(() => null) : null;
  if (lastPage && !lastPage.isClosed()) await shot(lastPage, "attendance-register-failure").catch(() => {});
  L.check("run", "ran to the end", false, { stage, error: String(e).split("\n")[0].slice(0, 200), seen });
} finally {
  await browser.close().catch(() => {});
  if (!BEFORE) L.check("all", "no uncaught page errors", errors.length === 0, errors);
  await cleanup();
  await q(`update "Tenant" set timezone = $2 where id = $1`, [t, startTz]).catch(() => {});
  const left = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = any($2)`, [t, NAMES]))[0].n);
  L.check("cleanup", "the classes, mats and attendance this journey made are removed", left === 0, { left });
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
