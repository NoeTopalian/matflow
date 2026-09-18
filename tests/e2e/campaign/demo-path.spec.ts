import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

import { RUN_STAMP, cleanupRun, paymentsFor, seededTenantId, sql } from "./helpers/db";

/**
 * THE DEMO PATH — the exact sequence of taps a gym owner performs in front of a
 * prospect, asserted with database consequences at every step.
 *
 * dashboard → Members (add one, find them) → their profile → Record payment
 * (cash) → the outstanding list → Today's Register (tick) → Timetable →
 * Print cards → Scan cards.
 *
 * ## Why this file exists
 *
 * Each of those screens has coverage of its own. NOTHING walks them in order,
 * against one member, with the database read back after every step — which is
 * exactly the shape of the failure that shows up in a room with a prospect in
 * it: every screen works, and the journey does not.
 *
 * Two things this file is careful about, because both have bitten this repo:
 *
 *  - **A rendered screen is not a saved row.** The payment drawer paints its
 *    row optimistically, the register flips its tick before the POST resolves.
 *    So every act is asserted twice — once on the screen, once in Postgres.
 *  - **An HTTP error is not an empty state** (UI-RULES §7). `renders()` below is
 *    the demo-sweep helper: a real `<h1>`, no error boundary, no console error.
 *    A page that 200s with a red console is a failure here.
 *
 * Arrangement that no screen can perform (a due date forty days old, a class
 * subscription) goes through `helpers/db.ts`. Everything a human would do in
 * the room is done in the browser.
 */

// A cold Turbopack compile of /dashboard/members/[id], /dashboard/payments,
// /dashboard/coach, /dashboard/timetable and /print/member-cards runs to tens
// of seconds each on first hit. Serial because the cases are one journey: case
// 3 spends the member case 2 created.
test.describe.configure({ mode: "serial", timeout: 180_000 });

const DEMO_NAME = `${RUN_STAMP} Demo Member`;
const DEMO_EMAIL = `${RUN_STAMP}-demo@example.test`;

let tenantId = "";
/** Filled by case 2, spent by cases 3, 4 and 7. */
let memberId = "";
/** Today's class this run ticks a register on, as the PRODUCT reports it. */
let todayInstance: { id: string; classId: string; name: string; startTime: string } | null = null;
/** Rows this run created that `cleanupRun()` does not know about. */
let createdInstanceId: string | null = null;
let createdTierId: string | null = null;

// ── The render helper, copied from demo-sweep.spec.ts:97-135 ─────────────────

const IGNORABLE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /react-devtools/i,
  /webpack-hmr|turbopack-hmr/i,
  /destination stream closed early/i,
  // A real, separately-recorded finding: 30 call sites run Promise.all inside
  // one interactive transaction. Narrow on purpose — see demo-sweep.spec.ts.
  /DeprecationWarning: Calling client\.query\(\) when the client is already executing a query/i,
];

function isIgnorable(text: string): boolean {
  return IGNORABLE.some((re) => re.test(text));
}

