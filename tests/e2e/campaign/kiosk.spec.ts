import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId, createMember, cleanupRun } from "./helpers/db";

/**
 * The iPad at the front desk, driven the way a member drives it.
 *
 * The kiosk is the surface a gym owner is sold ("this runs on the tablet by the
 * door") and it had NO end-to-end coverage of any kind: not the check-in tap,
 * not the kid picker, not the waiver gate. Every assertion here is therefore a
 * DATABASE consequence or rendered copy — never a status code, because the one
 * thing this codebase has repeatedly done is report success on failure.
 *
 * The kiosk URL token IS the credential, so every kiosk page below runs in an
 * ANONYMOUS context (no storage state) even though the spec file is collected
 * by the owner-authenticated `chromium` project — a kiosk that only worked
 * because a staff cookie happened to be present would be a hole, not a pass.
 * The token is obtained the way the product obtains it: the owner posts to
 * /api/settings/kiosk, which is the only time the raw token ever leaves the
 * server (it is stored as Tenant.kioskTokenHash).
 */

// A full-day class instance is created for today so the kiosk's time-window
// gate (enforceTimeWindow: true for method "kiosk") is open whenever this spec
// runs. Anything narrower would make the suite fail by clock, not by defect.
const CLASS_START = "00:00";
const CLASS_END = "23:59";

let kioskToken: string;
let tenantId: string;
let classId: string;
let scheduleId: string;
let classInstanceId: string;
let createdClassPackId: string | null = null;

/** A distinctive two-letter stem so a 2-char kiosk search finds our rows. */
const STEM = "Zq";

async function mintKioskToken(browser: Browser): Promise<string> {
  const ctx = await browser.newContext({ storageState: "tests/e2e/.auth/owner.json" });
  const page = await ctx.newPage();
  try {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const post = (body: unknown) =>
      page.evaluate(async (b) => {
        const res = await fetch("/api/settings/kiosk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(b),
        });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      }, body);

    let res = await post({ action: "enable" });
    // 409 === already enabled. The raw token is never returned twice, so the
    // only way to hold one is to mint a new one.
    if (res.status === 409) res = await post({ action: "regenerate" });
    const raw = res.json.rawToken;
    if (typeof raw !== "string") {
      throw new Error(`could not mint a kiosk token (status ${res.status}): ${JSON.stringify(res.json)}`);
    }
    return raw;
  } finally {
    await ctx.close();
  }
}

