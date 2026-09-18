// The attendance hub, wired end to end — on a phone. Noe, 18 Sep 2026:
// "make sure everything with attendance is wired up properly and isn't just
// cosmetic." Every case here ends in a database row or a second screen, never
// a toast alone. X-9 Task 5.
//
// Fixture: one run-stamped class with a schedule for TODAY in the club's zone
// whose slot brackets "now" (start = now − 10 min, end = now + 50 min) and
// NO ClassInstance row — the hub must materialise it. Member A is booked
// (ClassSubscription), members B and C are not. A's card is printed and its
// token decoded so the same session can be scanned into. A throwaway coach
// proves the screen for the role that used to be locked out of it.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import bcrypt from "bcryptjs";
import { createMember, cleanupRun, sql, seededTenantId, auditEntriesFor, RUN_STAMP } from "./helpers/db";
import { readCardToken } from "./helpers/qr";

test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
test.describe.configure({ mode: "serial", timeout: 180_000 });

const OWNER_EMAIL = "owner@totalbjj.com";
const CLUB_SLUG = "totalbjj";
const PASSWORD = process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";
const SCOPE = `${RUN_STAMP}-hub`;
/** The seeded club's zone (prisma/seed.ts). */
const TZ = "Europe/London";

const CAMERA_STUB = `
  (() => {
    window.__scanHold = [];
    class FakeBarcodeDetector {
      static async getSupportedFormats() { return ["qr_code"]; }
      constructor() {}
      async detect() {
        return (window.__scanHold || []).map((rawValue) => ({ rawValue }));
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
  })();
`;

async function hold(page: Page, token: string | null) {
  await page.evaluate((t) => {
    (window as unknown as { __scanHold: string[] }).__scanHold = t ? [t] : [];
  }, token);
}

function scanList(page: Page) {
  return page.locator("h2:text-is('Scans') + ul > li");
}

function londonHHMM(d: Date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d)
    .replace(/^24/, "00");
}
function londonDow(d: Date) {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(d);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
}

type Member = { id: string; name: string };

type Fx = {
  tenantId: string;
  ownerUserId: string;
  classId: string;
  className: string;
  startTime: string;
  endTime: string;
  a: Member & { token: string };
  b: Member;
  c: Member;
  coach: { id: string; email: string; name: string };
  attendanceThisWeekBefore: number;
  instanceId: string | null;
};
let fx: Fx;

async function countInstances() {
  const rows = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1', [fx.classId]);
  return Number(rows[0].n);
}
async function records(memberId: string) {
  return sql<{ checkInMethod: string; checkedInById: string | null }>(
    'SELECT "checkInMethod", "checkedInById" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
    [memberId, fx.instanceId],
  );
}
function sessionButton(page: Page) {
  return page.getByRole("group", { name: "Session" }).getByRole("button", { name: `${fx.startTime} · ${fx.className}`, exact: true });
}
async function openHub(page: Page) {
  await page.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
  await sessionButton(page).click({ timeout: 60_000 });
  await expect(page.getByRole("tab", { name: "Tick names" })).toBeVisible({ timeout: 30_000 });
}
function registerRow(page: Page, name: string) {
  return page.getByRole("list", { name: "Register" }).getByRole("listitem").filter({ hasText: name });
}
async function untickWithConfirm(page: Page, name: string) {
  await page.getByRole("button", { name: `Mark ${name} absent`, exact: true }).click();
  await page.getByRole("button", { name: "Remove check-in" }).click({ timeout: 30_000 });
}

