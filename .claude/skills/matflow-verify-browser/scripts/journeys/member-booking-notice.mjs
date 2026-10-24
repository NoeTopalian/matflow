// Journey: the member booking warning (review gap 6, 21 Oct 2026).
// A member on a "1 each week" plan who has already attended this week books the class's next session from the member
// schedule. The booking is NOT refused (owner decision: booking consumes nothing, guarantees nothing); the member
// sees the warning that the door will refuse unless a pack credit or staff admit them; the booking row exists.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/member-booking-notice.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, bcrypt } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("member-booking-notice");
const tenantId = club.tenantId;
const errors = [];

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
const hourNow = Number(parts.hour);
const dow = (todayMarker.getUTCDay() + 6) % 7; // Monday = 0
const nextMonday = new Date(todayMarker.getTime() + (7 - dow) * 86_400_000);
const long = (d) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;
const T1 = hh(hourNow - 2), T2 = hh(Math.min(22, Math.max(hourNow + 1, 10))); // not before 10:00: the grid's first hours sit under the sticky day header at scrollTop 0 (observation 22 Oct)
// Prisma's dayOfWeek: 0 = Sunday … 6 = Saturday.
const dayOfWeek = todayMarker.getUTCDay();

const member = (await q(`select id, name, email from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const memberPassword = `Mfv-${randomUUID().slice(0, 12)}-aa1`;

// Seed: the plan, the member on it with a password, one class with today's slot, one session already attended.
const tier = randomUUID(); const cls = randomUUID(); const inst1 = randomUUID(); const inst2 = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "updatedAt") values ($1, $2, 'Limited W', 0, 'GBP', 'monthly', 1, 'week', now())`, [tier, tenantId]);
await q(`update "Member" set "membershipTierId" = $1, "waiverAccepted" = true, "passwordHash" = $4 where id = $2 and "tenantId" = $3`, [tier, member.id, tenantId, await bcrypt.hash(memberPassword, 10)]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Open Mat', 60, 50)`, [cls, tenantId]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [randomUUID(), cls, dayOfWeek, T2]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $3, $4, $5, $5), ($2, $3, $4, $6, $6)`, [inst1, inst2, cls, todayMarker, T1, T2]);
await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), tenantId, member.id, inst1]);
const bookings = async () => Number((await q(`select count(*)::int as n from "ClassSubscription" where "memberId" = $1 and "classId" = $2`, [member.id, cls]))[0].n);

const NOTICE = `1 of 1 class used this week. Booking doesn't use a class, but checking in before ${long(nextMonday)} will need a class-pack credit or staff to admit you.`;

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.93.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  // Member sign-in through the real form (club code, email, password; no authenticator enrolled).
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(member.email);
  await page.getByLabel("Password").fill(memberPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/member/, { timeout: 60000 });
  L.check("journey", "J1 member sign-in lands in the member app", /\/member/.test(page.url()), new URL(page.url()).pathname);

  await page.goto("/member/schedule");
  const block = page.getByRole("button", { name: /^Open Mat, / }).first();
  await block.waitFor({ timeout: 60000 });
  await shot(page, "member-booking-before-click");
  // Observation 22 Oct 01:xx: with Playwright's minimal scroll the block sat under the member 2FA banner (role=status)
  // and the click was intercepted for 60 s. Record the geometry, scroll the block to the middle, then click.
  const geom = await block.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const banner = document.querySelector('[role="status"]')?.getBoundingClientRect();
    return { block: { top: r.top, bottom: r.bottom }, banner: banner ? { top: banner.top, bottom: banner.bottom } : null, vh: window.innerHeight };
  });
  L.note("journey", "N1 geometry before the click (block vs the 2FA banner)", geom);
  await block.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await block.click();
  const subscribe = page.getByRole("button", { name: "Subscribe to class" });
  const subscribeShown = await subscribe.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J2 the class sheet offers booking to a member whose weekly class is already used (not locked, not hidden)", subscribeShown && (await subscribe.isVisible()), { subscribeShown });
  if (!subscribeShown) throw new Error("no Subscribe button: the booking steps cannot run");
  const posted = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/api/member/class-subscriptions/"));
  await subscribe.click();
  const res = await posted;
  const body = await res.json().catch(() => null);
  L.check("journey", "J3 the booking is accepted (201), never refused for the allowance, and the body carries the notice",
    res.status() === 201 && body?.success === true && body?.allowanceNotice === NOTICE, { status: res.status(), notice: body?.allowanceNotice });
  const toast = page.getByRole("alert").filter({ hasText: "Booking doesn't use a class" });
  const sawToast = await toast.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J4 the member sees the warning: no promise of admission, the reset date and what admits them before it",
    sawToast && (await toast.textContent())?.includes(NOTICE), { sawToast });
  await shot(page, "member-booking-notice");
  L.check("journey", "J5 the booking row exists", (await bookings()) === 1, { rows: await bookings() });
  await page.reload();
  await page.getByRole("button", { name: /^Open Mat, / }).first().waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: /^Open Mat, / }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.getByRole("button", { name: /^Open Mat, / }).first().click();
  const unsubscribe = await page.getByRole("button", { name: /Unsubscribe|Subscribed/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J6 after reload the class shows as booked", unsubscribe, { unsubscribe });

  // Phone width.
  const phone = await context(browser, "10.93.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/member/schedule");
  await p2.waitForLoadState("load");
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 /member/schedule at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  await shot(p2, "member-booking-notice-mobile");
  L.check("journey", "J7 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
