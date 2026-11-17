// Journey: Round 11 (baseline 5.1) — a guardian is not led to book themselves when they mean their child.
// A synthetic parent with one confirmed child who has no classes, and a synthetic adult with no children. Phone width
// (390, touch). Member home: the child's card says to ask the club and has no link to booking. Member schedule: the
// parent's class sheet says "This books you, not <child>."; the adult's does not. Forced failure: the children read
// aborted, the line is left off and booking is still offered.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-guardian-booking.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-guardian-booking");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayMarker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const T = `${String(Math.min(22, Math.max(Number(parts.hour) + 1, 10))).padStart(2, "0")}:00`;
const CLASS = `Guard Mat ${TAG}`;
const PARENT = `Guardian ${TAG}`, CHILD = `Mia ${TAG}`, SOLO = `Solo ${TAG}`;
const email = (k) => `${club.slug}-${k}-${TAG}@example.test`.toLowerCase();

// ── Seed ──
const parentId = randomUUID(), childId = randomUUID(), soloId = randomUUID(), classId = randomUUID();
await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "onboardingCompleted", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'parent', true, true, now())`, [parentId, tenantId, email("parent"), PARENT]);
await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "onboardingCompleted", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'adult', true, true, now())`, [soloId, tenantId, email("solo"), SOLO]);
await q(`insert into "Member" (id, "tenantId", email, name, "accountType", "parentMemberId", "guardianConfirmedAt", "guardianSuggestedBy", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, 'kids', $5, now(), 'staff', true, now())`, [childId, tenantId, email("child"), CHILD, parentId]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [classId, tenantId, CLASS]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [randomUUID(), classId, todayMarker.getUTCDay(), T]);

const phone = (browser, ip) => context(browser, ip, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const classBlock = (page) => page.getByRole("button", { name: new RegExp(`^${CLASS}, `) }).first();
async function openSheet(page) {
  await page.goto("/member/schedule");
  await classBlock(page).waitFor({ timeout: 60000 });
  await classBlock(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await classBlock(page).tap();
  return page.getByRole("button", { name: "Subscribe to class" }).waitFor({ timeout: 15000 }).then(() => true, () => false);
}
const booksYou = (page) => page.getByTestId("books-you");

const browser = await chromium.launch();
try {
  // ── Parent ──
  {
    const ctx = await phone(browser, "10.98.2.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(page, club, await memberLogin(club, PARENT));
    await page.goto("/member/home");
    await page.getByRole("button", { name: `Show ${CHILD}'s timetable` }).tap({ timeout: 60000 });
    const line = page.getByTestId("child-no-classes");
    await line.waitFor({ timeout: 15000 });
    const text = (await line.textContent())?.trim();
    const links = await line.getByRole("link").count();
    L.check("parent", "G1 the child's card says to ask the club and has no link to the timetable", text === `${CHILD} isn't on any classes yet. Ask your club to add ${CHILD} to a class.` && links === 0, { text, links });
    await shot(page, "r11-guardian-child-card");

    const opened = await openSheet(page);
    const said = opened ? (await booksYou(page).textContent().catch(() => null))?.trim() : null;
    L.check("parent", "G2 the parent's class sheet says the booking is theirs, naming the child", opened && said === `This books you, not ${CHILD}.`, { opened, said });
    await shot(page, "r11-guardian-books-you");

    await page.route("**/api/member/me/children", (route) => route.abort("failed"));
    const reopened = await openSheet(page);
    L.check("parent", "F1 with the children read failing, the line is left off and booking is still offered", reopened && (await booksYou(page).count()) === 0, { reopened });
    await ctx.close();
  }

  // ── Adult with no children ──
  {
    const ctx = await phone(browser, "10.98.2.2");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(page, club, await memberLogin(club, SOLO));
    const opened = await openSheet(page);
    await page.waitForTimeout(1500);
    L.check("adult", "A1 an adult with no children sees no 'books you' line", opened && (await booksYou(page).count()) === 0, { opened });
    await ctx.close();
  }

  const booked = Number((await q(`select count(*)::int as n from "ClassSubscription" where "classId" = $1`, [classId]))[0].n);
  L.check("journey", "J1 nothing was booked by looking", booked === 0, { booked });
  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await q(`delete from "ClassSubscription" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "ClassSchedule" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "ClassInstance" where "classId" = $1`, [classId]).catch(() => {});
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]).catch(() => {});
  await q(`delete from "Member" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, [childId, parentId, soloId]]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
