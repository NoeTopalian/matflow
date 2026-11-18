// Journey: a club whose generated sessions have run out (PR #93, Round 9, 16 Nov 2026).
// The class has a slot today but NO ClassInstance rows at all — the state a production club reaches 28–62 days after
// its rows were last made, because the nightly cron never runs there. Before #93 the member saw the class but self
// check-in said there was no session. The member signs in to Home: the read tops the horizon up, so today's session and
// the rolling window exist, today's class carries a classInstanceId (check-in possible), booking is still offered, no
// session is duplicated, and the phone layout holds.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/class-horizon-lapse.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("class-horizon-lapse");
const tenantId = club.tenantId;
const errors = [];

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
const T = `${String(Math.min(23, Number(parts.hour) + 1)).padStart(2, "0")}:30`; // later today, club time
const dayOfWeek = todayMarker.getUTCDay(); // Prisma: 0 = Sunday

// The fixture's own synthetic member, given a sign-in for this run by the harness (no credential in this file).
const member = await memberLogin(club);
const cls = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Lapsed Class', 60, 30)`, [cls, tenantId]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [randomUUID(), cls, dayOfWeek, T]);
const rows = async () => q(`select date, "startTime", "isCancelled" from "ClassInstance" where "classId" = $1 order by date`, [cls]);

L.check("setup", "S1 the class starts lapsed: a slot today, no session rows", (await rows()).length === 0, { rows: (await rows()).length, todayIso, T });

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const homeRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/member/home" && r.request().method() === "GET", { timeout: 180000 });
  await memberSignIn(page, club, member);
  const home = await homeRead.catch(() => null);
  L.check("journey", "J1 member Home loads its data (the read that tops the horizon up)", home?.status() === 200, { status: home?.status() ?? null });

  const after = await rows();
  const today = after.filter((r) => r.date.getTime() === todayMarker.getTime() && r.startTime === T);
  L.check("db", "J2 today's session now exists, not cancelled", today.length === 1 && today[0].isCancelled === false, { today: today.length });
  L.check("db", "J3 the rolling window is filled: one session per week of that weekday for the next 56 days", after.length === 8, { rows: after.length });
  L.check("db", "J4 no session is duplicated", new Set(after.map((r) => `${r.date.toISOString()} ${r.startTime}`)).size === after.length, { rows: after.length });

  const sched = await page.request.get(`/api/member/schedule?date=${todayIso}`);
  const list = sched.ok() ? await sched.json() : [];
  const mine = Array.isArray(list) ? list.find((r) => r.classId === cls) : null;
  L.check("journey", "J5 today's class carries a session id, so self check-in is possible", typeof mine?.classInstanceId === "string" && mine?.cancelled === false, { status: sched.status(), hasId: typeof mine?.classInstanceId === "string" });
  await shot(page, "class-horizon-home");

  await page.goto("/member/schedule");
  const block = page.getByRole("button", { name: /^Lapsed Class, / }).first();
  const shown = await block.waitFor({ timeout: 60000 }).then(() => true, () => false);
  if (shown) { await block.evaluate((el) => el.scrollIntoView({ block: "center" })); await block.click(); }
  const subscribe = await page.getByRole("button", { name: "Subscribe to class" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("journey", "J6 the schedule shows the class and still offers booking", shown && subscribe, { shown, subscribe });

  // A second read in the same server instance does not re-run the top-up (memo) and changes nothing.
  await page.request.get(`/api/member/schedule?date=${todayIso}`);
  L.check("db", "J7 a repeated read adds no rows", (await rows()).length === after.length, { rows: (await rows()).length });

  const phone = await context(browser, "10.94.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/member/home");
  await p2.waitForLoadState("load");
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 /member/home at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  await shot(p2, "class-horizon-home-mobile");
  L.check("journey", "J8 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
