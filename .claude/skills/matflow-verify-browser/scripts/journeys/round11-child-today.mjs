// Journey: Round 11 (baseline 5.3) — a guardian's child timetable says "Today" on the club's day, not the UTC day.
// Depends on PR #92 (/api/member/home returns the club's `today`). The synthetic fixture club is set, for this run
// only, to Pacific/Kiritimati (UTC+14), so from 10:00 UTC onwards its calendar date is a day ahead of UTC; the old
// code (UTC date) labels the wrong entry. A parent with one confirmed child booked on a class with sessions on the
// club's today and tomorrow: the club's today is "Today", tomorrow is not. Phone 390 with the browser in the club's zone.
// Needs `fixture.mjs create` and `server.mjs start`. Restores the club's timezone at the end.
//   node journeys/round11-child-today.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-child-today");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];
const ZONE = "Pacific/Kiritimati";

const isoIn = (zone, d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const now = new Date();
const clubToday = isoIn(ZONE, now);
const utcToday = now.toISOString().slice(0, 10);
const clubTomorrow = new Date(Date.parse(`${clubToday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
L.note("setup", "N1 the club's date and the UTC date this run", { clubToday, utcToday, differ: clubToday !== utcToday });

const was = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0].timezone;
const parentId = randomUUID(), childId = randomUUID(), classId = randomUUID();
const PARENT = `Guardian T ${TAG}`, CHILD = `Mia T ${TAG}`, CLASS = `Kids Today ${TAG}`;
const email = (k) => `${club.slug}-${k}-${TAG}@example.test`.toLowerCase();

const browser = await chromium.launch();
try {
  await q(`update "Tenant" set timezone = $2 where id = $1`, [tenantId, ZONE]);
  await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "onboardingCompleted", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'parent', true, true, now())`, [parentId, tenantId, email("parent"), PARENT]);
  await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'kids', $5, now(), 'staff', true, now())`, [childId, tenantId, email("child"), CHILD, parentId]);
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "isKids") values ($1, $2, $3, 60, 20, true)`, [classId, tenantId, CLASS]);
  for (const d of [clubToday, clubTomorrow]) {
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '23:30', '23:59')`, [randomUUID(), classId, new Date(`${d}T00:00:00.000Z`)]);
  }
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), childId, classId]);

  const ctx = await context(browser, "10.98.6.1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: ZONE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(page, club, await memberLogin(club, PARENT));
  await page.goto("/member/home");
  await page.getByRole("button", { name: `Show ${CHILD}'s timetable` }).tap({ timeout: 60000 });
  const rows = page.locator("div.flex.items-start.gap-3.text-xs").filter({ hasText: CLASS });
  await rows.first().waitFor({ timeout: 15000 });
  const labels = await rows.evaluateAll((els) => els.map((el) => el.firstElementChild?.textContent?.trim() ?? ""));
  const tomorrowWord = new Date(`${clubTomorrow}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  L.check("guardian", "T1 the club's today's session is labelled Today, and the club's tomorrow is labelled by its weekday",
    labels.length === 2 && labels[0] === "Today" && labels[1] === tomorrowWord, { labels, tomorrowWord });
  L.check("guardian", "T2 this run had the club's date ahead of UTC (the case the old UTC date got wrong)", clubToday !== utcToday, { clubToday, utcToday });
  await shot(page, "r11-child-today");
  await ctx.close();
  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await q(`update "Tenant" set timezone = $2 where id = $1`, [tenantId, was]).catch(() => {});
  await q(`delete from "ClassSubscription" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "ClassInstance" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]).catch(() => {});
  await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, [childId, parentId]]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
