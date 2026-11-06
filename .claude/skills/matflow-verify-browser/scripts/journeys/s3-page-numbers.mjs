// Journey: S3 "fewer database round trips" (6 Nov 2026) — the numbers on the dashboard, Reports, the timetable and
// Attendance are unchanged. S3 changed only how those pages READ: one transaction per page, and one aggregate
// statement where there were many COUNTs. So the acceptance is: on the same seeded club, every figure a person sees
// is what the build before S3 showed.
//
// How: seeds a known club (members of every population, live / paused classes on two mats, 60 days of sessions with
// MatFlow check-ins for the last 30 and imported history before that, so the At-Risk gate is open), signs in as the
// owner, and records the visible text of each page (desktop) with times-of-day and the club's name normalised. It
// writes that snapshot to the output folder under the build's commit. With S3_COMPARE=<snapshot file of another
// build> it checks every page against it, line by line. Run it on the base build, then on S3's build with S3_COMPARE
// pointing at the base snapshot.
// Independently of the other build it checks the Attendance summary against SQL, every page at 390 px for sideways
// scroll, the timetable's mats columns, and no uncaught page errors. Read-only change: there is no save to fail or
// retry here, so the failed-save and retry checks of the template do not apply.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/s3-page-numbers.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("s3-page-numbers");
const OUT = path.dirname(L.path);
const tenantId = club.tenantId;
const errors = [];
const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim().slice(0, 8);

// ── Seed (ids carry the fixture slug, so a teardown of the club removes them) ──────────────────────────────────────
const P = `${club.slug}-s3`;
const now = new Date();
const DAY = 86_400_000;
const at = (daysAgo, hour = 18, minute = 0) => {
  const d = new Date(now.getTime() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
};
await q(`insert into "ImportJob" (id, "tenantId", "createdById", source, "fileName", "fileBlobUrl", status) values ($1, $2, 'journey', 'teamup', 's3.csv', 'none', 'complete')`, [`${P}-job`, tenantId]);
await q(`insert into "Mat" (id, "tenantId", name, "nameKey", "sortOrder", "updatedAt") values ($1, $3, 'Mat A', 'mat a', 0, now()), ($2, $3, 'Mat B', 'mat b', 1, now())`, [`${P}-mat-a`, `${P}-mat-b`, tenantId]);
await q(`insert into "MembershipTier" (id, "tenantId", name, "updatedAt") values ($1, $2, 'S3 Unlimited', now())`, [`${P}-tier`, tenantId]);
const KINDS = [
  { status: "active", type: "adult" },
  { status: "active", type: "kids" },
  { status: "taster", type: "adult" },
  { status: "inactive", type: "adult" },
  { status: "active", type: "parent" },
  { status: "cancelled", type: "adult" },
  { status: "active", type: "junior" },
];
const members = [];
for (let i = 0; i < 21; i += 1) {
  const k = KINDS[i % KINDS.length];
  const id = `${P}-m${String(i).padStart(2, "0")}`;
  members.push(id);
  const joined = i % 5 === 0 ? at(2) : at(300);
  const phone = i % 3 === 0 ? null : i % 3 === 1 ? "" : `07700 9${String(i).padStart(5, "0")}`;
  await q(
    `insert into "Member" (id, "tenantId", email, name, status, "accountType", phone, "waiverAccepted", "joinedAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [id, tenantId, `${id}@example.test`, `S3 Member ${String(i).padStart(2, "0")}`, k.status, k.type, phone, i % 2 === 0, joined],
  );
}
const classes = [
  { id: `${P}-c-gi`, name: "S3 Gi", mat: `${P}-mat-a`, loc: "Mat A", kids: false },
  { id: `${P}-c-nogi`, name: "S3 No-Gi", mat: `${P}-mat-b`, loc: "Mat B", kids: false },
  { id: `${P}-c-kids`, name: "S3 Kids", mat: `${P}-mat-a`, loc: "Mat A", kids: true },
];
for (const c of classes) {
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity", "matId", location, "isKids") values ($1, $2, $3, 60, 12, $4, $5, $6)`, [c.id, tenantId, c.name, c.mat, c.loc, c.kids]);
}
await q(`insert into "Class" (id, "tenantId", name, duration, "isActive") values ($1, $2, 'S3 Paused', 60, false)`, [`${P}-c-paused`, tenantId]);
for (const [i, c] of classes.entries()) {
  await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, '18:00', '19:00'), ($4, $2, $5, '19:15', '20:15')`, [`${c.id}-s1`, c.id, (i % 5) + 1, `${c.id}-s2`, ((i + 2) % 5) + 1]);
}
// 60 days of sessions, one class a day in rotation; the last 30 days are MatFlow check-ins, the 30 before imported.
let checkIns = 0;
for (let d = 0; d < 60; d += 1) {
  const c = classes[d % 3];
  const when = at(d, 18);
  const inst = `${P}-i${String(d).padStart(2, "0")}`;
  const day = new Date(Date.UTC(when.getFullYear(), when.getMonth(), when.getDate()));
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '18:00', '19:00')`, [inst, c.id, day]);
  const imported = d >= 30;
  const rows = [];
  const params = [];
  for (let m = 0; m < members.length; m += 1) {
    if ((m + d) % 4 !== 0) continue;
    const n = params.length;
    rows.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, $${n + 7})`);
    params.push(`${inst}-r${m}`, tenantId, members[m], inst, new Date(when.getTime() + m * 60_000), imported ? "import" : m % 2 ? "kiosk" : "admin", imported ? `${P}-job` : null);
  }
  if (rows.length) {
    await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod", "importJobId") values ${rows.join(", ")}`, params);
    checkIns += rows.length;
  }
}
L.note("seed", "S0 seeded the club", { members: members.length, classes: classes.length + 1, checkIns });

