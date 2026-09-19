import { test, expect, type Browser, type Page } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId, createMember, cleanupRun } from "../helpers/db";

/**
 * "Sign In to Class" on /member/home, followed all the way to the row it does
 * or does not write.
 *
 * `tests/e2e/member/home.spec.ts` asserted the BUTTON EXISTS. Nothing anywhere
 * asserted that pressing it checks anyone in, that an uncovered member is told
 * the truth rather than shown a success tick, or that a class-pack credit is
 * actually spent. All three are money or trust.
 *
 * Runs as a member this spec creates and logs in as — NOT the shared seeded
 * member — because the assertions depend on that member having no subscription
 * and no pack, and mutating the seeded member would break every other lane.
 */

const CLASS_START = "00:00";
const CLASS_END = "23:59";
const NO_COVERAGE_COPY = /No active membership or class pack credits/i;

let tenantId: string;
let classId: string;
let scheduleId: string;
let classInstanceId: string;
let memberId: string;
let memberEmail: string;
let memberPackId: string | null = null;

/** Log in through the real form — the member has a password, like any member. */
async function loginAsRunMember(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto("/login?club=totalbjj");
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", memberEmail);
  await page.fill("input[type='password']", "password123");
  await page.click("button[type='submit']");
  await page.waitForURL(/\/member/, { timeout: 45_000 });
  return page;
}

async function openSignInSheet(page: Page): Promise<void> {
  await page.goto("/member/home", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: /Sign In to Class/i })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /Sign In to Class/i }).click();
  await expect(page.getByRole("heading", { name: /Sign in to a class/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: new RegExp(`${RUN_STAMP} self class`, "i") }).click();
}

async function attendance() {
  return sql<{ id: string; checkInMethod: string }>(
    'SELECT id, "checkInMethod" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
    [memberId, classInstanceId],
  );
}

test.beforeAll(async ({}, workerInfo) => {
  tenantId = await seededTenantId();
  // Each project (chromium-member / Mobile Chrome member) gets its own member
  // and its own class instance — otherwise the two runs race for the same
  // unique [memberId, classInstanceId] and the loser reads as a product defect.
  const lane = workerInfo.project.name.replace(/[^a-z0-9]/gi, "").toLowerCase();

  const member = await createMember({ name: `Selfcheck ${lane} ${RUN_STAMP}` });
  memberId = member.id;
  memberEmail = member.email;
  // Borrow the seeded password hash (every seeded account is `password123`) so
  // the member can use the real login form. No subscription, no pack.
  await sql(
    `UPDATE "Member"
        SET "passwordHash" = (SELECT "passwordHash" FROM "Member" WHERE "tenantId" = $2 AND email = 'jordan@example.com'),
            "onboardingCompleted" = true,
            "waiverAccepted" = true,
            "membershipType" = 'monthly',
            "stripeSubscriptionId" = NULL
      WHERE id = $1`,
    [memberId, tenantId],
  );

  const now = new Date();
  const todayUtcMidnight = new Date(`${now.toISOString().split("T")[0]}T00:00:00.000Z`);

  const cls = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "isActive", "location", "coachName")
     VALUES (gen_random_uuid()::text, $1, $2, 1439, true, 'Mat 1', 'Self Campaign')
     RETURNING id`,
    [tenantId, `${RUN_STAMP} self class ${lane}`],
  );
  classId = cls[0].id;

  const sched = await sql<{ id: string }>(
    `INSERT INTO "ClassSchedule" ("id", "classId", "dayOfWeek", "startTime", "endTime", "isActive")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true)
     RETURNING id`,
    [classId, now.getDay(), CLASS_START, CLASS_END],
  );
  scheduleId = sched[0].id;

  const inst = await sql<{ id: string }>(
    `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, false)
     RETURNING id`,
    [classId, todayUtcMidnight, CLASS_START, CLASS_END],
  );
  classInstanceId = inst[0].id;
});

test.afterAll(async () => {
  await cleanupRun();
  if (classInstanceId) {
    await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" = $1', [classInstanceId]);
    await sql('DELETE FROM "ClassInstance" WHERE id = $1', [classInstanceId]);
  }
  if (scheduleId) await sql('DELETE FROM "ClassSchedule" WHERE id = $1', [scheduleId]);
  if (classId) await sql('DELETE FROM "Class" WHERE id = $1', [classId]);
});

test.describe.configure({ mode: "serial" });

test("an uncovered member is told why, not shown a tick", async ({ browser }) => {
  test.setTimeout(150_000);
  const page = await loginAsRunMember(browser);
  try {
    await openSignInSheet(page);
    await page.getByRole("button", { name: /Confirm Sign In/i }).click();

    // The copy, not the status. 402 rendered as "Signed in!" is exactly the
    // failure mode this campaign exists to catch.
    await expect(page.getByRole("alert"), "the member was not told why they could not sign in").toContainText(
      NO_COVERAGE_COPY,
      { timeout: 20_000 },
    );
    await expect(page.getByText(/^Signed in!$/)).toHaveCount(0);

    expect(await attendance(), "an uncovered member was checked in anyway").toHaveLength(0);
  } finally {
    await page.context().close();
  }
});

test("a class-pack credit is spent, once, and recorded as a redemption", async ({ browser }) => {
  test.setTimeout(150_000);

  const packRows = await sql<{ id: string }>('SELECT id FROM "ClassPack" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
  test.skip(packRows.length === 0, "no ClassPack on the seeded tenant to hang a MemberClassPack from");

  const created = await sql<{ id: string }>(
    `INSERT INTO "MemberClassPack" ("id", "tenantId", "memberId", "packId", "creditsRemaining",
                                     "purchasedAt", "expiresAt", "status")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 3, now(), now() + interval '30 days', 'active')
     RETURNING id`,
    [tenantId, memberId, packRows[0].id],
  );
  memberPackId = created[0].id;

  const page = await loginAsRunMember(browser);
  try {
    await openSignInSheet(page);
    await page.getByRole("button", { name: /Confirm Sign In/i }).click();

    await expect(page.getByText(/^Signed in!$/), "the member was not told they were signed in").toBeVisible({
      timeout: 20_000,
    });

    const records = await attendance();
    expect(records, "no AttendanceRecord was written for the self check-in").toHaveLength(1);
    expect(records[0].checkInMethod, "the row was not stamped as a self check-in").toBe("self");

    const after = await sql<{ creditsRemaining: number }>(
      'SELECT "creditsRemaining" FROM "MemberClassPack" WHERE id = $1',
      [memberPackId],
    );
    expect(after[0].creditsRemaining, "the class-pack credit was not spent").toBe(2);

    const redemptions = await sql<{ id: string; attendanceRecordId: string }>(
      'SELECT id, "attendanceRecordId" FROM "ClassPackRedemption" WHERE "memberPackId" = $1',
      [memberPackId],
    );
    expect(redemptions, "the credit was taken without a redemption row to account for it").toHaveLength(1);
    expect(redemptions[0].attendanceRecordId).toBe(records[0].id);
  } finally {
    await page.context().close();
  }
});