test.beforeAll(async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const tenantId = await seededTenantId();
  const owner = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, OWNER_EMAIL]);
  if (!owner[0]) throw new Error("Seeded owner is missing — run npm run seed against the test branch.");

  const now = new Date();
  const start = new Date(now.getTime() - 10 * 60_000);
  const end = new Date(now.getTime() + 50 * 60_000);
  if (londonDow(start) !== londonDow(end)) {
    throw new Error("The fixture slot straddles midnight in the club's zone — run this spec after 00:10 local.");
  }
  const startTime = londonHHMM(start);
  const endTime = londonHHMM(end);

  const className = `${SCOPE} hub`;
  const cls = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 60, true, now()) RETURNING id`,
    [tenantId, className],
  );
  const classId = cls[0].id;
  // A schedule for today's weekday in the club's zone, and NO instance row:
  // case 2 proves the hub creates it.
  await sql(
    `INSERT INTO "ClassSchedule" ("id", "classId", "dayOfWeek", "startTime", "endTime")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
    [classId, londonDow(now), startTime, endTime],
  );

  // The precondition for case 2, checked HERE, before any page has loaded:
  // the first load of the hub is what creates the row, and case 1 loads it.
  const before = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1', [classId]);
  if (Number(before[0].n) !== 0) throw new Error("the fixture class must start with no instance row");

  const a = await createMember({ name: `Campaign Hub Booked ${SCOPE}` });
  const b = await createMember({ name: `Campaign Hub Walkin ${SCOPE}` });
  const c = await createMember({ name: `Campaign Hub Coachmark ${SCOPE}` });
  await sql(
    `INSERT INTO "ClassSubscription" ("id", "memberId", "classId", "notificationsEnabled", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, true, now()) ON CONFLICT ("memberId", "classId") DO NOTHING`,
    [a.id, classId],
  );

  const suffix = Math.random().toString(36).slice(2, 8);
  const coachEmail = `${RUN_STAMP}-hubcoach-${suffix}@example.test`;
  const coachName = `Campaign Hub Coach ${suffix}`;
  const coach = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'coach', 0, now(), now()) RETURNING id`,
    [tenantId, coachEmail, coachName, bcrypt.hashSync(PASSWORD, 10)],
  );

  // Print A's card as the owner and read the token the sheet rendered; take
  // the dashboard's attendance count before anything is marked.
  const printer = await browser.newContext({ baseURL, storageState: "tests/e2e/.auth/owner.json" });
  const page = await printer.newPage();
  await page.goto(`/print/member-cards?memberId=${a.id}`, { waitUntil: "domcontentloaded" });
  const token = await readCardToken(page, a.id);
  const stats = await (await printer.request.get("/api/dashboard/stats")).json();
  await printer.close();

  fx = {
    tenantId,
    ownerUserId: owner[0].id,
    classId,
    className,
    startTime,
    endTime,
    a: { ...a, token },
    b,
    c,
    coach: { id: coach[0].id, email: coachEmail, name: coachName },
    attendanceThisWeekBefore: Number(stats.attendanceThisWeek ?? 0),
    instanceId: null,
  };
});

test.afterAll(async () => {
  if (fx?.classId) {
    await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = $1)', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = $1)', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassSubscription" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassSchedule" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = $1', [fx.classId]).catch(() => {});
  }
  await cleanupRun();
  if (fx?.coach?.id) {
    await sql('DELETE FROM "LoginEvent" WHERE "userId" = $1', [fx.coach.id]).catch(() => {});
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" = $1', [fx.coach.id]).catch(() => {});
    await sql('UPDATE "AuditLog" SET "userId" = NULL WHERE "userId" = $1', [fx.coach.id]).catch(() => {});
    await sql('DELETE FROM "User" WHERE id = $1', [fx.coach.id]).catch(() => {});
  }
});

test.beforeEach(async ({ context, page, baseURL }) => {
  await context.grantPermissions(["camera"], { origin: baseURL });
  await page.addInitScript(CAMERA_STUB);
});

test("1 · Mark Attendance is the phone's centre tab, one tap from anywhere", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  const tab = page.locator('nav[aria-label="Main navigation"] a[aria-label="Mark Attendance"]');
  await expect(tab, "Mark Attendance must be in the bottom tab bar").toBeVisible({ timeout: 60_000 });
  await expect(tab).toHaveText(/Register/);
  await tab.click();
  await expect(page).toHaveURL(/\/dashboard\/checkin/);
  await expect(page.getByRole("heading", { name: "Mark attendance", exact: true })).toBeVisible({ timeout: 60_000 });
});

test("2 · the session on now is offered with its row created on read, idempotently, and an on-now session is preselected", async ({ page }) => {
  // beforeAll proved the class had no instance row before the first load;
  // case 1's load of the hub is what created it.
  await page.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
  const mine = sessionButton(page);
  await expect(mine, "a class on the timetable must be offered without any cron or Generate").toBeVisible({ timeout: 60_000 });
  // The status reaches assistive tech through aria-describedby (the visible
  // tag is aria-hidden so the button's NAME stays "HH:MM · class").
  await expect(mine, "a slot bracketing now must read as on now").toHaveAccessibleDescription(/On now/);
  expect(await countInstances(), "listing the session must have materialised its row").toBe(1);

  // Whatever is preselected is a session on now — never the earliest of the day.
  const pressed = page.getByRole("group", { name: "Session" }).locator('button[aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toHaveAccessibleDescription(/On now/);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(sessionButton(page)).toBeVisible({ timeout: 60_000 });
  expect(await countInstances(), "a second read must not duplicate the row").toBe(1);

  const rows = await sql<{ id: string }>('SELECT id FROM "ClassInstance" WHERE "classId" = $1', [fx.classId]);
  fx.instanceId = rows[0].id;
});

test("3 · ticking a booked member is a row, and un-ticking removes exactly that row", async ({ page }) => {
  await openHub(page);
  const tick = page.getByRole("button", { name: `Mark ${fx.a.name} attended`, exact: true });
  await expect(tick, "the booked member must be on the register, unticked").toBeVisible({ timeout: 60_000 });
  await expect(registerRow(page, fx.a.name).getByText("WALK-IN", { exact: true })).toHaveCount(0);

  await tick.click();
  await expect(page.getByRole("button", { name: `Mark ${fx.a.name} absent`, exact: true })).toBeVisible({ timeout: 30_000 });
  const marked = await records(fx.a.id);
  expect(marked).toHaveLength(1);
  expect(marked[0]).toMatchObject({ checkInMethod: "admin", checkedInById: fx.ownerUserId });
  await expect
    .poll(async () => (await auditEntriesFor("attendance.mark", `${fx.instanceId}:${fx.a.id}`)).length, { timeout: 5_000 })
    .toBe(1);
  await expect(page.getByText(/1 checked in of 1 expected/)).toBeVisible();

  await untickWithConfirm(page, fx.a.name);
  await expect(tick, "a booked member stays on the register, unticked").toBeVisible({ timeout: 30_000 });
  expect(await records(fx.a.id)).toHaveLength(0);
});

test("4 · the search marks someone who is not booked, lists them as a walk-in, and the un-tick drops them", async ({ page }) => {
  await openHub(page);
  await expect(registerRow(page, fx.b.name)).toHaveCount(0);

  await page.getByLabel("Search members").fill(fx.b.name);
  // Unique match → marked after the 600 ms window → the register reloads.
  await expect(page.getByRole("button", { name: `Mark ${fx.b.name} absent`, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(registerRow(page, fx.b.name).getByText("WALK-IN", { exact: true })).toBeVisible();
  const marked = await records(fx.b.id);
  expect(marked).toHaveLength(1);
  expect(marked[0].checkInMethod).toBe("admin");

  await untickWithConfirm(page, fx.b.name);
  await expect(registerRow(page, fx.b.name), "a walk-in was on the register only because of the check-in").toHaveCount(0, { timeout: 30_000 });
  expect(await records(fx.b.id)).toHaveLength(0);
});

test("5 · the same session scans, and the tick-list reads what the scanner wrote", async ({ page }) => {
  await openHub(page);
  await page.getByRole("tab", { name: "Scan cards" }).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("button", { name: "Stop camera" })).toBeVisible({ timeout: 30_000 });

  await hold(page, fx.a.token);
  await expect(scanList(page).filter({ hasText: fx.a.name })).toContainText("Checked in", { timeout: 30_000 });
  await hold(page, null);
  const scanned = await records(fx.a.id);
  expect(scanned).toHaveLength(1);
  expect(scanned[0]).toMatchObject({ checkInMethod: "qr", checkedInById: fx.ownerUserId });

  // A re-tap of the session is a new stack: the same card is scannable again
  // and comes back as already in — still one row.
  await sessionButton(page).click();
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("button", { name: "Stop camera" })).toBeVisible({ timeout: 30_000 });
  await hold(page, fx.a.token);
  await expect(scanList(page).first()).toContainText("Already in", { timeout: 30_000 });
  await hold(page, null);
  expect(await records(fx.a.id)).toHaveLength(1);

  await page.getByRole("tab", { name: "Tick names" }).click();
  await expect(page.getByRole("button", { name: `Mark ${fx.a.name} absent`, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(registerRow(page, fx.a.name)).toContainText("QR");
});

test("6 · every reader sees the ticks", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const res = await page.request.post("/api/checkin", {
    headers: { Origin: baseURL! },
    data: { classInstanceId: fx.instanceId, memberId: fx.b.id, checkInMethod: "admin" },
  });
  expect(res.status(), await res.text()).toBe(201);

  const today = (await (await page.request.get("/api/coach/today")).json()) as Array<{ id: string; attendedCount: number }>;
  expect(today.find((s) => s.id === fx.instanceId)?.attendedCount, "/api/coach/today must count both rows").toBe(2);

  const stats = await (await page.request.get("/api/dashboard/stats")).json();
  expect(Number(stats.attendanceThisWeek), "the dashboard count must move by exactly the two rows").toBe(fx.attendanceThisWeekBefore + 2);

  await page.goto("/dashboard/attendance", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(fx.a.name).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(fx.b.name).first()).toBeVisible();

  await page.goto(`/dashboard/members/${fx.a.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: fx.a.name })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0);
});