// The Attendance summary's windows, as app/dashboard/attendance/page.tsx draws them (the server's zone; the server is
// this machine).
const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
const weekStart = new Date(now);
weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
weekStart.setHours(0, 0, 0, 0);
const [exp] = await q(
  `select count(*) filter (where "checkInTime" >= $2)::int as month, count(*) filter (where "checkInTime" >= $3)::int as week,
          count(distinct "memberId") filter (where "checkInTime" >= $2)::int as uniq
     from "AttendanceRecord" where "tenantId" = $1`,
  [tenantId, monthStart, weekStart],
);

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const PAGES = [
  "/dashboard",
  "/dashboard/reports",
  "/dashboard/reports?period=3m",
  `/dashboard/reports?period=3m&ageGroup=kids&classId=${encodeURIComponent(`${P}-c-kids`)}`,
  "/dashboard/reports?period=12m&ageGroup=adult",
  "/dashboard/timetable",
  "/dashboard/attendance",
];
const normalise = (text) =>
  text
    .replaceAll(club.name ?? "\u0000", "<club>")
    .replaceAll(club.slug, "<slug>")
    .replace(/\b(As of|Updated|Generated|Last updated)\b[^\n]*/g, "$1 <time>")
    .replace(/^Good (morning|afternoon|evening)[^\n]*$/gm, "<greeting>")
    .replace(/\b\d+ (second|minute|hour)s? ago\b/g, "<ago>")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const browser = await chromium.launch();
const snapshot = {};
try {
  const ctx = await context(browser, "10.93.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  for (const url of PAGES) {
    const res = await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => {});
    const main = page.locator("main");
    await main.waitFor();
    const text = await main.innerText();
    snapshot[url] = normalise(text);
    L.check("journey", `J2 ${url} renders (HTTP ${res?.status()}) with no error page`, (res?.status() ?? 0) < 400 && !/Something went wrong|Couldn.t load/i.test(text), `${snapshot[url].length} lines`);
    await shot(page, `s3-${url.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`);
  }

  // Attendance summary against SQL (independent of the other build).
  await page.goto("/dashboard/attendance");
  const card = async (label) => (await page.getByText(label, { exact: true }).first().locator("xpath=..").innerText()).replace(/\s+/g, " ");
  const month = await card("This Month");
  const week = await card("This Week");
  const uniq = await card("Members who trained");
  L.check("numbers", "N1 Attendance 'This Month' is the check-ins since the month start (SQL)", month.includes(String(exp.month)), { shown: month, sql: exp.month });
  L.check("numbers", "N2 Attendance 'This Week' is the check-ins since Monday (SQL)", week.includes(String(exp.week)), { shown: week, sql: exp.week });
  L.check("numbers", "N3 Attendance 'Members who trained' is the distinct members this month (SQL)", uniq.includes(String(exp.uniq)), { shown: uniq, sql: exp.uniq });

  // Timetable: the mats read (now in the page's one transaction) reached the page.
  await page.goto("/dashboard/timetable");
  await page.waitForLoadState("networkidle").catch(() => {});
  const tt = await page.locator("main").innerText();
  L.check("numbers", "N4 timetable shows the seeded classes and no 'mats could not be loaded' line", tt.includes("S3 Gi") && tt.includes("S3 Kids") && !/mats could not be loaded|couldn.t load the mats/i.test(tt), "classes present");

  // Phone width.
  const phone = await context(browser, "10.93.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const url of ["/dashboard", "/dashboard/reports", "/dashboard/timetable", "/dashboard/attendance"]) {
    await p2.goto(url);
    await p2.waitForLoadState("load");
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", `M1 ${url} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `s3-mobile${url.replace(/\//g, "-")}`);
  }
} finally {
  await browser.close();
}

const file = path.join(OUT, `s3-page-numbers-${head}.json`);
fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
L.note("snapshot", "S1 page text written", file);

const compareWith = process.env.S3_COMPARE;
if (compareWith) {
  const other = JSON.parse(fs.readFileSync(compareWith, "utf8"));
  for (const url of PAGES) {
    const a = other[url] ?? [];
    const b = snapshot[url] ?? [];
    const firstDiff = a.findIndex((line, i) => line !== b[i]);
    const same = a.length === b.length && firstDiff === -1;
    const at = firstDiff === -1 ? Math.min(a.length, b.length) : firstDiff;
    L.check("unchanged", `U1 ${url}: every line, every number as on the other build (${path.basename(compareWith)})`, same, same ? `${b.length} lines identical` : { line: at, before: a[at] ?? "(none)", after: b[at] ?? "(none)" });
  }
} else {
  L.note("unchanged", "U0 no S3_COMPARE given: snapshot only", file);
}
L.check("journey", "J3 no uncaught page errors", errors.length === 0, errors);
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
