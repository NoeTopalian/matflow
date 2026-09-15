/**
 * Authorisation boundaries — browser-level proof for the nine role gates
 * changed in 04aebe3 / 45bb92b / 158b846.
 *
 * ## What this file is for
 *
 * Those nine changes are covered by `tests/unit/authorisation-agreements.test.ts`,
 * which greps the SOURCE for the role lists. That test proves the strings are
 * present. It cannot prove a coach's browser is actually refused, because it
 * never starts the app, never holds a session cookie and never renders a page.
 * A role gate that is correct in the file and wrong in the running app looks
 * identical to both.
 *
 * So everything here runs against the real server with a real logged-in
 * session, and asserts VISIBLE STATE:
 *   - a status code and the exact error body the route returns, or
 *   - what is on the screen and, just as importantly, what is NOT in the DOM.
 *
 * ## Why some of it goes through `request` rather than a page
 *
 * Several of the nine gates protect routes with no screen of their own
 * (`/api/checkin` as an admin tool, `totp-reset`, `unlock`, `waiver-link`,
 * `rank/demote`). For those, the browser-truthful thing is a request carrying
 * the same session cookies the browser holds — which is what
 * `context.request` is: an APIRequestContext sharing the BrowserContext's
 * cookie jar. Where a screen exists (the 2FA reset card), it is asserted on
 * the screen.
 *
 * ## Why the POSTs set an explicit Origin
 *
 * `lib/csrf.ts#assertSameOrigin` refuses any non-GET with neither Origin nor
 * Referer (403, "Origin or Referer header required for this request").
 * Playwright's APIRequestContext is not a browser and sends neither. Without
 * an explicit `Origin: <baseURL>` every POST below would 403 for a reason that
 * has nothing to do with the role gate under test — a green-looking test
 * proving nothing. The CSRF block at the bottom is the one place that sets a
 * hostile Origin on purpose.
 *
 * ## Arrangement
 *
 * `helpers/db.ts` arranges what no screen can: a class with a specific
 * `instructorId`, a member with 2FA already enrolled, and a `manager` staff
 * user (the seed has none — see NOTES-L6.md). Acting and asserting happen
 * against the running app.
 */
import { test, expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { createMember, cleanupRun, sql, seededTenantId, RUN_STAMP } from "./helpers/db";

// ── Accounts ─────────────────────────────────────────────────────────────────

const CLUB_SLUG = "totalbjj";
const OWNER_EMAIL = "owner@totalbjj.com";
const COACH_EMAIL = "coach@totalbjj.com";
const ADMIN_EMAIL = "admin@totalbjj.com";

// Same chain tests/e2e/auth.setup.ts uses, so this file logs in by exactly the
// mechanism the rest of the suite already depends on.
const PASSWORD = process.env.E2E_BYPASS_TOKEN ?? process.env.TEST_PASSWORD ?? "password123";

/**
 * Per-worker scope. `RUN_STAMP` is computed when helpers/db.ts is loaded, so
 * each Playwright worker process already has its own — but two workers booting
 * inside the same millisecond would collide on the `manager` row's
 * `@@unique([tenantId, email])`. The parallel index makes that impossible.
 */
const SCOPE = `${RUN_STAMP}-w${process.env.TEST_PARALLEL_INDEX ?? "0"}`;
const MANAGER_EMAIL = `${SCOPE}-manager@example.test`;

// Login is a cold-compile on the first navigation of a worker (~20s, see
// auth.setup.ts), and several tests below sign in as a second and third role.
test.describe.configure({ timeout: 180_000 });

// ── Session helper ───────────────────────────────────────────────────────────

/**
 * Inline login, per tests/e2e/auth.setup.ts. Only `owner` and `member` have a
 * storageState file, so coach / admin / manager must sign in for real.
 *
 * Contexts are cached for the lifetime of the worker: a fresh login per test
 * would multiply a 20s cost across eight tests for no extra signal.
 */
const sessions = new Map<string, BrowserContext>();

async function sessionFor(browser: Browser, baseURL: string, email: string): Promise<BrowserContext> {
  const cached = sessions.get(email);
  if (cached) return cached;

  const context = await browser.newContext({ baseURL, storageState: undefined });
  // Belt and braces: whether `browser.newContext()` inherits the project's
  // `use.storageState` has changed across Playwright versions, and inheriting
  // it here would silently run every "coach is refused" test as the OWNER —
  // which passes the login and fails the assertion for the wrong reason.
  await context.clearCookies();

  const page = await context.newPage();
  await page.goto("/login?club=" + CLUB_SLUG);
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", PASSWORD);
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|member/, { timeout: 45_000 });
  await page.close();

  sessions.set(email, context);
  return context;
}