test("7 · a coach marks from the same screen, and the old addresses land on it", async ({ browser, baseURL }) => {
  const ctx: BrowserContext = await browser.newContext({
    baseURL,
    storageState: undefined,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await ctx.clearCookies();
  const page = await ctx.newPage();
  try {
    await page.goto(`/login?club=${CLUB_SLUG}`);
    await page.waitForSelector("input[type='email']", { timeout: 45_000 });
    await page.fill("input[type='email']", fx.coach.email);
    await page.fill("input[type='password']", PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForURL(/dashboard/, { timeout: 45_000 });

    await openHub(page);
    await page.getByLabel("Search members").fill(fx.c.name);
    await expect(page.getByRole("button", { name: `Mark ${fx.c.name} absent`, exact: true })).toBeVisible({ timeout: 30_000 });
    const marked = await records(fx.c.id);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ checkInMethod: "admin", checkedInById: fx.coach.id });

    await untickWithConfirm(page, fx.c.name);
    await expect(registerRow(page, fx.c.name)).toHaveCount(0, { timeout: 30_000 });
    expect(await records(fx.c.id)).toHaveLength(0);

    await page.goto("/dashboard/scan");
    await expect(page).toHaveURL(/\/dashboard\/checkin\?mode=scan/, { timeout: 60_000 });
    await expect(page.getByRole("tab", { name: "Scan cards" })).toHaveAttribute("aria-selected", "true", { timeout: 45_000 });
    await page.goto("/dashboard/coach");
    await expect(page).toHaveURL(/\/dashboard\/checkin$/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Mark attendance", exact: true })).toBeVisible({ timeout: 45_000 });
  } finally {
    await ctx.close();
  }
});
