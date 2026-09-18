/**
 * The card scanner, driven end to end with ONLY the camera faked.
 *
 * ## Why this file exists
 *
 * The coach card scanner is the closing demo, and until this spec it had never
 * been proven past a unit test that mocks `performCheckin` and Prisma. The
 * token on a laminated card is minted by the print sheet, encoded into a PNG,
 * decoded by the phone, verified against a signing key and a revocation
 * counter, and written through the shared check-in engine. This spec exercises
 * every one of those steps against the real server and the real database. The
 * only thing it replaces is the camera.
 *
 * ## What is faked, and how little
 *
 * `window.BarcodeDetector` is stubbed by an init script. It has no security
 * role — it is a browser decoder — and the stub HOLDS: `detect()` returns the
 * same code on every call for as long as the test leaves it "in frame", exactly
 * as a real camera does at 4 Hz. That matters: a stub that drained a queue would
 * emit each token once, and deleting the client's `seenRef` guard would leave
 * "exactly one request" true — the mutation would never fail. The stream itself
 * is real: Chromium's fake media device satisfies `getUserMedia`, `video.play()`
 * and `readyState`, so the loop, the guard, the fetch and everything server-side
 * run unmodified.
 *
 * ## Where the token comes from
 *
 * From the product. `.env.test` carries no NEXTAUTH_SECRET, so the spec cannot
 * sign a token the running server would verify. `helpers/qr.ts` opens the real
 * print sheet for the member and decodes the PNG the sheet rendered — which
 * proves mint → QR → decode → verify through real code, and removes the secret
 * question entirely.
 *
 * ## Arrangement
 *
 * Copied, not imported, from authorisation.spec.ts: `mkClass`/`mkInstance` are
 * closures inside that file's beforeAll and cannot be shared. Every row this spec
 * creates is its own: a run-stamped member (so `cleanupRun` finds it), a class
 * whose instructor is the seeded coach (set on BOTH `instructorId` and
 * `coachUserId` — the product writes the latter, the guards read the former),
 * and one instance per test so "exactly one AttendanceRecord for this instance"
 * cannot be disturbed by a sibling test on another worker. `cleanupRun` deletes
 * no Class or ClassInstance rows, so afterAll removes them in dependency order.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createMember, cleanupRun, sql, seededTenantId, auditEntriesFor, RUN_STAMP } from "./helpers/db";
import { readCardToken } from "./helpers/qr";

// A real getUserMedia, satisfied by Chromium's fake device: no permission prompt
// (the fake UI auto-accepts) and a live track the <video> can play.
//
// `channel: "chromium"` is load-bearing. Playwright's default headless browser
// is the headless SHELL, which has no media capture at all — under it the
// fake-device flags are inert and getUserMedia rejects with NotAllowedError,
// which the product renders (correctly) as "Camera access was blocked". The
// full Chromium build in its new headless mode is what honours the flags.
test.use({
  channel: "chromium",
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

// Login and the print sheet are cold compiles on the first navigation of a
// worker; see auth.setup.ts.
test.describe.configure({ timeout: 180_000 });

const OWNER_EMAIL = "owner@totalbjj.com";
const COACH_EMAIL = "coach@totalbjj.com";
const SCOPE = `${RUN_STAMP}-w${process.env.TEST_PARALLEL_INDEX ?? "0"}`;

// ── The camera stub ──────────────────────────────────────────────────────────

/**
 * Installed before every navigation. `__scanHold` is what the "camera" currently
 * sees; the test sets it to a token to hold a card under the lens and clears it
 * to take the card away. `getSupportedFormats` is present so a future
 * capability check (plan A4-xiv) still sees a QR-capable detector.
 */
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

// ── Arranged fixtures ────────────────────────────────────────────────────────

type Instance = { id: string; startTime: string };