// ── Request helpers ──────────────────────────────────────────────────────────

/** A POST that looks like it came from the app's own origin. */
function post(rc: APIRequestContext, url: string, origin: string, data: unknown = {}) {
  return rc.post(url, { headers: { Origin: origin }, data });
}

/** `lib/api-authz.ts` answers a role refusal with `{ ok: false, error }`. */
const FORBIDDEN_BODY = "You do not have permission to do this.";
/** `lib/csrf.ts` answers a bad Origin with this, before any auth runs. */
const CSRF_BODY = "Forbidden: cross-origin request rejected";

// ── Arranged fixtures ────────────────────────────────────────────────────────

type Fixtures = {
  tenantId: string;
  ownerUserId: string;
  coachUserId: string;
  managerUserId: string;
  /** A class whose instructorId IS the seeded coach. */
  coachClassId: string;
  coachInstanceId: string;
  /** A class whose instructorId is the OWNER — the coach does not teach it. */
  foreignClassId: string;
  foreignInstanceId: string;
  /** Coach-taught, reserved for the register screen so its counter is deterministic. */
  registerClassId: string;
  registerClassName: string;
  registerInstanceId: string;
  /** Two ranks in one discipline, so promote and demote both have somewhere to go. */
  lowRank: { id: string; name: string; discipline: string };
  highRank: { id: string; name: string; discipline: string };
  /** A member with totpEnabled = true, so the 2FA card has a reason to render. */
  totpMemberId: string;
  totpMemberName: string;
};

let fx: Fixtures;

