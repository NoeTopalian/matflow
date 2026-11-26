// Journey: the staff dashboard's "Today's Classes" names each class's coach (26 Nov 2026, Noe).
// Three classes today on a synthetic club: one with a linked staff coach, one with only a typed coach name, one with
// neither. At 1280 and 390 the card reads the staff coach's name, the typed name, and "No coach assigned"; no card
// says "TBC" or carries the amber "Needs coach" pill.
//   node journeys/dashboard-coach-name.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("dashboard-coach-name");
const t = club.tenantId;
let stage = "start";
let lastPage = null;

const tz = (await q(`select timezone from "Tenant" where id = $1`, [t]))[0]?.timezone || "Europe/London";
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
const marker = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`);
const CLASSES = [
  { name: "Coach Staff Linked", time: "10:00", typed: null, linked: true, want: "Casey Staff" },
  { name: "Coach Typed Only", time: "11:00", typed: "Terry Typed", linked: false, want: "Terry Typed" },
  { name: "Coach Open Mat", time: "12:00", typed: null, linked: false, want: "No coach assigned" },
];
const inst = {};

async function cleanup() {
  const rows = await q(`select id from "Class" where "tenantId" = $1 and name = any($2)`, [t, CLASSES.map((c) => c.name)]);
  for (const { id } of rows) {
    await q(`delete from "AttendanceRecord" where "classInstanceId" in (select id from "ClassInstance" where "classId" = $1)`, [id]).catch(() => {});
    for (const tb of ["ClassSubscription", "ClassSchedule", "ClassInstance"]) await q(`delete from "${tb}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, t]).catch(() => {});
  }
}
await cleanup();
const coach = await seedStaff(club, "coach", { name: "Casey Staff" });
for (const c of CLASSES) {
  const id = randomUUID();
  inst[c.name] = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "coachName", "coachUserId") values ($1, $2, $3, 60, 20, $4, $5)`, [id, t, c.name, c.typed, c.linked ? coach.id : null]);
  const end = `${String(Number(c.time.slice(0, 2)) + 1).padStart(2, "0")}:00`;
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [inst[c.name], id, marker, c.time, end]);
}

const VIEW = { "1280": { viewport: { width: 1280, height: 800 } }, "390": { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } };
const browser = await chromium.launch();
try {
  const oc = await context(browser, "10.98.1.1", VIEW["1280"]);
  const op = await oc.newPage();
  await ownerSignIn(op, club);
  const owner = await oc.storageState();
  await oc.close();
  for (const [tag, lane] of [["1280", 2], ["390", 3]]) {
    stage = `dashboard@${tag}`;
    const ctx = await context(browser, `10.98.1.${lane}`, { ...VIEW[tag], storageState: owner });
    const page = await ctx.newPage();
    lastPage = page;
    await page.goto("/dashboard");
    const cards = {};
    for (const c of CLASSES) {
      const card = page.locator(`a[href="/dashboard/checkin?class=${inst[c.name]}"]`).first();
      await card.waitFor({ timeout: 60000 });
      cards[c.name] = (await card.innerText()).replace(/\s+/g, " ").trim();
    }
    const section = await page.locator(`a[href^="/dashboard/checkin?class="]`).evaluateAll((els) => els.map((e) => e.innerText).join(" | "));
    await card0(page);
    await shot(page, `dashboard-coach-name-${tag}`);
    const named = CLASSES.every((c) => cards[c.name].includes(c.name) && cards[c.name].includes(c.want));
    L.check(`K@${tag}`, "Today's Classes: the linked staff coach's name, the typed name, and 'No coach assigned' for the class with neither",
      named, cards);
    L.check(`K@${tag}`, "no card says 'TBC' or carries the amber 'Needs coach' pill",
      !/TBC|Needs coach/.test(section) && !/Needs coach/.test(await page.locator("main").innerText()), { cards: Object.values(cards) });
    await ctx.close();
  }
} catch (e) {
  if (lastPage && !lastPage.isClosed()) await shot(lastPage, "dashboard-coach-name-failure").catch(() => {});
  L.check("run", "ran to the end", false, { stage, error: String(e).split("\n")[0].slice(0, 200) });
} finally {
  await browser.close().catch(() => {});
  await cleanup();
  const left = Number((await q(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = any($2)`, [t, CLASSES.map((c) => c.name)]))[0].n);
  L.check("cleanup", "the three classes and their sessions are removed", left === 0, { left });
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}

/** Bring the Today's Classes card into view for the picture. */
async function card0(page) {
  await page.locator(`a[href="/dashboard/checkin?class=${inst[CLASSES[0].name]}"]`).first().scrollIntoViewIfNeeded().catch(() => {});
}