type Fixtures = {
  tenantId: string;
  ownerUserId: string;
  classId: string;
  className: string;
  /** One instance per test, so record counts per instance are exact. */
  instances: {
    happy: Instance;
    held: Instance;
    revoked: Instance;
    limited: Instance;
    signedOut: Instance;
    serverDown: Instance;
    mapped: Instance;
    switchFrom: Instance;
    switchTo: Instance;
    order: Instance;
  };
  members: {
    happy: { id: string; name: string; token: string };
    held: { id: string; name: string; token: string };
    revoked: { id: string; name: string; token: string };
    limited: { id: string; name: string; token: string };
    signedOut: { id: string; name: string; token: string };
    serverDown: { id: string; name: string; token: string };
    mapped: { id: string; name: string; token: string };
    switcher: { id: string; name: string; token: string };
    orderFast: { id: string; name: string; token: string };
    orderSlow: { id: string; name: string; token: string };
  };
};

let fx: Fixtures;

/** A POST that looks like it came from the app's own origin (lib/csrf.ts). */
function post(rc: APIRequestContext, url: string, origin: string, data: unknown = {}) {
  return rc.post(url, { headers: { Origin: origin }, data });
}

test.beforeAll(async ({ browser, baseURL }) => {
  // Ten print sheets are rendered and decoded here, per worker, on a cold
  // Turbopack server; the file-level timeout covers tests, not this hook.
  test.setTimeout(180_000);
  const tenantId = await seededTenantId();

  const staff = await sql<{ id: string; email: string }>(
    'SELECT id, email FROM "User" WHERE "tenantId" = $1 AND email = ANY($2)',
    [tenantId, [OWNER_EMAIL, COACH_EMAIL]],
  );
  const byEmail = new Map(staff.map((u) => [u.email, u.id]));
  const ownerUserId = byEmail.get(OWNER_EMAIL);
  const coachUserId = byEmail.get(COACH_EMAIL);
  if (!ownerUserId || !coachUserId) {
    throw new Error("Seeded owner/coach users are missing — run npm run seed against the test branch.");
  }

  const className = `${SCOPE} card-scan`;
  const classRows = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "instructorId", "coachUserId", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 60, $3, $3, true, now())
     RETURNING id`,
    [tenantId, className, coachUserId],
  );
  const classId = classRows[0].id;

  // `ClassInstance.date` is timestamp(3) WITHOUT time zone, written by Prisma
  // as a UTC wall clock; node-pg would write the LOCAL wall clock. The cast
  // stores exactly what Prisma would, so /api/coach/today sees today.
  const localNoonToday = new Date();
  localNoonToday.setHours(12, 0, 0, 0);
  const mkInstance = async (startTime: string, endTime: string): Promise<Instance> => {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
       VALUES (gen_random_uuid()::text, $1, ($2::timestamptz AT TIME ZONE 'UTC'), $3, $4, false)
       RETURNING id`,
      [classId, localNoonToday.toISOString(), startTime, endTime],
    );
    return { id: rows[0].id, startTime };
  };

  const instances = {
    happy: await mkInstance("18:00", "19:00"),
    held: await mkInstance("19:00", "20:00"),
    revoked: await mkInstance("20:00", "21:00"),
    limited: await mkInstance("21:00", "22:00"),
    signedOut: await mkInstance("22:00", "23:00"),
    serverDown: await mkInstance("23:00", "23:30"),
    mapped: await mkInstance("09:00", "10:00"),
    switchFrom: await mkInstance("10:00", "11:00"),
    switchTo: await mkInstance("11:00", "12:00"),
    order: await mkInstance("12:00", "13:00"),
  };

  const mkMember = async (label: string) => createMember({ name: `Campaign Scan ${label} ${SCOPE}` });
  const happy = await mkMember("Happy");
  const held = await mkMember("Held");
  const revoked = await mkMember("Revoked");
  const limited = await mkMember("Limited");
  const signedOut = await mkMember("SignedOut");
  const serverDown = await mkMember("ServerDown");
  const mapped = await mkMember("Mapped");
  const switcher = await mkMember("Switcher");
  const orderFast = await mkMember("OrderFast");
  const orderSlow = await mkMember("OrderSlow");

  // Print each member's card once, as the owner, and read the token the sheet
  // actually rendered. Three single-card sheets rather than the bulk sheet: the
  // bulk sheet caps at 300 active members and the shared branch is not tidy.
  const printer = await browser.newContext({ baseURL, storageState: "tests/e2e/.auth/owner.json" });
  const page = await printer.newPage();
  const tokens: Record<string, string> = {};
  for (const m of [happy, held, revoked, limited, signedOut, serverDown, mapped, switcher, orderFast, orderSlow]) {
    await page.goto(`/print/member-cards?memberId=${m.id}`, { waitUntil: "domcontentloaded" });
    tokens[m.id] = await readCardToken(page, m.id);
  }
  // Warm the scan route. On a cold Turbopack dev server the first POST to
  // /api/checkin/card compiles the route, and under three parallel workers
  // that has exceeded the scanner's 10 s fetch timeout — which correctly
  // produced a `network` row, un-saw the token, and let the still-held card be
  // submitted again: two requests for one card, and a red "exactly one
  // request" assertion that was true of the harness, not the product. One
  // throwaway invalid token as the owner compiles the route; the server
  // answers 200 `invalid` and writes nothing.
  const warm = await printer.request.post("/api/checkin/card", {
    headers: { Origin: baseURL! },
    data: { classInstanceId: instances.happy.id, tokens: ["warm-up"] },
  });
  if (warm.status() !== 200) {
    throw new Error(`warm-up POST to /api/checkin/card answered ${warm.status()}: ${await warm.text()}`);
  }
  await printer.close();

  fx = {
    tenantId,
    ownerUserId,
    classId,
    className,
    instances,
    members: {
      happy: { ...happy, token: tokens[happy.id] },
      held: { ...held, token: tokens[held.id] },
      revoked: { ...revoked, token: tokens[revoked.id] },
      limited: { ...limited, token: tokens[limited.id] },
      signedOut: { ...signedOut, token: tokens[signedOut.id] },
      serverDown: { ...serverDown, token: tokens[serverDown.id] },
      mapped: { ...mapped, token: tokens[mapped.id] },
      switcher: { ...switcher, token: tokens[switcher.id] },
      orderFast: { ...orderFast, token: tokens[orderFast.id] },
      orderSlow: { ...orderSlow, token: tokens[orderSlow.id] },
    },
  };
});