function collect(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${new URL(req.url()).pathname} → ${req.failure()?.errorText ?? "?"}`);
  });
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isIgnorable(text)) return;
    // The auth client's "Failed to fetch" is counted unless Chromium says the
    // request was ABORTED — which is what a navigation does to a session
    // refetch still in flight on the page being left. A session request the
    // server refused or dropped (ERR_CONNECTION_RESET, ERR_EMPTY_RESPONSE, a
    // 5xx) is not an abort and still fails the case; the failed-request list
    // is printed with the assertion so the reason is never a guess again.
    if (
      /ClientFetchError: Failed to fetch/.test(text) &&
      failedRequests.some((f) => f.includes("/api/auth/session") && f.endsWith("net::ERR_ABORTED"))
    ) {
      return;
    }
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => {
    if (!isIgnorable(err.message)) pageErrors.push(err.message);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

/**
 * The four assertions demo-sweep makes per route, as one call: the URL did not
 * bounce, an `<h1>` composed, no error boundary is showing, nothing threw.
 */
async function renders(page: Page, href: string) {
  // Unlike demo-sweep, this journey navigates from one loaded screen to the
  // next. A fetch still in flight on the OUTGOING page — the auth
  // SessionProvider refetches on focus and on an interval — is aborted by the
  // navigation and logs "ClientFetchError: Failed to fetch" on the console,
  // which the listener below would charge to the INCOMING route. Let the
  // outgoing page go quiet first; nothing about the incoming page is relaxed.
  if (page.url() !== "about:blank") {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }
  const found = collect(page);
  await page.goto(href, { waitUntil: "domcontentloaded" });

  await expect(page, `${href} redirected away for the owner`).toHaveURL(
    new RegExp(href.split("?")[0].replace(/\//g, "\\/") + "(\\?|$|\\/)"),
    { timeout: 60_000 },
  );
  await expect(
    page.locator("h1").first(),
    `${href} rendered no heading — it responded but did not compose`,
  ).toBeVisible({ timeout: 60_000 });

  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  expect(body, `${href} is showing an error boundary`).not.toMatch(
    /Application error|Something went wrong|MF-[A-Z0-9]{6}/,
  );

  await page.waitForTimeout(1500);
  expect(found.pageErrors, `${href} threw on the client`).toEqual([]);
  expect(
    found.consoleErrors,
    `${href} logged console errors (failed requests: ${found.failedRequests.join("; ") || "none"})`,
  ).toEqual([]);
  return found;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
  tenantId = await seededTenantId();

  // Warm the cold routes the journey crosses. On a dev server the first hit
  // on /dashboard/members/[id] compiles for tens of seconds, and the page's
  // own auth-session fetch gives up first — logging "ClientFetchError: Failed
  // to fetch", which the render helper (rightly) counts as a console error.
  // That is a Turbopack artefact, not the product; production is built.
  // card-scan.spec.ts warms /api/checkin/card for the same reason. Each request
  // is made as the owner so the proxy lets it reach the route and compile it.
  const seeded = await sql<{ id: string }>(
    'SELECT id FROM "Member" WHERE "tenantId" = $1 ORDER BY "joinedAt" ASC LIMIT 1',
    [tenantId],
  );
  const ctx = await browser.newContext({ storageState: "tests/e2e/.auth/owner.json" });
  try {
    for (const href of [
      "/dashboard",
      "/dashboard/members",
      seeded[0] ? `/dashboard/members/${seeded[0].id}` : null,
      "/dashboard/payments",
      "/dashboard/checkin",
      "/dashboard/timetable",
      "/dashboard/checkin?mode=scan",
      seeded[0] ? `/print/member-cards?memberId=${seeded[0].id}` : null,
    ]) {
      if (!href) continue;
      await ctx.request.get(href, { timeout: 120_000 }).catch(() => {});
    }
  } finally {
    await ctx.close();
  }
});

test.afterAll(async () => {
  // The run member is never subscribed to anything (the register lists them
  // as a walk-in from their check-in), so there is no ClassSubscription row
  // to remove before cleanupRun deletes the member.
  // cleanupRun sweeps this run's AttendanceRecords, so the instance is free
  // by the time it is deleted — but only after cleanupRun has run.
  await cleanupRun();
  if (createdInstanceId) {
    await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" = $1', [createdInstanceId]).catch(() => {});
    await sql('DELETE FROM "ClassInstance" WHERE id = $1', [createdInstanceId]).catch(() => {});
  }
  if (createdTierId) {
    await sql('DELETE FROM "MembershipTier" WHERE id = $1', [createdTierId]).catch(() => {});
  }
});

// ── 1. The dashboard the prospect sees first ─────────────────────────────────

test("1 · the dashboard renders and its stat cards carry numbers, not dashes", async ({ page }) => {
  await renders(page, "/dashboard");

  // The four metric cards (components/dashboard/DashboardStats.tsx). A dash
  // where a number belongs is the shape of a failed count rendered as an empty
  // state, and it is the first thing a prospect looks at.
  // The value is the `<p>` immediately after the label `<p>` inside MetricCard,
  // so it is read directly rather than by scanning a card's whole text — a
  // "does this blob contain a digit" check passes on any page with a date on it.
  for (const label of ["Payments Due", "Today's Classes", "At-Risk Members"]) {
    const labelNode = page.getByText(label, { exact: true }).first();
    await expect(labelNode, `the "${label}" card is missing`).toBeVisible({ timeout: 30_000 });
    const value = labelNode.locator("xpath=following-sibling::p[1]");
    const text = (await value.innerText()).trim();
    expect(text, `the "${label}" card shows "${text}" where a count belongs`).toMatch(/^\d[\d,]*$/);
  }
});

// ── 2. Add a member, find them, open them ────────────────────────────────────

test("2 · adding a member through the drawer writes a row, and search finds them", async ({ page }) => {
  await renders(page, "/dashboard/members");

  await page.getByRole("button", { name: "Add member", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add Member" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  await dialog.getByLabel("Full Name", { exact: true }).fill(DEMO_NAME);
  await dialog.getByLabel("Email", { exact: true }).fill(DEMO_EMAIL);
  await dialog.getByRole("button", { name: "Add Member", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // THE CONSEQUENCE: a row, not a toast.
  const rows = await sql<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM "Member" WHERE email = $1',
    [DEMO_EMAIL],
  );
  expect(rows, "the drawer closed but no Member row was written").toHaveLength(1);
  expect(rows[0].name).toBe(DEMO_NAME);
  memberId = rows[0].id;

  // The owner then types the name into the search box to find them again.
  await page.reload();
  const search = page.getByLabel("Search members", { exact: true }).first();
  await expect(search).toBeVisible({ timeout: 60_000 });
  await search.fill(DEMO_NAME);
  await expect(page.getByText(DEMO_NAME, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // And their profile composes.
  await renders(page, `/dashboard/members/${memberId}`);
  await expect(page.getByText(DEMO_NAME).first()).toBeVisible({ timeout: 30_000 });
});

// ── 3. £40 cash at the desk, and off the outstanding list ────────────────────

test("3 · cash at the desk is saved, and drops the member off the outstanding list", async ({ page }) => {
  expect(memberId, "case 2 did not produce a member").toBeTruthy();

  // ARRANGE — no screen can make a member overdue, and without that the
  // "drops off the outstanding list" half asserts nothing at all.
  const tiers = await sql<{ id: string }>(
    `SELECT id FROM "MembershipTier"
     WHERE "tenantId" = $1 AND "billingCycle" = 'monthly' AND "isActive" = true
     ORDER BY "createdAt" ASC LIMIT 1`,
    [tenantId],
  );
  let tierId: string;
  if (tiers.length > 0) {
    tierId = tiers[0].id;
  } else {
    const made = await sql<{ id: string }>(
      `INSERT INTO "MembershipTier"
         ("id", "tenantId", "name", "pricePence", "currency", "billingCycle", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 4000, 'GBP', 'monthly', true, now(), now())
       RETURNING id`,
      [tenantId, `${RUN_STAMP} monthly`],
    );
    tierId = made[0].id;
    createdTierId = made[0].id;
  }
  await sql(
    'UPDATE "Member" SET "membershipTierId" = $1, "nextDueAt" = $2, "paymentStatus" = $3 WHERE id = $4',
    [tierId, new Date(Date.now() - 12 * 86_400_000), "overdue", memberId],
  );

  // They are on the "who owes me" list before anything is recorded — otherwise
  // the absence asserted at the end of this test is worthless.
  await renders(page, "/dashboard/payments");
  await expect(page.getByRole("link", { name: DEMO_NAME, exact: true }).first()).toBeVisible({
    timeout: 60_000,
  });

  // ACT — the owner opens the member and takes £40 in cash.
  await page.goto(`/dashboard/members/${memberId}?tab=payments`);
  await expect(page.getByText("Payment History", { exact: true })).toBeVisible({ timeout: 90_000 });

  const drawer = page.getByRole("dialog", { name: "Record payment" });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(drawer).toBeVisible({ timeout: 30_000 });
  await drawer.locator("#profile-payment-method").selectOption("cash");
  await drawer.getByLabel("Description / Notes", { exact: true }).fill("Monthly membership, cash");
  await drawer.getByLabel("Amount (£)", { exact: true }).fill("40.00");
  await drawer.getByRole("button", { name: "Record payment", exact: true }).click();

  await expect(page.getByRole("alert").filter({ hasText: "Payment recorded" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(drawer).toBeHidden({ timeout: 30_000 });

  // ASSERT — the row in Postgres. `Payment` has no `method` column; the method
  // survives as the METHOD_LABEL prefix the route builds
  // (app/api/payments/manual/route.ts), so "Cash — …" IS the saved method.
  const payments = await paymentsFor(memberId);
  expect(payments, "the toast fired but no Payment row was written").toHaveLength(1);
  expect(payments[0].amountPence).toBe(4000);
  expect(payments[0].status).toBe("succeeded");
  expect(payments[0].description).toBe("Cash — Monthly membership, cash");

  // ASSERT — and the outstanding panel drops them, on a FRESH load rather than
  // on the optimistic client-side filter. Wait for the panel to resolve first:
  // "the name is absent" is trivially true while it is still loading.
  await page.goto("/dashboard/payments");
  await expect(
    page.getByText(/outstanding across \d+ member|Nobody owes you right now/),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: DEMO_NAME, exact: true })).toHaveCount(0);
});

// ── 4. Today's register: tick, then un-tick ──────────────────────────────────

test("4 · ticking the register writes an admin check-in, and un-ticking removes it", async ({ page }) => {
  expect(memberId, "case 2 did not produce a member").toBeTruthy();

  // Ask the PRODUCT what is on today rather than guessing — /api/coach/today is
  // the same call the register screen makes, including its dedupe.
  const res = await page.request.get("/api/coach/today");
  expect(res.ok(), `/api/coach/today answered ${res.status()}`).toBe(true);
  let todays = (await res.json()) as { id: string; classId: string; name: string; startTime: string }[];

  // Never pick a class another spec created: card-scan.spec.ts runs in the
  // same batch, arranges run-stamped `e2e-… card-scan` classes with instances
  // today, and deletes them in its afterAll — so the first instance of the
  // day can vanish between this fetch and the register rendering it.
  const ownDay = () => todays.filter((t) => !/^e2e-/.test(t.name));

  if (ownDay().length === 0) {
    // Nothing scheduled today on this branch. Create one instance on a seeded
    // class, exactly as authorisation.spec.ts does — `ClassInstance.date` is a
    // timestamp WITHOUT time zone that Prisma round-trips as a UTC wall clock,
    // so an explicit instant is cast through `timestamptz AT TIME ZONE 'UTC'`
    // rather than handing node-pg a JS Date (which writes the LOCAL clock and
    // lands the row outside the app's own "today" window).
    const seeded = await sql<{ id: string }>(
      `SELECT id FROM "Class" WHERE "tenantId" = $1 AND "isActive" = true AND "deletedAt" IS NULL
       ORDER BY "createdAt" ASC LIMIT 1`,
      [tenantId],
    );
    expect(seeded, "the seeded club has no active class at all").not.toHaveLength(0);
    // Spelled the way the class-instances cron spells a day marker — the
    // club's calendar date at UTC midnight — which sits in the middle of the
    // today band. Local noon was the previous anchor; on a UTC process it is
    // exactly the band's exclusive upper bound, so the row was written and
    // never returned.
    const localNoonToday = new Date();
    localNoonToday.setUTCHours(0, 0, 0, 0);
    const made = await sql<{ id: string }>(
      `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
       VALUES (gen_random_uuid()::text, $1, ($2::timestamptz AT TIME ZONE 'UTC'), '18:00', '19:00', false)
       RETURNING id`,
      [seeded[0].id, localNoonToday.toISOString()],
    );
    createdInstanceId = made[0].id;
    const again = await page.request.get("/api/coach/today");
    todays = (await again.json()) as typeof todays;
    expect(ownDay().length, "an instance was created for today and the register still lists nothing").toBeGreaterThan(0);
  }

  todayInstance = ownDay()[0];

  // The run member has subscribed to nothing. Until X-6 the register's roster
  // was `ClassSubscription` alone, so a member added on stage — or scanned in
  // with a card — was on no register at all. Now anyone with a check-in for
  // the instance is listed, tagged WALK-IN. So: mark them the way the scanner
  // or Mark Attendance would, then expect the register to show them ticked.
  const mark = await page.request.post("/api/checkin", {
    headers: { Origin: new URL(page.url() === "about:blank" ? "http://localhost:3847" : page.url()).origin },
    data: { classInstanceId: todayInstance.id, memberId, checkInMethod: "admin" },
  });
  expect(mark.status(), await mark.text()).toBe(201);

  await renders(page, "/dashboard/checkin");

  // Open today's class by the name the screen prints — the Session group of
  // the attendance hub (Today's Register is its "Tick names" section now).
  await page.getByRole("group", { name: "Session" }).getByRole("button").filter({ hasText: todayInstance.name }).first().click();

  // THE CONSEQUENCE, on screen: the unsubscribed member is on the register,
  // ticked, and told apart from a booked no-show by the tag.
  const untick = page.getByRole("button", { name: `Mark ${DEMO_NAME} absent`, exact: true });
  await expect(untick, "a checked-in member who never subscribed is missing from the register").toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("listitem").filter({ hasText: DEMO_NAME }).getByText("WALK-IN", { exact: true }),
  ).toBeVisible();

  const marked = await sql<{ id: string; checkInMethod: string }>(
    'SELECT id, "checkInMethod" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
    [memberId, todayInstance.id],
  );
  expect(marked).toHaveLength(1);
  expect(marked[0].checkInMethod).toBe("admin");

  // Un-ticking must actually delete it — a register you cannot correct is worse
  // than one you cannot fill in. A walk-in was on the register ONLY because
  // of that check-in, so the row goes with it (what a reload shows); leaving
  // it unticked would offer a re-tick the server has nothing to attach to.
  await untick.click();
  // The hub asks before deleting a check-in (UI-RULES §5.4 — it removes the
  // record and hands back a redeemed credit; a stray thumb on a phone must
  // not do that silently). Confirm, then the server's answer is reloaded.
  await page.getByRole("button", { name: "Remove check-in" }).click({ timeout: 30_000 });
  await expect(untick).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("listitem").filter({ hasText: DEMO_NAME })).toHaveCount(0);
  const cleared = await sql(
    'SELECT id FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
    [memberId, todayInstance.id],
  );
  expect(cleared, "un-ticking left the check-in in the database").toHaveLength(0);
});

// ── 5. K12 — the same clock on every screen ──────────────────────────────────

test("5 · today's class time reads the same on the register, the scanner and the timetable", async ({ page }) => {
  expect(todayInstance, "case 4 did not establish today's class").toBeTruthy();
  const inst = todayInstance!;

  // The database's own answer, read from the column the screens claim to show.
  const rows = await sql<{ startTime: string; endTime: string }>(
    'SELECT "startTime", "endTime" FROM "ClassInstance" WHERE id = $1',
    [inst.id],
  );
  expect(rows).toHaveLength(1);
  const stored = rows[0].startTime;

  // An hour's drift — the K12 shape, `lib/date.ts#formatTime` rendering in the
  // PROCESS zone while the club's own zone lives on `Tenant.timezone` — shows
  // up here as a screen printing a time the column does not hold.
  await renders(page, "/dashboard/checkin");
  await expect(
    page.getByText(stored, { exact: false }).first(),
    `/dashboard/checkin does not print the stored start time ${stored}`,
  ).toBeVisible({ timeout: 60_000 });

  await renders(page, "/dashboard/checkin?mode=scan");
  await expect(
    page.getByText(stored, { exact: false }).first(),
    `/dashboard/checkin?mode=scan does not print the stored start time ${stored}`,
  ).toBeVisible({ timeout: 60_000 });

  // The timetable renders the recurring `ClassSchedule`, not the instance — so
  // it is asserted against the schedule row for today's weekday on the same
  // class. If the two disagree the timetable and the register are telling the
  // owner different things about the same class, which is the same defect
  // wearing a different hat.
  const dow = new Date().getDay();
  const sched = await sql<{ startTime: string }>(
    `SELECT cs."startTime" FROM "ClassSchedule" cs
     WHERE cs."classId" = $1 AND cs."dayOfWeek" = $2 AND cs."isActive" = true LIMIT 1`,
    [inst.classId, dow],
  );
  await renders(page, "/dashboard/timetable");
  if (sched.length > 0) {
    // Scoped to the desktop week grid: the page also renders a mobile list
    // (hidden at this width) that starts with TODAY's classes, so a page-wide
    // first match on "10:00" lands on a hidden node once today has a 10:00.
    const grid = page.locator("div.grid.grid-cols-7").first();
    await expect(grid, "the week grid is not on the timetable").toBeVisible({ timeout: 60_000 });
    await expect(
      grid.locator("*", { hasText: inst.name }).getByText(sched[0].startTime, { exact: false }).first(),
      `/dashboard/timetable does not print ${sched[0].startTime} for today's ${inst.name}`,
    ).toBeVisible({ timeout: 60_000 });
  } else {
    // Recorded rather than skipped: a class instance with no recurring schedule
    // for today is invisible on the timetable by design, and the demo must not
    // rely on it appearing there.
    test.info().annotations.push({
      type: "uncovered",
      description: `${inst.name} has no active ClassSchedule for dayOfWeek ${dow}; the timetable cannot show it.`,
    });
  }
});

