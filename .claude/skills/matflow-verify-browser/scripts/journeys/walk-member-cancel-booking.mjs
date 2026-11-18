// Round 13 walk (brief: "Member — sign in, see their plan and progress, book/cancel and understand access limits").
// The cancel path was unit-tested only (round13-acceptance-matrix §C). A member signs in through the real form, opens
// a class they have booked and cancels it: a failed cancel (network failure, then a server error) keeps the booking
// and says so; the retry sends exactly one request and removes it; reload shows it gone; the member books it again by
// keyboard alone; at phone width the sheet's action is reachable without sideways scroll.
// Outcomes only (row in the database, what the page says), not the mechanism: main flips the button optimistically and
// rolls back, the Round 7 branch waits for the answer; both must satisfy every check here.
// Needs `fixture.mjs create` and `server.mjs start` (or run-journeys.mjs).
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("walk-member-cancel-booking");
const tenantId = club.tenantId;
const errors = [];

// A class on today's weekday, late enough to be bookable all day; Prisma's dayOfWeek: 0 = Sunday … 6 = Saturday.
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayMarker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const dayOfWeek = todayMarker.getUTCDay();
const NAME = "Walk Nogi";

const member = await memberLogin(club);
const tier = randomUUID(), cls = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $2, 'Walk Unlimited', 0, 'GBP', 'monthly', now())`, [tier, tenantId]);
await q(`update "Member" set "membershipTierId" = $1 where id = $2 and "tenantId" = $3`, [tier, member.id, tenantId]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 30)`, [cls, tenantId, NAME]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, '21:00', '22:00')`, [randomUUID(), cls, dayOfWeek]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '21:00', '22:00')`, [randomUUID(), cls, todayMarker]);
await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), member.id, cls]);
const booked = async () => Number((await q(`select count(*)::int as n from "ClassSubscription" where "memberId" = $1 and "classId" = $2`, [member.id, cls]))[0].n);