test.afterAll(async () => {
  if (fx?.classId) {
    await sql(
      'DELETE FROM "AttendanceRecord" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = $1)',
      [fx.classId],
    ).catch(() => {});
  }
  await cleanupRun();
  if (fx?.classId) {
    await sql('DELETE FROM "ClassWaitlist" WHERE "classInstanceId" IN (SELECT id FROM "ClassInstance" WHERE "classId" = $1)', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassSubscription" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "ClassRoster" WHERE "classId" = $1', [fx.classId]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = $1', [fx.classId]).catch(() => {});
  }
});

test.beforeEach(async ({ context, page, baseURL }) => {
  await context.grantPermissions(["camera"], { origin: baseURL });
  await page.addInitScript(CAMERA_STUB);
});

// ── Driving the screen ───────────────────────────────────────────────────────

/** Open the scanner, pick the arranged session, start the (fake) camera. */
async function openScanner(page: Page, instance: Instance) {
  await page.goto("/dashboard/checkin?mode=scan", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: `${instance.startTime} · ${fx.className}`, exact: true })
    .click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("button", { name: "Stop camera" })).toBeVisible({ timeout: 30_000 });
}

/**
 * The scanner's own status region. The dashboard shell carries a second
 * `role="status"` (the toast container), so the announcer is found by the
 * element the scanner renders — a polite `<p>` — not by role alone.
 */
function announcer(page: Page) {
  return page.locator('p[role="status"][aria-live="polite"]');
}