// ── 6. K8 — the timetable at a 1280 laptop ───────────────────────────────────

test("6 · the timetable does not scroll sideways at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await renders(page, "/dashboard/timetable");
  // Let the week grid settle after the viewport change.
  await page.waitForTimeout(500);

  // The document never overflows at any width — the week grid sits in an
  // `overflow-x-auto` container — so measuring the document passes against a
  // blank page. Measure the container itself: below 1280 its 980 px floor
  // makes it scroll inside the page; at 1280 (`xl:min-w-0`) it must not.
  const grid = page.locator("div.overflow-x-auto:has(> div.grid.grid-cols-7)").first();
  await expect(grid, "the week grid container is not on the page").toBeVisible({ timeout: 30_000 });
  const overflows = await grid.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(
    overflows,
    "the week grid scrolls sideways inside the timetable at 1280 — the demo laptop shows a scrollbar",
  ).toBe(false);
});

// ── 7. Print cards ───────────────────────────────────────────────────────────

test("7 · the printable card carries a real QR image and no failure banner", async ({ page }) => {
  expect(memberId, "case 2 did not produce a member").toBeTruthy();

  await renders(page, `/print/member-cards?memberId=${memberId}`);

  const qr = page.locator(`img[data-testid="qr-${memberId}"]`);
  await expect(qr, "no QR image was rendered for the member").toBeVisible({ timeout: 60_000 });
  const src = await qr.getAttribute("src");
  expect(src ?? "", "the QR image is not a rendered PNG data URI").toContain("data:image/png");

  // MemberCardSheet's own banners. Any of them showing means a card went to the
  // printer that cannot be scanned, or that silently lost its photo.
  await expect(page.getByTestId("qr-excluded-banner")).toHaveCount(0);
  await expect(page.getByTestId("photo-failure-banner")).toHaveCount(0);
});

// ── 8. Scan cards ────────────────────────────────────────────────────────────

test("8 · the scanner offers at least one of today's sessions", async ({ page }) => {
  await renders(page, "/dashboard/checkin?mode=scan");

  // The session picker is a radio-style group (components/dashboard/SessionPicker.tsx).
  // Its absence means the owner reaches the scanner with nothing to scan into —
  // the scanner itself is proven by card-scan.spec.ts.
  const group = page.getByRole("group", { name: "Session" });
  await expect(group, "the scanner rendered no session picker").toBeVisible({ timeout: 60_000 });
  const buttons = group.getByRole("button");
  expect(
    await buttons.count(),
    "the scanner lists no session today — there is nothing to scan into",
  ).toBeGreaterThan(0);
});