test.beforeAll(async () => {
  const tenantId = await seededTenantId();

  const staff = await sql<{ id: string; email: string; role: string; totpEnabled: boolean; passwordHash: string }>(
    'SELECT id, email, role, "totpEnabled", "passwordHash" FROM "User" WHERE "tenantId" = $1 AND email = ANY($2)',
    [tenantId, [OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL]],
  );
  const byEmail = new Map(staff.map((u) => [u.email, u]));

  for (const email of [OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL]) {
    const row = byEmail.get(email);
    if (!row) throw new Error(`Seeded staff user ${email} is missing — run npm run seed against the test branch.`);
    // A staff user with TOTP enrolled gets a second factor step this spec does
    // not drive, and the login would hang on waitForURL. Refuse loudly rather
    // than silently clearing someone's 2FA on a shared branch.
    if (row.totpEnabled) {
      throw new Error(
        `${email} has TOTP enabled on this database. This spec logs in with a password only. ` +
          `Re-seed the test branch, or clear totpEnabled/totpSecret for the seeded staff users.`,
      );
    }
  }

  const ownerUserId = byEmail.get(OWNER_EMAIL)!.id;
  const coachUserId = byEmail.get(COACH_EMAIL)!.id;

  // The seed has no `manager`, and change #3 (GET /api/payments widened to
  // owner+manager) is only half-proved without one. Borrow the owner's
  // password hash so this user signs in with exactly the same credential the
  // rest of the suite uses, and delete it again in afterAll.
  const managerRows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "passwordHash", "name", "role", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'manager', now(), now())
     RETURNING id`,
    [tenantId, MANAGER_EMAIL, byEmail.get(OWNER_EMAIL)!.passwordHash, `Campaign Manager ${SCOPE}`],
  );
  const managerUserId = managerRows[0].id;

  // Two classes that differ in exactly one field: who teaches them.
  const mkClass = async (name: string, instructorId: string) => {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "instructorId", "isActive", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, 60, $3, true, now())
       RETURNING id`,
      [tenantId, name, instructorId],
    );
    return rows[0].id;
  };
  // `ClassInstance.date` is `timestamp(3)` WITHOUT a time zone, and Prisma
  // writes and queries it as a UTC wall clock. node-pg, handed a JS Date,
  // writes the LOCAL wall clock instead — eight hours adrift on a UTC+8
  // machine, which is enough to put the row outside the app's own
  // "today" window (app/dashboard/checkin/page.tsx builds that window from
  // local midnight and lets Prisma convert it). Casting an explicit instant
  // through `timestamptz AT TIME ZONE 'UTC'` stores exactly what Prisma would
  // have stored, so the register screen sees these instances as today's.
  const localNoonToday = new Date();
  localNoonToday.setHours(12, 0, 0, 0);
  const mkInstance = async (classId: string) => {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
       VALUES (gen_random_uuid()::text, $1, ($2::timestamptz AT TIME ZONE 'UTC'), '18:00', '19:00', false)
       RETURNING id`,
      [classId, localNoonToday.toISOString()],
    );
    return rows[0].id;
  };

  const coachClassId = await mkClass(`${SCOPE} taught-by-coach`, coachUserId);
  const foreignClassId = await mkClass(`${SCOPE} taught-by-owner`, ownerUserId);
  // A third class, touched by nothing but the register-screen test, so its
  // "N checked in" counter is deterministic (0 → 1) however the file's tests
  // are distributed across workers.
  const registerClassId = await mkClass(`${SCOPE} register-taught-by-coach`, coachUserId);
  const coachInstanceId = await mkInstance(coachClassId);
  const foreignInstanceId = await mkInstance(foreignClassId);
  const registerInstanceId = await mkInstance(registerClassId);

  // Ranks: any discipline the seed created with at least two grades.
  const ranks = await sql<{ id: string; name: string; discipline: string; order: number }>(
    `SELECT id, name, discipline, "order" FROM "RankSystem"
     WHERE "tenantId" = $1 AND "deletedAt" IS NULL
     ORDER BY discipline ASC, "order" ASC`,
    [tenantId],
  );
  const byDiscipline = new Map<string, typeof ranks>();
  for (const r of ranks) byDiscipline.set(r.discipline, [...(byDiscipline.get(r.discipline) ?? []), r]);
  const pair = [...byDiscipline.values()].find((rs) => rs.length >= 2);
  if (!pair) throw new Error("No discipline has two ranks — promote/demote cannot be exercised. Re-seed.");

  // A member with 2FA already on: the card is `totpRow?.totpEnabled && canResetTotp`,
  // so without this the owner case would be absent for the wrong reason.
  const totpMember = await createMember({ name: `Campaign TOTP ${SCOPE}` });
  await sql('UPDATE "Member" SET "totpEnabled" = true WHERE id = $1', [totpMember.id]);

  fx = {
    tenantId,
    ownerUserId,
    coachUserId,
    managerUserId,
    coachClassId,
    coachInstanceId,
    foreignClassId,
    foreignInstanceId,
    registerClassId,
    registerClassName: `${SCOPE} register-taught-by-coach`,
    registerInstanceId,
    lowRank: pair[0],
    highRank: pair[1],
    totpMemberId: totpMember.id,
    totpMemberName: totpMember.name,
  };
});

test.afterAll(async () => {
  for (const context of sessions.values()) await context.close().catch(() => {});
  sessions.clear();

  // RankHistory -> MemberRank is ON DELETE RESTRICT, and cleanupRun() deletes
  // MemberRank without touching RankHistory. The promote/demote test creates
  // those rows, so without this cleanupRun() throws a foreign-key error and
  // leaves the run's members behind for ever.
  await sql(
    `DELETE FROM "RankHistory" WHERE "memberRankId" IN (
       SELECT id FROM "MemberRank" WHERE "memberId" IN (
         SELECT id FROM "Member" WHERE email LIKE $1))`,
    [`${RUN_STAMP}-%@example.test`],
  ).catch(() => {});

  const classIds = fx ? [fx.coachClassId, fx.foreignClassId, fx.registerClassId] : [];
  if (classIds.length) {
    await sql(
      'DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))',
      [classIds],
    ).catch(() => {});
    // Before cleanupRun, not after. ClassSubscription carries a foreign key to
    // Member, and cleanupRun deletes members — so leaving this until the block
    // below would make the member delete fail on the constraint and strand the
    // whole run's rows on the shared branch. That is precisely how the test
    // branch came to carry 23 junk tenants, and the helper's own comment says
    // so: resolve children before parents.
    await sql(
      'DELETE FROM "ClassSubscription" WHERE "classId" = ANY($1)',
      [classIds],
    ).catch(() => {});
  }

  await cleanupRun();

  if (classIds.length) {
    await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = ANY($1))', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassSubscription" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "ClassRoster" WHERE "classId" = ANY($1)', [classIds]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = ANY($1)', [classIds]).catch(() => {});
  }

  if (fx?.managerUserId) {
    await sql('DELETE FROM "LoginEvent" WHERE "userId" = $1', [fx.managerUserId]).catch(() => {});
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" = $1', [fx.managerUserId]).catch(() => {});
    await sql('UPDATE "AuditLog" SET "userId" = NULL WHERE "userId" = $1', [fx.managerUserId]).catch(() => {});
    await sql('DELETE FROM "User" WHERE id = $1', [fx.managerUserId]).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. POST /api/checkin narrows a COACH to classes they teach.
//
// The most valuable test in the file: before 04aebe3 this route admitted all
// four staff roles with NO narrowing, so a coach could check ANY member into
// ANY class in the club.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("check-in is narrowed to the classes a coach teaches", () => {
  test("a coach is refused (404) on a class they do not teach", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();

    const res = await post(coach.request, "/api/checkin", baseURL!, {
      classInstanceId: fx.foreignInstanceId,
      memberId: member.id,
      checkInMethod: "admin",
    });

    // 404 not 403, deliberately — see the route's comment. A coach must not be
    // able to probe which classes exist in the club.
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe("Class not found");

    // The refusal is real, not cosmetic: nothing was written.
    const written = await sql<{ id: string }>(
      'SELECT id FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
      [member.id, fx.foreignInstanceId],
    );
    expect(written).toHaveLength(0);
  });

  test("the same coach IS allowed on a class they do teach", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();

    const res = await post(coach.request, "/api/checkin", baseURL!, {
      classInstanceId: fx.coachInstanceId,
      memberId: member.id,
      checkInMethod: "admin",
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.record.classInstanceId).toBe(fx.coachInstanceId);
    expect(body.record.memberId).toBe(member.id);

    const written = await sql<{ id: string; checkInMethod: string }>(
      'SELECT id, "checkInMethod" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
      [member.id, fx.coachInstanceId],
    );
    expect(written).toHaveLength(1);
  });

  // ── The same two cases, driven through the screen the coach actually uses ──
  //
  // **Corrected 15 Sep. The two tests here previously asserted a screen no coach
  // can open.** They drove `/dashboard/checkin` and carried the comment "the
  // class picker is NOT narrowed by instructor… so the coach is offered a class
  // the API will refuse". That premise is false:
  // `app/dashboard/checkin/page.tsx:111` gates on
  // `requireRole(["owner","manager","admin"])`, so a coach is redirected to
  // `/dashboard` before any picker renders — which is exactly what the failures
  // showed, the locator waiting on a navigation to `/dashboard`.
  //
  // The lesson is worth more than the fix. A test asserting a screen the user
  // cannot reach fails for a reason that looks like a product bug, and would
  // have been "fixed" by loosening a real authorisation gate. So these now
  // assert the truth on both sides: the owner's register REFUSES a coach, and
  // the coach's own register (`/dashboard/coach`, backed by
  // `/api/coach/today`, which narrows non-privileged roles to `instructorId`)
  // shows them their classes and nobody else's.

  test("the owner's register screen refuses a coach outright", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const page = await coach.newPage();

    try {
      await page.goto("/dashboard/checkin");

      // The redirect is the product behaving correctly: `/dashboard/checkin` is
      // the all-members register, and a coach takes their own via
      // `/dashboard/coach`. Assert the landing rather than the URL alone, so a
      // redirect to a broken page cannot pass.
      await expect(page).toHaveURL(/\/dashboard(?!\/checkin)/, { timeout: 45_000 });
      await expect(page.getByRole("heading", { name: "Mark attendance" })).toHaveCount(0);

      // And the nav does not advertise it, so the coach is not sent somewhere
      // they will be bounced from. `routes.ts:52` lists owner/manager/admin.
      await expect(page.getByRole("link", { name: "Mark Attendance" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test("the coach's own register lists their class and NOT the owner's", async ({ browser, baseURL }) => {
    // The narrowing that matters to a coach on the mat: Today's Register lists
    // only the sessions they teach. The owner-taught class exists today, in the
    // same club, at the same time, and must not appear.
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const page = await coach.newPage();

    try {
      await page.goto("/dashboard/coach");
      // CoachRegister opens on the list view (PageHeader "Today's classes"),
      // one button per class; the register itself is a second screen.
      await expect(page.getByRole("heading", { name: "Today's classes" })).toBeVisible({
        timeout: 60_000,
      });

      await expect(
        page.getByRole("button", { name: new RegExp(fx.registerClassName) }),
      ).toBeVisible({ timeout: 45_000 });

      await expect(
        page.getByText(new RegExp(`${SCOPE} taught-by-owner`)),
        "a coach must not be offered a class they do not teach",
      ).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test("the coach marks a member present on their own class, and it is really written", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember({ name: `Campaign RegisterAllowed ${SCOPE}` });

    // The register lists the class ROSTER — `/api/coach/instances/[id]/register`
    // builds `expected` from ClassSubscription — not every member in the club.
    // That is the product working as designed (a coach sees who signed up for
    // this class), so the fixture has to put the member on the roster rather
    // than the test asserting they appear without one.
    await sql(
      `INSERT INTO "ClassSubscription" ("id", "memberId", "classId", "notificationsEnabled", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, true, now())
       ON CONFLICT ("memberId", "classId") DO NOTHING`,
      [member.id, fx.registerClassId],
    );

    const page = await coach.newPage();
    try {
      await page.goto("/dashboard/coach");
      await expect(page.getByRole("heading", { name: "Today's classes" })).toBeVisible({
        timeout: 60_000,
      });
      await page.getByRole("button", { name: new RegExp(fx.registerClassName) }).click();

      // Now on the register: CoachRegister.tsx:178 renders the class as an h1.
      await expect(
        page.getByRole("heading", { name: new RegExp(fx.registerClassName) }),
      ).toBeVisible({ timeout: 45_000 });

      // CoachRegister.tsx:242 — the row toggle carries the member's name, so
      // the label is itself the assertion that the right person was marked.
      const markPresent = page.getByRole("button", { name: `Mark ${member.name} attended` });
      await expect(markPresent).toBeVisible({ timeout: 45_000 });
      await markPresent.click();

      // The durable consequence on screen: the same control now offers to undo.
      await expect(
        page.getByRole("button", { name: `Mark ${member.name} absent` }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await page.close();
    }

    const written = await sql<{ id: string }>(
      'SELECT id FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
      [member.id, fx.registerInstanceId],
    );
    expect(written, "the register said present; the database must agree").toHaveLength(1);
  });

  test("the owner is unrestricted on the very instance the coach was refused", async ({ request, baseURL }) => {
    // Control. Without it, the 404 above could equally mean "the fixture class
    // instance is broken" — which would make the narrowing test worthless.
    const member = await createMember();

    const res = await post(request, "/api/checkin", baseURL!, {
      classInstanceId: fx.foreignInstanceId,
      memberId: member.id,
      checkInMethod: "admin",
    });

    expect(res.status()).toBe(201);
    expect((await res.json()).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /api/settings is owner-only (was: readable by every staff role).
// ─────────────────────────────────────────────────────────────────────────────

test.describe("GET /api/settings is owner-only", () => {
  test("a coach is refused", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const res = await coach.request.get("/api/settings");
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toBe(FORBIDDEN_BODY);
    // The commercial standing this change was made to hide must not leak in
    // the refusal body.
    expect(body).not.toHaveProperty("subscriptionStatus");
    expect(body).not.toHaveProperty("subscriptionTier");
  });

  test("an admin is refused", async ({ browser, baseURL }) => {
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const res = await admin.request.get("/api/settings");
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);
  });

  test("the owner still gets the club's subscription standing", async ({ request }) => {
    const res = await request.get("/api/settings");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("subscriptionStatus");
    expect(body.subscriptionStatus).not.toBeNull();
    expect(body).toHaveProperty("subscriptionTier");
    // The member / staff / class counts that used to be readable by a coach.
    expect(body._count).toHaveProperty("members");
    expect(body._count).toHaveProperty("users");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /api/payments is owner+manager — matching /dashboard/payments, which
//    a manager can open. The bug: a manager opened the hub and watched its own
//    main table 403, which reads as "this club has no payments".
// ─────────────────────────────────────────────────────────────────────────────

test.describe("GET /api/payments matches the page that calls it", () => {
  test("a manager gets the payments table, not a 403", async ({ browser, baseURL }) => {
    const manager = await sessionFor(browser, baseURL!, MANAGER_EMAIL);
    const res = await manager.request.get("/api/payments");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.payments)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  test("the manager opens the hub and its own table does NOT 403", async ({ browser, baseURL }) => {
    // This is the regression in its original form. The page gate
    // (requireOwnerOrManager) and the API gate have to agree; when they did
    // not, the manager reached the screen and PaymentsPageClient's fetch threw
    // on `HTTP 403`, rendering ErrorState with the exact string asserted
    // absent below. Asserting the API alone would not have caught it.
    const manager = await sessionFor(browser, baseURL!, MANAGER_EMAIL);
    const page = await manager.newPage();
    try {
      const [apiResponse] = await Promise.all([
        page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/payments" && r.request().method() === "GET",
          { timeout: 90_000 },
        ),
        page.goto("/dashboard/payments"),
      ]);

      // The browser's own request, not a synthesised one.
      expect(apiResponse.status()).toBe(200);

      // components/ui/page-header.tsx renders the <h1>; title="Payment history".
      await expect(page.getByRole("heading", { name: "Payment history" })).toBeVisible({ timeout: 45_000 });
      // The literal ErrorState copy from PaymentsPageClient's catch branch.
      await expect(page.getByText("Couldn't load payments — tap to retry")).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test("a coach is refused", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const res = await coach.request.get("/api/payments");
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);
  });

  test("an admin is refused", async ({ browser, baseURL }) => {
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const res = await admin.request.get("/api/payments");
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 + 5. totp-reset and unlock are owner+manager (were: all staff).
//
// The pair is the point: whoever can clear a brute-force lockout AND strip the
// second factor has unlimited password guesses against a member's account.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("clearing a lockout and stripping 2FA are owner+manager", () => {
  test("a coach is refused totp-reset", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();
    await sql('UPDATE "Member" SET "totpEnabled" = true WHERE id = $1', [member.id]);

    const res = await post(coach.request, `/api/members/${member.id}/totp-reset`, baseURL!, {
      reason: "coach should not be able to do this",
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);

    // Refused in fact, not just in status: the second factor is still on.
    const after = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "Member" WHERE id = $1', [member.id]);
    expect(after[0].totpEnabled).toBe(true);
  });

  test("an admin is refused totp-reset", async ({ browser, baseURL }) => {
    // `admin` is the schema DEFAULT role and sits level with coach despite the
    // name — the narrowing excludes it deliberately.
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const member = await createMember();
    const res = await post(admin.request, `/api/members/${member.id}/totp-reset`, baseURL!, {
      reason: "admin should not be able to do this",
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);
  });

  test("the owner can still reset 2FA — the same request, one role apart", async ({ request, baseURL }) => {
    const member = await createMember();
    await sql('UPDATE "Member" SET "totpEnabled" = true WHERE id = $1', [member.id]);

    const res = await post(request, `/api/members/${member.id}/totp-reset`, baseURL!, {
      reason: "owner control for the authorisation campaign",
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const after = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "Member" WHERE id = $1', [member.id]);
    expect(after[0].totpEnabled).toBe(false);
  });

  test("the manager can reset 2FA — the other half of 'owner+manager'", async ({ browser, baseURL }) => {
    const manager = await sessionFor(browser, baseURL!, MANAGER_EMAIL);
    const member = await createMember();
    await sql('UPDATE "Member" SET "totpEnabled" = true WHERE id = $1', [member.id]);

    const res = await post(manager.request, `/api/members/${member.id}/totp-reset`, baseURL!, {
      reason: "manager control for the authorisation campaign",
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const after = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "Member" WHERE id = $1', [member.id]);
    expect(after[0].totpEnabled).toBe(false);
  });

  test("a coach is refused unlock, and the lockout survives", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();
    const lockedUntil = new Date(Date.now() + 60 * 60 * 1000);
    await sql('UPDATE "Member" SET "failedLoginCount" = 10, "lockedUntil" = $2 WHERE id = $1', [member.id, lockedUntil]);

    const res = await post(coach.request, `/api/members/${member.id}/unlock`, baseURL!, {});
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);

    const after = await sql<{ failedLoginCount: number; lockedUntil: Date | null }>(
      'SELECT "failedLoginCount", "lockedUntil" FROM "Member" WHERE id = $1',
      [member.id],
    );
    expect(after[0].failedLoginCount).toBe(10);
    expect(after[0].lockedUntil).not.toBeNull();
  });

  test("an admin is refused unlock", async ({ browser, baseURL }) => {
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const member = await createMember();
    const res = await post(admin.request, `/api/members/${member.id}/unlock`, baseURL!, {});
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);
  });

  test("the owner can still unlock", async ({ request, baseURL }) => {
    const member = await createMember();
    await sql('UPDATE "Member" SET "failedLoginCount" = 10, "lockedUntil" = $2 WHERE id = $1', [
      member.id,
      new Date(Date.now() + 60 * 60 * 1000),
    ]);

    const res = await post(request, `/api/members/${member.id}/unlock`, baseURL!, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.wasLocked).toBe(true);

    const after = await sql<{ failedLoginCount: number; lockedUntil: Date | null }>(
      'SELECT "failedLoginCount", "lockedUntil" FROM "Member" WHERE id = $1',
      [member.id],
    );
    expect(after[0].failedLoginCount).toBe(0);
    expect(after[0].lockedUntil).toBeNull();
  });

  test("the manager can unlock", async ({ browser, baseURL }) => {
    const manager = await sessionFor(browser, baseURL!, MANAGER_EMAIL);
    const member = await createMember();
    await sql('UPDATE "Member" SET "failedLoginCount" = 10, "lockedUntil" = $2 WHERE id = $1', [
      member.id,
      new Date(Date.now() + 60 * 60 * 1000),
    ]);

    const res = await post(manager.request, `/api/members/${member.id}/unlock`, baseURL!, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).wasLocked).toBe(true);

    const after = await sql<{ lockedUntil: Date | null }>('SELECT "lockedUntil" FROM "Member" WHERE id = $1', [member.id]);
    expect(after[0].lockedUntil).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The 2FA reset CARD on the member detail page is hidden unless owner/manager.
//
// The page is requireStaff(), so narrowing the API alone would have left a
// coach staring at a button that 403s.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("the 2FA reset card follows the API that backs it", () => {
  test("the owner sees the card and its button", async ({ page }) => {
    await page.goto(`/dashboard/members/${fx.totpMemberId}`);

    // The page rendered the member we asked for — asserted before anything is
    // claimed about what is or is not on it.
    await expect(page.getByRole("heading", { level: 1, name: fx.totpMemberName })).toBeVisible({ timeout: 45_000 });

    // `exact` matters: the dashboard layout also renders Recommend2FABanner,
    // whose text is "Two-factor authentication is recommended." A loose
    // substring match would find the banner on BOTH roles and prove nothing.
    await expect(page.getByText("Two-factor authentication", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset 2FA" })).toBeVisible();
  });

  test("a coach sees the member, and no card — not in the DOM at all", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const page = await coach.newPage();
    try {
      await page.goto(`/dashboard/members/${fx.totpMemberId}`);

      // The coach genuinely reached the page: same member, same heading. So
      // the absence below is a hidden card, not a redirect or an error page.
      await expect(page.getByRole("heading", { level: 1, name: fx.totpMemberName })).toBeVisible({ timeout: 45_000 });

      // toHaveCount(0), not toBeHidden: the server must not render it at all.
      await expect(page.getByText("Two-factor authentication", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Reset 2FA" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });

  test("the manager sees the card — `canResetTotp` is owner+manager, not owner-only", async ({ browser, baseURL }) => {
    const manager = await sessionFor(browser, baseURL!, MANAGER_EMAIL);
    const page = await manager.newPage();
    try {
      await page.goto(`/dashboard/members/${fx.totpMemberId}`);
      await expect(page.getByRole("heading", { level: 1, name: fx.totpMemberName })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole("button", { name: "Reset 2FA" })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test("an admin sees no card either", async ({ browser, baseURL }) => {
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const page = await admin.newPage();
    try {
      await page.goto(`/dashboard/members/${fx.totpMemberId}`);
      await expect(page.getByRole("heading", { level: 1, name: fx.totpMemberName })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole("button", { name: "Reset 2FA" })).toHaveCount(0);
    } finally {
      await page.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. promote and demote are symmetric — both STAFF_ROLES.
//
// They were DISJOINT: a coach could award a belt but not take one back, so a
// coach who graded the wrong student could not undo their own mistake.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("a coach can undo their own grading", () => {
  test("the same coach both promotes and demotes one member", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();

    const promoted = await post(coach.request, `/api/members/${member.id}/rank`, baseURL!, {
      rankSystemId: fx.highRank.id,
      stripes: 0,
      notes: "campaign promote",
    });
    expect([200, 201]).toContain(promoted.status());
    expect((await promoted.json()).rankSystem.name).toBe(fx.highRank.name);

    // The half that used to 403 for exactly this caller.
    const demoted = await post(coach.request, `/api/members/${member.id}/rank/demote`, baseURL!, {
      toRankId: fx.lowRank.id,
      reason: "campaign demote — coach undoing their own grading",
    });
    expect(demoted.status()).toBe(200);
    const body = await demoted.json();
    expect(body.ok).toBe(true);
    expect(body.memberRank.rankSystem.name).toBe(fx.lowRank.name);

    // And the member really is back at the lower grade.
    const current = await sql<{ name: string }>(
      `SELECT rs.name FROM "MemberRank" mr JOIN "RankSystem" rs ON rs.id = mr."rankSystemId"
       WHERE mr."memberId" = $1`,
      [member.id],
    );
    expect(current.map((r) => r.name)).toContain(fx.lowRank.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. members/[id]/waiver-link was widened to STAFF_ROLES — it had a LOCAL
//    two-element STAFF_ROLES shadowing the shared four-element one, which made
//    it stricter than its own more dangerous sibling (waiver/sign).
// ─────────────────────────────────────────────────────────────────────────────

test.describe("waiver-link admits every staff role", () => {
  test("a coach can mint a waiver link", async ({ browser, baseURL }) => {
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();

    const res = await post(coach.request, `/api/members/${member.id}/waiver-link`, baseURL!, {});
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.url).toBe("string");
    expect(body.url).toContain("/waiver/open?token=");
    expect(typeof body.expiresAt).toBe("string");
  });

  test("an admin can mint a waiver link too", async ({ browser, baseURL }) => {
    const admin = await sessionFor(browser, baseURL!, ADMIN_EMAIL);
    const member = await createMember();
    const res = await post(admin.request, `/api/members/${member.id}/waiver-link`, baseURL!, {});
    expect(res.status()).toBe(200);
    expect((await res.json()).url).toContain("/waiver/open?token=");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Five routes gained CSRF guards.
//
// Every one of them runs assertSameOrigin as the FIRST statement in the
// handler, before any auth gate — so the caller below is the OWNER, who is
// authorised for all five. A 403 from an authorised caller can only be the
// origin check. The body string makes that unambiguous.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("cross-origin POSTs are refused before anything else runs", () => {
  const EVIL = "https://evil.example.com";

  test("waiver/sign — a legal document executed in a member's name", async ({ request }) => {
    const member = await createMember();
    const res = await request.post(`/api/members/${member.id}/waiver/sign`, {
      headers: { Origin: EVIL },
      data: {
        signatureDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        signerName: "Mallory",
        emergencyContactName: "Mallory",
        emergencyContactPhone: "0000000000",
        emergencyContactRelation: "self",
        agreedTo: true,
      },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(CSRF_BODY);

    // Nothing was signed.
    const signed = await sql<{ id: string }>('SELECT id FROM "SignedWaiver" WHERE "memberId" = $1', [member.id]);
    expect(signed).toHaveLength(0);
    const m = await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [member.id]);
    expect(m[0].waiverAccepted).toBe(false);
  });

  test("the same route accepts the app's own origin — so the 403 above was the Origin", async ({ browser, baseURL }) => {
    // Positive control. Without it, "403 on a hostile Origin" is equally
    // consistent with the route being broken for everyone.
    //
    // Sent as the COACH rather than the owner on purpose: this route rate-limits
    // 5 requests / 15 min per staff user id, and the owner is the most contended
    // account in the suite.
    const coach = await sessionFor(browser, baseURL!, COACH_EMAIL);
    const member = await createMember();
    const res = await post(coach.request, `/api/members/${member.id}/waiver/sign`, baseURL!, {
      signerName: "",
    });
    // Reaches validation instead of being turned away at the door.
    expect(res.status()).toBe(400);
    expect((await res.json()).error).not.toBe(CSRF_BODY);
  });

  test.describe("the other four routes", () => {
    const routes: Array<{ label: string; path: string; data: unknown }> = [
      { label: "admin/dsar/erase", path: "/api/admin/dsar/erase", data: { memberId: "does-not-exist", confirm: "ERASE" } },
      { label: "admin/import/[id]/commit", path: "/api/admin/import/does-not-exist/commit", data: {} },
      { label: "admin/import/[id]/preview", path: "/api/admin/import/does-not-exist/preview", data: {} },
      { label: "products", path: "/api/products", data: { name: "Evil", pricePence: 1 } },
    ];

    for (const route of routes) {
      test(`${route.label} refuses a cross-origin POST`, async ({ request }) => {
        // The owner is authorised on all four, and the import ids are
        // deliberately nonsense: a 403 carrying the CSRF message proves the
        // guard ran before the role check AND before the id was ever used.
        const res = await request.post(route.path, { headers: { Origin: EVIL }, data: route.data });
        expect(res.status()).toBe(403);
        expect((await res.json()).error).toBe(CSRF_BODY);
      });
    }
  });
});