/** The scan list only — the dashboard shell has its own <li>s in the nav. */
function scanList(page: Page) {
  return page.locator("h2:text-is('Scans') + ul > li");
}

function scanRow(page: Page, memberName: string) {
  return scanList(page).filter({ hasText: memberName });
}

async function recordsFor(instanceId: string) {
  return sql<{ tenantId: string; memberId: string; checkInMethod: string; checkedInById: string | null }>(
    'SELECT "tenantId", "memberId", "checkInMethod", "checkedInById" FROM "AttendanceRecord" WHERE "classInstanceId" = $1',
    [instanceId],
  );
}

// ── The cases ────────────────────────────────────────────────────────────────

test("a printed card, held under the camera, checks the right member into the right class", async ({ page }) => {
  const { happy: member } = fx.members;
  const instance = fx.instances.happy;

  await openScanner(page, instance);
  await hold(page, member.token);

  // On screen: the row names the member and says it recorded; the header
  // counts it; the in-card "Last:" line confirms it without a scroll; the
  // always-mounted status region announces it; the register is one tap away
  // while the camera runs — since 18 Sep 2026 it is the "Tick names" section
  // of the same screen rather than a link to a second one.
  const row = scanRow(page, member.name);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Checked in");
  await expect(page.getByText("1 scanned in", { exact: true })).toBeVisible();
  await expect(page.getByText(`Last: ${member.name} — checked in`)).toBeVisible();
  await expect(announcer(page)).toHaveText(`${member.name}, checked in.`);
  await expect(page.getByRole("tab", { name: "Tick names" })).toBeVisible();

  // In the database: exactly one row, and `memberId` is the assertion that
  // matters — the on-screen name is derived from the same lookup and is not an
  // independent witness of the token → member mapping.
  const rows = await recordsFor(instance.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].memberId).toBe(member.id);
  expect(rows[0].tenantId).toBe(fx.tenantId);
  expect(rows[0].checkInMethod).toBe("qr");
  expect(rows[0].checkedInById).toBe(fx.ownerUserId);

  // The audit write is fire-and-forget (lib/audit-log.ts), so it is polled.
  await expect
    .poll(async () => (await auditEntriesFor("attendance.card_scan", instance.id)).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
});

test("a card held in frame is submitted once, not once per tick", async ({ page }) => {
  const { held: member } = fx.members;
  const instance = fx.instances.held;

  let requests = 0;
  await page.route("**/api/checkin/card", async (route) => {
    requests += 1;
    await route.continue();
  });

  await openScanner(page, instance);
  await hold(page, member.token);
  await expect(scanList(page)).toHaveCount(1, { timeout: 30_000 });

  // The camera keeps "seeing" the card: at 4 Hz that is at least four more
  // decodes. Without the client's `seenRef` guard each one is a request and a
  // row; with it, none is. This is only falsifiable because the stub holds.
  await page.waitForTimeout(1_500);

  // The count and the request counter come FIRST, so it is these — not a
  // strict-mode locator violation from a second row — that go red on the
  // mutant. Under the mutant the row locator below would match twice and fail
  // for a reason that reads as a test defect rather than a product one.
  expect(requests, "one card in frame must be exactly one request").toBe(1);
  await expect(scanList(page)).toHaveCount(1);
  await expect(scanRow(page, member.name)).toContainText("Checked in");
  expect(await recordsFor(instance.id)).toHaveLength(1);
});