const isSubscriptionCall = (url, method) => new URL(url).pathname === `/api/member/class-subscriptions/${cls}` && (!method || true);
async function openSheet(page) {
  const block = page.getByRole("button", { name: new RegExp(`^${NAME}, `) }).first();
  await block.waitFor({ timeout: 60000 });
  await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await block.click();
}
const cancelButton = (page) => page.getByRole("button", { name: /Unsubscribe/ }).first();
const bookButton = (page) => page.getByRole("button", { name: "Subscribe to class" });
// Tap outside the sheet (its scrim), the way a member on a phone closes it. Escape is checked separately (K3): main's
// member sheet has no Escape; #97 (Round 11) adds it.
async function closeSheet(page) {
  await page.mouse.click(20, 20);
  await page.waitForTimeout(400);
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.131.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  await memberSignIn(page, club, member);
  L.check("journey", "W1 member signs in through the real form and lands in the member app", /\/member/.test(page.url()), new URL(page.url()).pathname);
  await page.goto("/member/schedule");
  await openSheet(page);
  const cancelShown = await cancelButton(page).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "W2 the booked class offers cancelling (Unsubscribe)", cancelShown);
  if (!cancelShown) throw new Error("no Unsubscribe button: the cancel steps cannot run");
  await shot(page, "walk-cancel-sheet");

  // F1: the network drops the cancel. The booking stays, and the member is told.
  let deletes = 0;
  await page.route(`**/api/member/class-subscriptions/${cls}`, (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes += 1;
    return route.abort("failed");
  });
  await cancelButton(page).click();
  // main says "Couldn't unsubscribe"; with #92 a lost answer says "Couldn't confirm that you're no longer booked".
  const f1Said = await page.getByRole("alert").filter({ hasText: /unsubscribe|cancel|no longer booked/i }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  L.check("failure", "F1 a cancel lost to the network says it did not happen, and the booking is still there", f1Said && (await booked()) === 1 && deletes === 1, { f1Said, rows: await booked(), deletes });
  await page.unroute(`**/api/member/class-subscriptions/${cls}`);
  await closeSheet(page);

  // F2: the server refuses (500). Same outcome.
  await openSheet(page);
  await cancelButton(page).waitFor({ timeout: 20000 });
  deletes = 0;
  await page.route(`**/api/member/class-subscriptions/${cls}`, (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    deletes += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal error" }) });
  });
  await cancelButton(page).click();
  const f2Said = await page.getByRole("alert").filter({ hasText: /unsubscribe|cancel/i }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  await page.waitForTimeout(500);
  L.check("failure", "F2 a cancel the server refuses says so, and the booking is still there", f2Said && (await booked()) === 1 && deletes === 1, { f2Said, rows: await booked(), deletes });
  await page.unroute(`**/api/member/class-subscriptions/${cls}`);
  const stillOffered = await cancelButton(page).isVisible().catch(() => false);
  L.check("failure", "F3 after the failure the sheet still offers cancelling (it does not pretend the cancel worked)", stillOffered);

  // R1: the retry sends exactly one DELETE and removes the booking.
  const sent = [];
  const onReq = (r) => { if (r.method() === "DELETE" && isSubscriptionCall(r.url())) sent.push(r.url()); };
  page.on("request", onReq);
  const answered = page.waitForResponse((r) => r.request().method() === "DELETE" && isSubscriptionCall(r.url()), { timeout: 60000 });
  await cancelButton(page).click();
  const res = await answered;
  await page.waitForTimeout(800);
  page.off("request", onReq);
  L.check("retry", "R1 the retry sends exactly one cancel request and it succeeds", sent.length === 1 && res.ok(), { requests: sent.length, status: res.status() });
  L.check("retry", "R2 the booking row is gone", (await booked()) === 0, { rows: await booked() });
  await closeSheet(page);
  await page.reload();
  await openSheet(page);
  const offeredAgain = await bookButton(page).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("retry", "R3 after reload the class offers booking again (the cancel persisted)", offeredAgain);
  await closeSheet(page);

  // K: book again by keyboard alone. Focus the class, Enter opens it, Tab reaches the action, Enter books.
  const block = page.getByRole("button", { name: new RegExp(`^${NAME}, `) }).first();
  await block.focus();
  await page.keyboard.press("Enter");
  await bookButton(page).waitFor({ timeout: 15000 });
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await bookButton(page).evaluate((el) => el === document.activeElement).catch(() => false);
  }
  const ring = reached ? await bookButton(page).evaluate((el) => { const s = getComputedStyle(el); return s.outlineStyle !== "none" || s.boxShadow !== "none"; }) : false;
  L.check("keyboard", "K1 Tab reaches the booking action inside the open sheet, with a visible focus indicator", reached && ring, { reached, ring });
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && isSubscriptionCall(r.url()), { timeout: 60000 });
  await page.keyboard.press("Enter");
  const p = await posted;
  await page.waitForTimeout(500);
  L.check("keyboard", "K2 Enter books the class and the row exists", p.ok() && (await booked()) === 1, { status: p.status(), rows: await booked() });
  await page.keyboard.press("Escape");
  const sheetClosed = await cancelButton(page).isHidden({ timeout: 5000 }).catch(() => false);
  L.check("keyboard", "K3 Escape closes the sheet", sheetClosed);

  // M: phone width, the member's real device. No sideways scroll; the cancel action is reachable and tappable.
  const phone = await context(browser, "10.131.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/member/schedule");
  await p2.waitForLoadState("load");
  const m1 = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 /member/schedule at 390 px has no horizontal page scroll", m1.scroll <= m1.width + 1, m1);
  await openSheet(p2);
  const btn = cancelButton(p2);
  const tappable = await btn.waitFor({ timeout: 15000 }).then(() => true, () => false);
  const box = tappable ? await btn.boundingBox() : null;
  const inView = !!box && box.y >= 0 && box.y + box.height <= 844;
  L.check("mobile", "M2 at 390 px the cancel action is on screen and at least 44 px tall", tappable && inView && box.height >= 44, box);
  await shot(p2, "walk-cancel-mobile");

  // Hydration text mismatch on member pages when the browser zone differs from the server's is a known, separate
  // finding (round11-child-today N2); counted as a note, not here.
  const other = errors.filter((e) => !/Minified React error #418/.test(e));
  if (other.length !== errors.length) L.note("journey", "N1 pre-existing hydration text mismatch (#418) seen", errors.length - other.length);
  L.check("journey", "W3 no other uncaught page errors", other.length === 0, other);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
