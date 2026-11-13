// Round 6: a member's booking whose reply is lost (synthetic data only).
//   node run-journeys.mjs member-booking-lost-reply
// The request reaches the server and commits; the browser never gets the answer (Playwright fetches it, then aborts
// the page's request). The member schedule must show what the server holds: booked after a lost booking reply,
// not booked after a lost un-booking reply, and never "Couldn't book" for a booking that exists. A 503 that changed
// nothing says it did not go through; no answer and no re-read says it could not be confirmed. Each step is checked
// against the database. Desktop, phone width, keyboard.
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("member-booking-lost-reply");
const tenantId = club.tenantId;
const errors = [];

// Today's slot in the club's (and this machine's) day, late enough to sit below the sticky header (as member-booking-notice).
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayMarker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const startHour = Math.min(22, Math.max(Number(parts.hour) + 1, 10));
const START = `${String(startHour).padStart(2, "0")}:00`;
const END = `${String(startHour + 1).padStart(2, "0")}:00`;
// The member schedule's today is the device's date: the browser runs on the London date the slot is placed on.
const ZONE = { timezoneId: "Europe/London" };
const NAME = "Lost Reply Mat";

const member = await memberLogin(club);
const cls = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [cls, tenantId, NAME]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), cls, todayMarker.getUTCDay(), START, END]);
const rows = async () => Number((await q(`select count(*)::int as n from "ClassSubscription" where "memberId" = $1 and "classId" = $2`, [member.id, cls]))[0].n);
const BOOK = (u) => new URL(u).pathname === `/api/member/class-subscriptions/${cls}`;

async function section(id, desc, fn) {
  try { L.check(id, desc, true, await fn()); } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(id, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
  }
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.7.1", ZONE);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(page, club, member);
  await page.goto("/member/schedule");

  const sheetButton = (p) => p.getByRole("button", { name: /^(Subscribe to class|Unsubscribe)$/ });
  const open = async (p) => {
    if (await sheetButton(p).first().isVisible().catch(() => false)) return;
    const block = p.getByRole("button", { name: new RegExp(`^${NAME}, `) }).first();
    await block.waitFor({ timeout: 60000 });
    await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await block.click();
    await sheetButton(p).first().waitFor({ timeout: 15000 });
  };
  const label = async (p) => (await sheetButton(p).first().textContent())?.trim();
  const errorToast = (p, re) => p.getByRole("alert").filter({ hasText: re });
  /** The request reaches the server; its answer never reaches the page. */
  const loseReply = (p, method) => p.route((u) => BOOK(u.toString()), async (r) => {
    if (r.request().method() !== method) return r.continue();
    await r.fetch().catch(() => {});
    await r.abort("failed");
  });

  await section("lost-booking", "a booking that commits but whose reply is lost: shown as booked, no 'Couldn't book', one row", async () => {
    await open(page);
    if ((await label(page)) !== "Subscribe to class") throw new Error(`starts as ${await label(page)}`);
    await loseReply(page, "POST");
    await sheetButton(page).first().click();
    await page.waitForTimeout(3000);
    await page.unrouteAll({ behavior: "wait" });
    await open(page);
    const shown = await label(page);
    const claimedFailure = await errorToast(page, /Couldn't book/).count();
    const n = await rows();
    if (shown !== "Unsubscribe" || claimedFailure !== 0 || n !== 1) throw new Error(JSON.stringify({ shown, claimedFailure, rows: n }));
    return { shown, rows: n };
  });

  await section("lost-unbooking", "an un-booking that commits but whose reply is lost: shown as not booked, no row", async () => {
    await open(page);
    await loseReply(page, "DELETE");
    await sheetButton(page).first().click();
    await page.waitForTimeout(3000);
    await page.unrouteAll({ behavior: "wait" });
    await open(page);
    const shown = await label(page);
    const n = await rows();
    if (shown !== "Subscribe to class" || n !== 0) throw new Error(JSON.stringify({ shown, rows: n }));
    return { shown, rows: n };
  });

  await section("server-error", "a 503 that changed nothing: told it did not go through, shown as not booked, no row", async () => {
    await open(page);
    await page.route((u) => BOOK(u.toString()), (r) => (r.request().method() === "POST" ? r.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : r.continue()));
    await sheetButton(page).first().click();
    await errorToast(page, /Couldn't book this class/).first().waitFor({ timeout: 15000 });
    await page.unrouteAll({ behavior: "wait" });
    const shown = await label(page);
    const n = await rows();
    if (shown !== "Subscribe to class" || n !== 0) throw new Error(JSON.stringify({ shown, rows: n }));
    return { shown, rows: n };
  });

  await section("offline", "no answer and no re-read: told it could not be confirmed, never that it failed", async () => {
    await open(page);
    await page.route((u) => BOOK(u.toString()) || new URL(u.toString()).pathname === "/api/member/me/subscriptions", (r) => r.abort("failed"));
    await sheetButton(page).first().click();
    await errorToast(page, /Couldn't confirm the booking/).first().waitFor({ timeout: 15000 });
    await page.unrouteAll({ behavior: "wait" });
    const said = await errorToast(page, /Couldn't confirm the booking/).first().textContent();
    if (/Couldn't book/.test(said ?? "") || (await rows()) !== 0) throw new Error(JSON.stringify({ said, rows: await rows() }));
    return { said };
  });

  await section("keyboard", "the booking button works by keyboard (focus, Enter) and the row is written once", async () => {
    await page.reload();
    await open(page);
    await sheetButton(page).first().focus();
    const res = page.waitForResponse((r) => BOOK(r.url()) && r.request().method() === "POST");
    await page.keyboard.press("Enter");
    const status = (await res).status();
    await sheetButton(page).filter({ hasText: "Unsubscribe" }).first().waitFor({ timeout: 15000 });
    const n = await rows();
    if (status !== 201 || n !== 1) throw new Error(JSON.stringify({ status, rows: n }));
    await sheetButton(page).first().click();
    await sheetButton(page).filter({ hasText: "Subscribe to class" }).first().waitFor({ timeout: 15000 });
    return { status, rows: n };
  });
  await shot(page, "member-booking-lost-reply-desktop");

  await section("phone", "390 x 844: a lost booking reply shows booked; no sideways scroll", async () => {
    const mobile = await context(browser, "10.94.7.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ...ZONE, storageState: await ctx.storageState() });
    const p2 = await mobile.newPage();
    p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    try {
      await p2.goto("/member/schedule");
      await open(p2);
      await loseReply(p2, "POST");
      await sheetButton(p2).first().click();
      await p2.waitForTimeout(3000);
      await p2.unrouteAll({ behavior: "wait" });
      await open(p2);
      const shown = await label(p2);
      const n = await rows();
      const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
      await shot(p2, "member-booking-lost-reply-phone");
      if (shown !== "Unsubscribe" || n !== 1 || m.scroll > m.width + 1) throw new Error(JSON.stringify({ shown, rows: n, ...m }));
      return { shown, rows: n, ...m };
    } finally { await mobile.close(); }
  });

  L.check("errors", "no uncaught page errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  await q(`delete from "ClassSubscription" where "classId" = $1`, [cls]);
  await q(`delete from "ClassInstance" where "classId" = $1`, [cls]);
  await q(`delete from "ClassSchedule" where "classId" = $1`, [cls]);
  await q(`delete from "Class" where id = $1`, [cls]);
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