test("a revoked card is refused and records nothing; the reprinted card is accepted", async ({ page, context, baseURL }) => {
  const { revoked: member } = fx.members;
  const instance = fx.instances.revoked;
  const oldToken = member.token;

  // The member lost their card. Staff revoke it — the column is bumped, and the
  // token printed before the bump must stop working the moment this returns.
  const revoke = await post(context.request, `/api/members/${member.id}/card/revoke`, baseURL!, {
    reason: "campaign: lost at training",
  });
  expect(revoke.status(), await revoke.text()).toBe(200);

  await openScanner(page, instance);
  await hold(page, oldToken);

  const refused = scanRow(page, member.name);
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await expect(refused).toContainText("Card cancelled");
  expect(await recordsFor(instance.id), "a revoked card must write nothing").toHaveLength(0);
  // The header counts the refusal — a revoked card is neither "in" nor
  // invisible. This is the case the old tone-based counter got wrong.
  await expect(page.getByText("0 scanned in · 1 need attention")).toBeVisible();
  await expect(announcer(page)).toHaveText(`${member.name}, card cancelled. Print the new one.`);

  // Reprint: the sheet mints against the NEW cardVersion, read live.
  await hold(page, null);
  await page.goto(`/print/member-cards?memberId=${member.id}`, { waitUntil: "domcontentloaded" });
  const newToken = await readCardToken(page, member.id);
  expect(newToken).not.toBe(oldToken);

  await openScanner(page, instance);
  await hold(page, newToken);

  await expect(scanRow(page, member.name)).toContainText("Checked in", { timeout: 30_000 });
  const rows = await recordsFor(instance.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].memberId).toBe(member.id);
  expect(rows[0].checkInMethod).toBe("qr");
});

test("a rate-limited scan says wait, and does not resubmit while the card is held", async ({ page }) => {
  const { limited: member } = fx.members;
  const instance = fx.instances.limited;

  // The first request is answered by the limiter; anything after it is the
  // client resubmitting a card that is still under the lens — which is the
  // one thing a rate limit must not provoke.
  let requests = 0;
  await page.route("**/api/checkin/card", async (route) => {
    requests += 1;
    await route.fulfill({
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "30" },
      body: JSON.stringify({ error: "Too many scans — wait a moment and carry on" }),
    });
  });

  await openScanner(page, instance);
  await hold(page, member.token);

  const row = scanList(page).first();
  await expect(row).toContainText("Too many at once", { timeout: 30_000 });
  await expect(row).toContainText("Wait a moment");
  await expect(row).not.toContainText(/hold the card again/i);
  await page.waitForTimeout(1_500);
  expect(requests, "a rate-limited card must not be resubmitted while held").toBe(1);
  await expect(page.getByText("0 scanned in · 1 need attention")).toBeVisible();
  expect(await recordsFor(instance.id)).toHaveLength(0);
});

test("a server error is retried once by holding the card, never at 4 Hz", async ({ page }) => {
  const { serverDown: member } = fx.members;
  const instance = fx.instances.serverDown;

  // Every request fails. The product un-sees the token once, so the card still
  // under the lens is resubmitted exactly once; a third request is the 4 Hz
  // storm that spends the limiter inside a minute.
  let requests = 0;
  await page.route("**/api/checkin/card", async (route) => {
    requests += 1;
    // The first answer is held back, so the in-flight state is observable.
    if (requests === 1) await new Promise((r) => setTimeout(r, 1_500));
    await route.fulfill({
      status: 503,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Check-in is temporarily unavailable" }),
    });
  });

  await openScanner(page, instance);
  await hold(page, member.token);

  // The row exists from the moment the card is read, and a card in flight is
  // neither "in" nor "attention": the header must not flicker while it sends.
  const row = scanList(page).first();
  await expect(row).toContainText("Sending…", { timeout: 30_000 });
  await expect(page.getByText("0 scanned in", { exact: true })).toBeVisible();

  await expect(row).toContainText("MatFlow couldn't record this", { timeout: 30_000 });
  await expect(row).toContainText("if it fails twice, use the register");
  await page.waitForTimeout(2_000);
  expect(requests, "a failing card is retried once while held, not at 4 Hz").toBe(2);
  expect(await scanList(page).count(), "one row per attempt, two attempts").toBe(2);
  await expect(page.getByText("0 scanned in · 2 need attention")).toBeVisible();
  expect(await recordsFor(instance.id)).toHaveLength(0);
});