/** Anonymous — the kiosk gets no session, ever. */
async function kioskContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/** Open the kiosk, pick our run's class, and land on the name-entry step. */
async function openKioskAtClass(page: Page): Promise<void> {
  await page.goto(`/kiosk/${kioskToken}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Pick your class" })).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: new RegExp(`${RUN_STAMP} kiosk class`, "i") }).click();
  await expect(page.getByLabel("Search your name")).toBeVisible({ timeout: 15_000 });
}

/**
 * The tenant may or may not have a ClassPack product seeded. Skipping on its
 * absence would leave the expired-coverage rule permanently unasserted, so the
 * spec creates one and removes it again in afterAll.
 */
async function ensureClassPack(): Promise<Array<{ id: string }>> {
  const existing = await sql<{ id: string }>('SELECT id FROM "ClassPack" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
  if (existing.length > 0) return existing;
  const created = await sql<{ id: string }>(
    `INSERT INTO "ClassPack" ("id", "tenantId", "name", "totalCredits", "validityDays", "pricePence", "isActive", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, 10, 60, 8000, false, now())
     RETURNING id`,
    [tenantId, `${RUN_STAMP} pack`],
  );
  createdClassPackId = created[0].id;
  return created;
}

async function attendanceFor(memberId: string) {
  return sql<{ id: string; checkInMethod: string }>(
    'SELECT id, "checkInMethod" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
    [memberId, classInstanceId],
  );
}

test.beforeAll(async ({ browser }) => {
  tenantId = await seededTenantId();
  kioskToken = await mintKioskToken(browser);

  // Today, both as the browser sees it (dayOfWeek) and as ClassInstance.date
  // is stored (UTC midnight — lib/class-time reads the calendar day from the
  // UTC components, and /api/member/schedule filters on a UTC day boundary).
  const now = new Date();
  const todayUtcMidnight = new Date(`${now.toISOString().split("T")[0]}T00:00:00.000Z`);

  const cls = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "isActive", "location", "coachName")
     VALUES (gen_random_uuid()::text, $1, $2, 1439, true, 'Mat 1', 'Kiosk Campaign')
     RETURNING id`,
    [tenantId, `${RUN_STAMP} kiosk class`],
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
  // Members / attendance / packs first (cleanupRun sweeps by RUN_STAMP), then
  // the scaffolding it deliberately refuses to touch.
  await cleanupRun();
  if (classInstanceId) await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" = $1', [classInstanceId]);
  if (classInstanceId) await sql('DELETE FROM "ClassInstance" WHERE id = $1', [classInstanceId]);
  if (scheduleId) await sql('DELETE FROM "ClassSchedule" WHERE id = $1', [scheduleId]);
  if (classId) await sql('DELETE FROM "Class" WHERE id = $1', [classId]);
  if (createdClassPackId) {
    await sql('DELETE FROM "ClassPackRedemption" WHERE "memberPackId" IN (SELECT id FROM "MemberClassPack" WHERE "packId" = $1)', [createdClassPackId]);
    await sql('DELETE FROM "MemberClassPack" WHERE "packId" = $1', [createdClassPackId]);
    await sql('DELETE FROM "ClassPack" WHERE id = $1', [createdClassPackId]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The roster lookup renders — and still leaks nothing
// ─────────────────────────────────────────────────────────────────────────────

test("a two-character search lists the member, and the payload carries no PII", async ({ browser }) => {
  test.setTimeout(120_000);
  const parent = await createMember({ name: `${STEM}aida Leakcheck ${RUN_STAMP}` });
  const dob = "2015-04-09";
  await sql('UPDATE "Member" SET "waiverAccepted" = true, "membershipType" = $2, "phone" = $3 WHERE id = $1', [
    parent.id,
    "monthly",
    "07700900123",
  ]);
  const kid = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "accountType",
                            "parentMemberId", "dateOfBirth", "waiverAccepted", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'kids', $4, $5, true, now(), now())
     RETURNING id`,
    [tenantId, `${STEM}aidas Kid ${RUN_STAMP}`, `${RUN_STAMP}-leakkid@example.test`, parent.id, new Date(`${dob}T00:00:00.000Z`)],
  );

  const ctx = await kioskContext(browser);
  const page = await ctx.newPage();
  try {
    await openKioskAtClass(page);

    const waitForLookup = page.waitForResponse(
      (r) => r.url().includes("/members?q=") && r.url().includes("/api/kiosk/") && r.status() === 200,
      { timeout: 20_000 },
    );
    await page.getByLabel("Search your name").fill(STEM);
    const body = await (await waitForLookup).text();

    // It listed them. The member is in the payload by name…
    expect(body, "the two-character search did not return the run member").toContain(
      `${STEM}aida Leakcheck ${RUN_STAMP}`,
    );

    // …and NOTHING else about them. Commit 7eed7fd removed minors' dateOfBirth
    // from this unauthenticated endpoint; this is the regression guard that it
    // stayed removed, alongside the email/phone that were never meant to be here.
    expect(body, "kiosk lookup is sending dateOfBirth again").not.toContain("dateOfBirth");
    expect(body, "kiosk lookup is sending a minor's date of birth").not.toContain(dob);
    expect(body, "kiosk lookup is sending a member email").not.toContain(parent.email);
    expect(body, "kiosk lookup is sending a member email").not.toContain("@example.test");
    expect(body, "kiosk lookup is sending a phone number").not.toContain("07700900123");

    // The derived age IS allowed — it is what the picker renders.
    expect(JSON.parse(body)).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({ name: `${STEM}aida Leakcheck ${RUN_STAMP}` }),
      ]),
    });
  } finally {
    await ctx.close();
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = ANY($1)', [[kid[0].id, parent.id]]);
    await sql('DELETE FROM "Member" WHERE id = $1', [kid[0].id]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The tap writes exactly one attendance row — and a second tap does not
//    produce a second one, nor a red error screen
// ─────────────────────────────────────────────────────────────────────────────

test("tapping a member records one kiosk check-in, and tapping again says so without an error", async ({ browser }) => {
  test.setTimeout(120_000);
  const name = `${STEM}enon Doubletap ${RUN_STAMP}`;
  const member = await createMember({ name });
  await sql('UPDATE "Member" SET "waiverAccepted" = true WHERE id = $1', [member.id]);

  const ctx = await kioskContext(browser);
  const page = await ctx.newPage();
  try {
    await openKioskAtClass(page);
    await page.getByLabel("Search your name").fill(name);

    // Exactly one match auto-fires the check-in (AUTO_FIRE_DELAY_MS).
    await expect(page.getByRole("heading", { name: /Welcome, /i })).toBeVisible({ timeout: 25_000 });

    const first = await attendanceFor(member.id);
    expect(first, "the kiosk tap did not write an AttendanceRecord").toHaveLength(1);
    expect(first[0].checkInMethod, "the row was not stamped as a kiosk check-in").toBe("kiosk");

    // Back to the class picker after the celebration, then do it again.
    await expect(page.getByRole("heading", { name: "Pick your class" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: new RegExp(`${RUN_STAMP} kiosk class`, "i") }).click();
    await page.getByLabel("Search your name").fill(name);

    // The unique index ([memberId, classInstanceId]) means the second attempt
    // cannot write a row. What the member must NOT see is the red "Couldn't
    // check you in" panel: they ARE checked in, and telling them otherwise at
    // the door is the failure this asserts against.
    const body = page.locator("body");
    await expect(body).toContainText(/already signed in|already checked in/i, { timeout: 25_000 });
    // Read ONCE, at the moment that copy is on screen. A retrying
    // `toHaveCount(0)` would quietly pass the moment the error panel's own
    // 4.5 s auto-reset removed it — i.e. it would pass against the very
    // behaviour it exists to catch.
    const shownAtTheDoor = await body.innerText();
    expect(
      shownAtTheDoor,
      "a second tap showed the member an error screen although they are checked in",
    ).not.toMatch(/Couldn.t check you in/i);

    const second = await attendanceFor(member.id);
    expect(second, "the second tap wrote a duplicate attendance row").toHaveLength(1);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A parent's tap offers the kid, and the kid's row is the one written
// ─────────────────────────────────────────────────────────────────────────────

test("a parent tap offers the linked kid, and checking the kid in records the KID", async ({ browser }) => {
  test.setTimeout(120_000);
  const parentName = `${STEM}ephyr Parent ${RUN_STAMP}`;
  const kidName = `${STEM}ephyr Junior ${RUN_STAMP}`;
  const parent = await createMember({ name: parentName });
  await sql('UPDATE "Member" SET "waiverAccepted" = true, "membershipType" = $2 WHERE id = $1', [
    parent.id,
    "monthly",
  ]);
  // Written the way app/api/member/children/route.ts writes a kid: synthetic
  // email, accountType "kids", parentMemberId set, no password.
  const kidRows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "accountType",
                            "parentMemberId", "dateOfBirth", "waiverAccepted", "onboardingCompleted",
                            "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', 'kids', $4, $5, true, true, now(), now())
     RETURNING id`,
    [tenantId, kidName, `${RUN_STAMP}-kid@example.test`, parent.id, new Date("2016-06-01T00:00:00.000Z")],
  );
  const kidId = kidRows[0].id;

  const ctx = await kioskContext(browser);
  const page = await ctx.newPage();
  try {
    await openKioskAtClass(page);
    await page.getByLabel("Search your name").fill(parentName);

    // The parent has a linked kid, so the tap must NOT fire a check-in — it
    // must ask who is training.
    await expect(page.getByRole("heading", { name: /Who.s training today\?/i })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole("button", { name: new RegExp(kidName, "i") })).toBeVisible();

    await page.getByRole("button", { name: new RegExp(kidName, "i") }).click();
    await page.getByRole("button", { name: /^Sign in 1$/ }).click();

    await expect(page.getByRole("heading", { name: /Welcome, /i })).toBeVisible({ timeout: 25_000 });

    const kidRecords = await attendanceFor(kidId);
    expect(kidRecords, "the kid was not checked in").toHaveLength(1);
    expect(kidRecords[0].checkInMethod).toBe("kiosk");

    const parentRecords = await attendanceFor(parent.id);
    expect(parentRecords, "the PARENT was checked in instead of / as well as the kid").toHaveLength(0);
  } finally {
    await ctx.close();
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [kidId]);
    await sql('DELETE FROM "Member" WHERE id = $1', [kidId]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The waiver gate has to survive long enough to be used
// ─────────────────────────────────────────────────────────────────────────────

test("the waiver gate is still on screen after 60 seconds", async ({ browser }) => {
  // The gate's whole purpose is: send a link, the member opens their email on
  // their phone, signs, and the kiosk advances by itself. That takes minutes.
  test.setTimeout(180_000);

  const name = `${STEM}ulu Nowaiver ${RUN_STAMP}`;
  const member = await createMember({ name });
  // waiverAccepted defaults false — deliberately left alone.
  expect((await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [member.id]))[0]
    .waiverAccepted).toBe(false);

  const ctx = await kioskContext(browser);
  const page = await ctx.newPage();
  try {
    await openKioskAtClass(page);
    await page.getByLabel("Search your name").fill(name);

    await expect(page.getByRole("heading", { name: "Waiver required" })).toBeVisible({ timeout: 25_000 });

    // Sixty seconds of a member walking to their phone. Not a timeout being
    // waited out — the gate is supposed to persist, so this is the assertion.
    await page.waitForTimeout(62_000);

    await expect(
      page.getByRole("heading", { name: "Waiver required" }),
      "the waiver gate reset itself while the member was still fetching their phone",
    ).toBeVisible();

    // And it never let them in.
    expect(await attendanceFor(member.id), "an unsigned member was checked in").toHaveLength(0);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. An expired pack still gets you through the door, and is not charged
// ─────────────────────────────────────────────────────────────────────────────

test("a member whose only coverage has expired is still admitted, and no credit is taken", async ({ browser }) => {
  test.setTimeout(120_000);
  const name = `${STEM}ander Expiredpack ${RUN_STAMP}`;
  const member = await createMember({ name });
  await sql('UPDATE "Member" SET "waiverAccepted" = true WHERE id = $1', [member.id]);

  const packRows = await ensureClassPack();
  const memberPack = await sql<{ id: string }>(
    `INSERT INTO "MemberClassPack" ("id", "tenantId", "memberId", "packId", "creditsRemaining",
                                     "purchasedAt", "expiresAt", "status")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 4, now() - interval '90 days', now() - interval '1 day', 'active')
     RETURNING id`,
    [tenantId, member.id, packRows[0].id],
  );

  const ctx = await kioskContext(browser);
  const page = await ctx.newPage();
  try {
    await openKioskAtClass(page);
    await page.getByLabel("Search your name").fill(name);

    // requireCoverage: false — the kiosk is deliberately forgiving; the gym
    // reconciles later. The member must NOT be turned away at the door.
    await expect(page.getByRole("heading", { name: /Welcome, /i })).toBeVisible({ timeout: 25_000 });

    const records = await attendanceFor(member.id);
    expect(records, "an uncovered member was refused by the kiosk").toHaveLength(1);
    expect(records[0].checkInMethod).toBe("kiosk");

    const after = await sql<{ creditsRemaining: number }>(
      'SELECT "creditsRemaining" FROM "MemberClassPack" WHERE id = $1',
      [memberPack[0].id],
    );
    expect(after[0].creditsRemaining, "an EXPIRED pack was debited for a kiosk check-in").toBe(4);

    const redemptions = await sql<{ id: string }>(
      'SELECT id FROM "ClassPackRedemption" WHERE "memberPackId" = $1',
      [memberPack[0].id],
    );
    expect(redemptions, "an expired pack was redeemed against").toHaveLength(0);
  } finally {
    await ctx.close();
  }
});