test("a session that expires mid-stack says so, rather than blaming the signal", async ({ page, context }) => {
  const { signedOut: member } = fx.members;
  const instance = fx.instances.signedOut;

  // If the 307 were followed, the browser would POST to /login and receive
  // the login page; with `redirect: "manual"` that request is cancelled and
  // never answers. This is what tells the redirect handling apart from the
  // content-type guard, which alone would still produce the same row. (The
  // `request` event is no use here: CDP announces the redirect target the
  // moment the 307 arrives, whether or not it is then followed.)
  const followed: string[] = [];
  page.on("response", (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/login") followed.push(r.url());
  });

  await openScanner(page, instance);
  // The session dies between cards. The proxy answers the next scan with a
  // 307 to /login; followed, that is the login PAGE as a 200 and used to
  // render "Didn't reach MatFlow — check signal". Not followed, it is
  // recognisable for what it is.
  await context.clearCookies();
  await hold(page, member.token);

  const row = scanList(page).first();
  await expect(row).toContainText("Signed out", { timeout: 30_000 });
  await expect(row).toContainText("Sign in again");
  await expect(row).not.toContainText("Didn't reach MatFlow");
  expect(await recordsFor(instance.id)).toHaveLength(0);
  expect(followed, "the 307 must not be followed").toHaveLength(0);
});

test("403, 404, 409 and a non-JSON 200 each get their own sentence", async ({ page }) => {
  const { mapped: member } = fx.members;
  const instance = fx.instances.mapped;

  const cases = [
    { status: 403, type: "application/json", body: JSON.stringify({ error: "Forbidden" }), copy: "MatFlow refused this scan" },
    { status: 404, type: "application/json", body: JSON.stringify({ error: "Class not found" }), copy: "Pick another session" },
    { status: 409, type: "application/json", body: JSON.stringify({ error: "That class was cancelled" }), copy: "Class was cancelled" },
    // A page where an answer should be: the login page, or a captive portal.
    { status: 200, type: "text/html", body: "<!doctype html><title>Sign in</title>", copy: "Signed out" },
  ];
  let current = cases[0];
  await page.route("**/api/checkin/card", (route) =>
    route.fulfill({ status: current.status, headers: { "Content-Type": current.type }, body: current.body }),
  );

  await page.goto("/dashboard/checkin?mode=scan", { waitUntil: "domcontentloaded" });
  for (const c of cases) {
    current = c;
    // Re-selecting the session is a new stack: the card is scannable again and
    // the camera has stopped, so Start is tapped again.
    await page
      .getByRole("button", { name: `${instance.startTime} · ${fx.className}`, exact: true })
      .click({ timeout: 60_000 });
    await page.getByRole("button", { name: "Start camera" }).click();
    await expect(page.getByRole("button", { name: "Stop camera" })).toBeVisible({ timeout: 30_000 });
    await hold(page, member.token);
    await expect(scanList(page).first()).toContainText(c.copy, { timeout: 30_000 });
    await hold(page, null);
  }
  expect(await recordsFor(instance.id)).toHaveLength(0);
});

test("selecting another session stops the camera, so a card still under the phone is not checked into it", async ({ page }) => {
  const { switcher: member } = fx.members;
  const from = fx.instances.switchFrom;
  const to = fx.instances.switchTo;

  let requests = 0;
  await page.route("**/api/checkin/card", async (route) => {
    requests += 1;
    await route.continue();
  });

  await openScanner(page, from);
  await page.getByRole("button", { name: `${to.startTime} · ${fx.className}`, exact: true }).click();
  await expect(page.getByRole("button", { name: "Start camera" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop camera" })).toHaveCount(0);

  // The card is under the phone the whole time. With no camera, nothing is
  // read and nothing is sent.
  await hold(page, member.token);
  await page.waitForTimeout(1_500);
  expect(requests, "a stopped camera submits nothing").toBe(0);
  expect(await scanList(page).count()).toBe(0);
  expect(await recordsFor(from.id)).toHaveLength(0);
  expect(await recordsFor(to.id)).toHaveLength(0);

  // Start is the explicit "new stack": now the card records, into the class
  // that was chosen.
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(scanList(page).first()).toContainText("Checked in", { timeout: 30_000 });
  expect(await recordsFor(to.id)).toHaveLength(1);
  expect(await recordsFor(from.id)).toHaveLength(0);
});

test("the Last line names the card that settled most recently, not the one scanned most recently", async ({ page }) => {
  const { orderFast: fast, orderSlow: slow } = fx.members;
  const instance = fx.instances.order;

  // The slow card's answer is held back two seconds and then fails; the fast
  // card records at once. Both are read in the same tick.
  await page.route("**/api/checkin/card", async (route) => {
    const body = route.request().postDataJSON() as { tokens: string[] };
    if (body.tokens[0] === slow.token) {
      await new Promise((r) => setTimeout(r, 2_000));
      await route.fulfill({
        status: 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Check-in is temporarily unavailable" }),
      });
      return;
    }
    await route.continue();
  });

  await openScanner(page, instance);
  await page.evaluate(
    ([a, b]) => {
      (window as unknown as { __scanHold: string[] }).__scanHold = [a, b];
    },
    [slow.token, fast.token],
  );

  await expect(page.getByText(`Last: ${fast.name} — Checked in`)).toBeVisible({ timeout: 30_000 });
  await hold(page, null);
  // The slow card settles after the fast one and is the newer OUTCOME, even
  // though the fast card is the newer row in the list. A 503 carries no
  // member name, so the line says what is known: the card was not sent.
  await expect(page.getByText("Last: Card not sent — MatFlow couldn't record this")).toBeVisible({ timeout: 30_000 });
  expect(await recordsFor(instance.id)).toHaveLength(1);
});

test("a detector that reports no formats yet still starts, because the module may be downloading", async ({ page }) => {
  // Chrome for Android before the Play Services barcode module has been
  // fetched: `getSupportedFormats()` resolves []. Refusing here would prevent
  // the very construction that triggers the download.
  await page.addInitScript(`
    (() => {
      class Empty {
        static async getSupportedFormats() { return []; }
        constructor() {}
        async detect() { return []; }
      }
      window.BarcodeDetector = Empty;
    })();
  `);
  await page.goto("/dashboard/checkin?mode=scan", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: `${fx.instances.happy.startTime} · ${fx.className}`, exact: true })
    .click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Start camera" }).click();
  await expect(page.getByRole("button", { name: "Stop camera" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "This browser can't scan QR codes" })).toHaveCount(0);
});

test("a detector that exists but cannot read QR codes is reported, not left running", async ({ page }) => {
  // A platform whose detector reports formats and QR is not among them. The
  // worst demo outcome is a live-looking camera under which nothing happens;
  // this is the capability check that prevents it. An EMPTY list is
  // deliberately NOT this case: on Chrome for Android it means the Play
  // Services barcode module has not downloaded yet, and constructing the
  // detector is what triggers the download — so an empty list proceeds and
  // the five-rejection counter is the backstop.
  await page.addInitScript(`
    (() => {
      class NoQr {
        static async getSupportedFormats() { return ["ean_13", "code_128"]; }
        constructor() {}
        async detect() { return []; }
      }
      window.BarcodeDetector = NoQr;
    })();
  `);
  await page.goto("/dashboard/checkin?mode=scan", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: `${fx.instances.happy.startTime} · ${fx.className}`, exact: true })
    .click({ timeout: 60_000 });
  await page.getByRole("button", { name: "Start camera" }).click();

  // The heading is the product's own statement of the state, inside an alert
  // region (the shell has a second alert — the 2FA banner — so the alert is
  // found through its heading rather than by role alone).
  const heading = page.getByRole("heading", { name: "This browser can't scan QR codes" });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("alert").filter({ has: heading })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Stop camera" })).toHaveCount(0);
});
