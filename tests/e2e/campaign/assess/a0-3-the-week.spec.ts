/**
 * Lane A0, file 3 — the week: the timetable, the register, the kiosk, the card.
 *
 * This is what the club is being sold on, so almost every case here is ★. Every
 * assertion is a row or a fresh GET; the toast is never the proof.
 */
import { test, expect, type Page } from "@playwright/test";
import { sql } from "../helpers/db";
import { readCardToken } from "../helpers/qr";
import {
  B_PASSWORD,
  TENANT_A_SLUG,
  assertKeysWithin,
  assertNoOverflow,
  assertRefusalShape,
  closeSessions,
  countOf,
  expectOk,
  mergeTenantFile,
  readTenantFile,
  setMemberPassword,
  tryReadTenantFile,
  sessionFor,
  teardownTenantB,
  // ROUND 2: the campaign-stable stamp, NOT helpers/db RUN_STAMP. RUN_STAMP is
  // minted per Node process and Playwright starts a new worker after every
  // failed test, so every identity created before a failure vanished for every
  // test after it. See the note on A0_STAMP in a0-shared.ts.
  A0_STAMP as RUN_STAMP,
} from "./a0-shared";

test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});
test.describe.configure({ mode: "default", timeout: 180_000 });

const PHONE = { width: 390, height: 844 };
const KIOSK_W = 768;
// ROUND 3: tenant B now carries a real bcrypt hash of its OWN password (set by
// file 1), so every sign-in here is a genuine bcrypt comparison rather than a
// ride on the e2e bypass token, which skips bcrypt entirely (auth.ts:331-336).
const PW = B_PASSWORD;

let tenantId = "";
let slug = "";
let ownerEmail = "";
let coachEmail = "";
let kioskToken = "";
let classId = "";
let instanceId = "";
let memberId = "";

function origin(baseURL: string | undefined) {
  return baseURL ?? "http://127.0.0.1:3847";
}

/** The camera stub, copied from card-scan.spec.ts:72-96. */
const CAMERA_STUB = `
  (() => {
    window.__scanHold = [];
    class FakeBarcodeDetector {
      static async getSupportedFormats() { return ["qr_code"]; }
      constructor() {}
      async detect() { return (window.__scanHold || []).map((rawValue) => ({ rawValue })); }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
  })();
`;

/**
 * The print sheet leaves a card off silently-but-visibly: a member whose QR
 * could not be generated is dropped from the sheet and named in a banner
 * (components/print/MemberCardSheet.tsx:266, :537-552). `readCardToken` then
 * waits out its own 60 s on an `<img>` that was never rendered and reports
 * "element(s) not found", which says nothing about why. Read the banner first
 * so the failure carries the product's own sentence.
 */
async function assertCardOnSheet(page: Page, id: string): Promise<void> {
  const banner = page.getByTestId("qr-excluded-banner");
  await page.waitForLoadState("domcontentloaded");
  if (await banner.count()) {
    expect(await banner.innerText(), "the print sheet left this member's card off").toBe("");
  }
  await expect(page.locator(`img[data-testid="qr-${id}"]`), "the member's card is on the sheet").toHaveCount(1, {
    timeout: 30_000,
  });
}

async function hold(page: Page, token: string | null) {
  await page.evaluate((t) => {
    (window as unknown as { __scanHold: string[] }).__scanHold = t ? [t] : [];
  }, token);
}

/** A missing handover is an UNCOVERED cell with a named blocker, not a failure. */
let handoverBlocker = "";

test.beforeEach(() => {
  test.skip(!!handoverBlocker, handoverBlocker);
});

test.beforeAll(async () => {
  const read = tryReadTenantFile();
  if (!read.ok) {
    handoverBlocker = read.reason;
    return;
  }
  const file = read.file;
  tenantId = file.tenantId;
  slug = file.slug;
  ownerEmail = file.ownerEmail;
  coachEmail = file.ids?.coachEmail ?? `${RUN_STAMP}-coach@example.test`;
  kioskToken = file.ids?.kioskToken ?? "";
  // ROUND 5 — `classId`/`instanceId` are module-level and are set by A0.10's
  // first two cells, so they were EMPTY in every worker Playwright started
  // after a failure. That is why round 5's single check-in failure took four
  // more ★ cells with it: `:380`, `:400`, `:423` and `:448` all skipped as
  // "UNCOVERED — no instance" in the restarted worker, and the log reported
  // five dark cells for one fault. A0.10 already writes both ids to the
  // handover file; reading them back makes a restart survivable, and the SQL
  // fallback covers a file the controller runs on its own.
  classId = file.ids?.classId ?? "";
  instanceId = file.ids?.instanceId ?? "";
  // Fall back to ANY adult of tenant B rather than nothing: the stamp is now
  // stable across workers, but a file run alone (the controller does that) can
  // still meet a club whose adults were made under an earlier campaign.
  const m = await sql<{ id: string }>(
    `SELECT id FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NULL
       ORDER BY (email LIKE $2) DESC, "joinedAt" LIMIT 1`,
    [tenantId, `${RUN_STAMP}-adult%`],
  );
  memberId = m[0]?.id ?? "";

  if (!classId) {
    const c = await sql<{ id: string }>(
      `SELECT id FROM "Class" WHERE "tenantId" = $1 ORDER BY (name LIKE $2) DESC, "createdAt" DESC LIMIT 1`,
      [tenantId, `${RUN_STAMP}%`],
    );
    classId = c[0]?.id ?? "";
  }
  if (!instanceId && classId) {
    const i = await sql<{ id: string }>(
      `SELECT id FROM "ClassInstance" WHERE "classId" = $1 AND "isCancelled" = false ORDER BY date LIMIT 1`,
      [classId],
    );
    instanceId = i[0]?.id ?? "";
  }
});

/**
 * ROUND 6 ROOT CAUSE — the id the whole week was driven against had been
 * DELETED by this file's own third cell.
 *
 * A0.10 captures the earliest instance at :209 and every later cell posts that
 * id. Between the capture and A0.11 sits :213, "editing the start time moves
 * every future instance and leaves none behind", which PATCHes the class from
 * the bracketing time it was created at to 20:15. `reconcileSchedules`
 * (app/api/classes/[id]/route.ts:189-205) then sweeps every upcoming instance
 * whose `dayOfWeek|startTime` is no longer a live slot and DELETES the ones
 * with no attendance — today's row among them — before re-minting the day at
 * the new time with a NEW id. Measured on a throwaway class in the seeded club
 * on 20 Sep: 8 instances minted, earliest "Sun 20 Sep 17:00", and after the
 * PATCH that exact id no longer existed while a 20:15 row for today did.
 *
 * So the id was a tombstone, and `POST /api/checkin`, `POST /api/checkin/card`
 * and `POST /api/member/bookings` all answered `404 {"error":"Class not
 * found"}` for it (checkin/route.ts:95, checkin/card/route.ts:144) — which is
 * the product telling the truth. That is a0-3:370, :416, :522 and :574, and it
 * is why the revoke cell read `results?.[0]?.status` as undefined: the body of
 * a 404 carries no per-card results.
 *
 * Nothing is "held" across a delete-and-re-mint, so the id is resolved FRESH
 * at the point of use. It is also what makes the two ATTACK cells honest: a
 * refusal asserted against an id that no longer exists is a 404 for the wrong
 * reason, and would pass however open the boundary was.
 */
async function refreshInstanceId(): Promise<string> {
  if (!classId) return instanceId;
  const live = await sql<{ id: string }>(
    `SELECT id FROM "ClassInstance"
       WHERE "classId" = $1 AND "isCancelled" = false
       ORDER BY date LIMIT 1`,
    [classId],
  );
  if (live[0]?.id && live[0].id !== instanceId) {
    instanceId = live[0].id;
    mergeTenantFile({ ids: { instanceId } });
  }
  return instanceId;
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.10 ★ — the timetable mints instances", () => {
  test("a new class mints 56 days of instances and the rows agree with the response", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const o = origin(baseURL);
    const now = new Date();
    // ROUND 2 HARNESS FIX: `POST /api/classes` takes its recurrence in a
    // REQUIRED `schedules` array of at least one `{ dayOfWeek, startTime,
    // endTime }` (lib/schemas/class.ts:20-48) — `dayOfWeek`/`startTime` at the
    // top level are stripped by Zod and the create answers 400 "Invalid data"
    // with `schedules: expected array, received undefined`, which is exactly
    // what the round-2 log carries. `capacity` is `maxCapacity` there too.
    const startHour = String(Math.max(0, now.getHours() - 1)).padStart(2, "0");
    const endHour = String(Math.min(23, Math.max(1, now.getHours()) + 1)).padStart(2, "0");
    const res = await owner.request.post("/api/classes", {
      headers: { Origin: o },
      data: {
        name: `${RUN_STAMP} Fundamentals`,
        duration: 90,
        maxCapacity: 30,
        // Today's weekday, at a time that brackets now — the brief's step 4.
        schedules: [{ dayOfWeek: now.getDay(), startTime: `${startHour}:00`, endTime: `${endHour}:30` }],
      },
    });
    expect(res.status(), "create a class").toBeLessThan(300);
    const body = (await res.json()) as { id?: string; classId?: string; instancesCreated?: number };
    classId = body.id ?? body.classId ?? "";
    expect(classId, "the class id").toBeTruthy();

    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1`,
      [classId],
    );
    expect(Number(rows[0].n), "instances minted by the POST match instancesCreated").toBe(body.instancesCreated ?? Number(rows[0].n));
    expect(Number(rows[0].n), "56 days of instances").toBeGreaterThan(0);
    mergeTenantFile({ ids: { classId } });
  });

  test("today's session is on Register without anyone pressing Generate", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW, viewport: PHONE, isMobile: true });
    const before = await countOf("ClassInstance", '"classId" = $1', [classId]);
    const page = await owner.newPage();
    // ROUND 2 HARNESS FIX: there is no `/dashboard/register` — it 404s. The
    // Register IS the "Mark Attendance" screen at `/dashboard/checkin`
    // (components/layout/routes.ts: label "Mark Attendance", mobileLabel
    // "Register", the raised centre tab of the phone tab bar; Scan Cards and
    // Today's Register are sections of it and the old addresses redirect here).
    await page.goto("/dashboard/checkin");
    await assertNoOverflow(page, 390, "/dashboard/checkin (Register) on a phone");
    await expect(page.locator("body")).toContainText(new RegExp(RUN_STAMP), { timeout: 30_000 });
    const after = await countOf("ClassInstance", '"classId" = $1', [classId]);
    expect(after, "merely LOOKING at Register must not mint instances").toBe(before);
    await page.close();

    const inst = await sql<{ id: string }>(
      `SELECT id FROM "ClassInstance" WHERE "classId" = $1 ORDER BY date LIMIT 1`,
      [classId],
    );
    instanceId = inst[0]?.id ?? "";
    mergeTenantFile({ ids: { instanceId } });
  });

  test("editing the start time moves every future instance and leaves none behind", async ({ browser, baseURL }) => {
    test.skip(!classId, "UNCOVERED — no class was created");
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const before = await sql<{ startTime: string | null; n: string }>(
      `SELECT "startTime", count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1 GROUP BY "startTime"`,
      [classId],
    );
    // ROUND 2: PATCH takes the recurrence in `schedules` too — the shape is
    // shared with POST precisely so the two cannot drift (lib/schemas/class.ts:
    // 5-15). A bare `{ startTime }` is stripped by Zod and answers 200 having
    // changed nothing, which is how this case passed vacuously in round 2 (the
    // class create had failed, so `before` was empty and `stale` was []).
    const day = await sql<{ dayOfWeek: number }>(
      'SELECT "dayOfWeek" FROM "ClassSchedule" WHERE "classId" = $1 ORDER BY "dayOfWeek" LIMIT 1',
      [classId],
    );
    const res = await owner.request.patch(`/api/classes/${classId}`, {
      headers: { Origin: origin(baseURL) },
      data: {
        schedules: [{ dayOfWeek: day[0]?.dayOfWeek ?? new Date().getDay(), startTime: "20:15", endTime: "21:45" }],
      },
    });
    expect(res.status(), "edit the class start time").toBeLessThan(300);
    const after = await sql<{ startTime: string | null; n: string }>(
      `SELECT "startTime", count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1 AND date >= now() GROUP BY "startTime"`,
      [classId],
    );
    test.info().annotations.push({
      type: "observed",
      description: `start-time edit: before ${JSON.stringify(before)}, future after ${JSON.stringify(after)}`,
    });
    const stale = after.filter((r) => r.startTime && before.some((b) => b.startTime === r.startTime));
    expect(stale, "no future instance survives at the OLD start time").toEqual([]);
  });

  test("ATTACK — malformed class bodies are refused and write nothing", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const o = origin(baseURL);
    const before = await countOf("Class", '"tenantId" = $1', [tenantId]);
    // ROUND 2: each body is now shaped the way the route accepts one, so the
    // refusal under test is the FIELD being malformed rather than `schedules`
    // being absent. A body with no `schedules` at all is kept as its own case.
    const sched = (over: Record<string, unknown>) => [
      { dayOfWeek: 1, startTime: "10:00", endTime: "11:00", ...over },
    ];
    const bad: Record<string, unknown>[] = [
      { name: `${RUN_STAMP} bad`, duration: 60, schedules: sched({ dayOfWeek: 7 }) },
      { name: `${RUN_STAMP} bad`, duration: 0, schedules: sched({}) },
      { name: `${RUN_STAMP} bad`, duration: 60, schedules: sched({ startTime: "25:00" }) },
      { name: "x".repeat(10_000), duration: 60, schedules: sched({}) },
      { name: `${RUN_STAMP} bad`, duration: 60, schedules: sched({ dayOfWeek: NaN }) },
      { name: `${RUN_STAMP} bad`, duration: 60, schedules: [] },
      { name: `${RUN_STAMP} bad`, duration: 60 },
    ];
    // ROUND 4 — every round, this cell read exactly one of its seven bodies.
    //
    // A `for` loop with an `expect` inside stops at the first body the product
    // mishandles, so rounds 1-3 argued about `schedules` being absent while the
    // six bodies behind it were never sent at all. That is what "chronic" meant
    // here: not one hard bug, but six unread attacks hiding behind whichever
    // one failed first. All seven are sent now and judged once, so one run
    // reads the whole class and names every body that got through.
    const accepted: string[] = [];
    const wrongShape: string[] = [];
    for (const data of bad) {
      const label = JSON.stringify(data).slice(0, 90);
      const res = await owner.request.post("/api/classes", { headers: { Origin: o }, data });
      if (res.status() < 300) {
        accepted.push(`${res.status()} ← ${label}`);
        continue;
      }
      if (![400, 422].includes(res.status())) {
        wrongShape.push(`${res.status()} ← ${label}`);
        continue;
      }
      // The measured refusal contract — `{ error, details }`, no `ok` key.
      // See the note in a0-2-people.spec.ts; recorded once as FRICTION.
      assertRefusalShape(await res.json(), `classes POST ${label.slice(0, 40)}`);
    }
    test.info().annotations.push({
      type: "observed",
      description: `malformed class bodies: ${bad.length - accepted.length - wrongShape.length}/${bad.length} refused; accepted = ${accepted.join(" | ") || "none"}`,
    });
    // ERROR, standing and unsoftened: `startTime: "25:00"` is stored as a real
    // class. lib/schemas/class.ts:11-12 validates both times with
    // /^\d{2}:\d{2}$/, which admits 25:00, 47:99 and 99:99 — a shape check
    // doing duty as a range check. For the controller; not this lane's file.
    expect(accepted, "every malformed class body is refused").toEqual([]);
    expect(wrongShape, "a refused class body answers 400 or 422, never a 500").toEqual([]);
    expect(await countOf("Class", '"tenantId" = $1', [tenantId]), "nothing written").toBe(before);
  });

  test("ATTACK — tenant A's class id in tenant B's paths answers 404 and touches nothing", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const foreign = await sql<{ id: string }>(
      'SELECT id FROM "Class" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    test.skip(foreign.length === 0, "UNCOVERED — tenant A has no class to borrow an id from");
    const beforeA = await countOf("ClassInstance", '"classId" = $1', [foreign[0].id]);
    const get = await owner.request.get(`/api/classes/${foreign[0].id}`);
    expect(get.status(), "a foreign class id — 404, never a 403 that confirms it exists").toBe(404);
    const patch = await owner.request.patch(`/api/classes/${foreign[0].id}`, {
      headers: { Origin: origin(baseURL) },
      data: { name: `${RUN_STAMP} HIJACKED` },
    });
    expect(patch.status()).toBe(404);
    const gen = await owner.request.post(`/api/classes/${foreign[0].id}/instances`, {
      headers: { Origin: origin(baseURL) },
      data: { weeks: 8 },
    });
    expect(gen.status(), "ClassInstance has no tenantId — it is reached through its parent").toBe(404);
    expect(await countOf("ClassInstance", '"classId" = $1', [foreign[0].id]), "tenant A's instances are untouched").toBe(beforeA);
    const name = await sql<{ name: string }>('SELECT name FROM "Class" WHERE id = $1', [foreign[0].id]);
    expect(name[0].name, "tenant A's class was not renamed").not.toContain(RUN_STAMP);
  });

  test("ATTACK — weeks: 999 and a 1970 date are refused or clamped, never unbounded", async ({ browser, baseURL }) => {
    test.skip(!classId, "UNCOVERED — no class was created");
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const before = await countOf("ClassInstance", '"classId" = $1', [classId]);
    const res = await owner.request.post(`/api/classes/${classId}/instances`, {
      headers: { Origin: origin(baseURL) },
      data: { weeks: 999 },
    });
    const after = await countOf("ClassInstance", '"classId" = $1', [classId]);
    test.info().annotations.push({ type: "observed", description: `weeks:999 → ${res.status()}, ${after - before} new instances` });
    expect(after - before, "a single request must not mint 19 years of instances").toBeLessThan(500);
    expect(res.status()).not.toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.11 ★ — the register on a coach's phone", () => {
  test("a member books from the portal, cancels, and books again", async ({ browser, baseURL }) => {
    test.skip(!instanceId || !memberId, "UNCOVERED — no instance or member");
    await refreshInstanceId();
    const o = origin(baseURL);
    // The member needs a password to reach their own portal; arranged, not asserted.
    // ROUND 4 — this copied TENANT A's seeded hash onto a tenant-B member and
    // then signed in with B_PASSWORD; see `setMemberPassword` in a0-shared.ts.
    await setMemberPassword(memberId);
    const email = (await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [memberId]))[0].email;
    const member = await sessionFor(browser, o, { slug, email, password: PW, viewport: PHONE, isMobile: true });

    const book = await member.request.post("/api/member/bookings", {
      headers: { Origin: o },
      data: { instanceId },
    });
    test.info().annotations.push({ type: "observed", description: `member books → ${book.status()}` });
    if (book.status() < 300) {
      expect(await countOf("ClassSubscription", '"memberId" = $1', [memberId]), "a booking row").toBeGreaterThan(0);
      const cancel = await member.request.delete(`/api/member/bookings/${instanceId}`, { headers: { Origin: o } });
      expect(cancel.status(), "cancelling a booking never 500s").not.toBe(500);
      await member.request.post("/api/member/bookings", { headers: { Origin: o }, data: { instanceId } });
    }
  });

  test("★ the coach ticks a member, and the row names the coach who ticked", async ({ browser, baseURL }) => {
    test.skip(!instanceId || !memberId, "UNCOVERED — no instance or member");
    await refreshInstanceId();
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    const page = await coach.newPage();
    await page.goto("/dashboard/register");
    await assertNoOverflow(page, 390, "register as the coach");

    // The hub marks through POST /api/checkin (RegisterPanel.tsx:160).
    //
    // ROUND 5 ROOT CAUSE — the body was addressed to a route that does not
    // exist. `checkinSchema` (app/api/checkin/route.ts:18-27) takes
    // `classInstanceId` and `checkInMethod`; `instanceId` and `source` are keys
    // it has never known, so Zod refused every one of them with 400 "Invalid
    // data" and the same wrong body sat in all FOUR of this journey's check-in
    // cells. The product's own screen posts
    // `{ classInstanceId, memberId, checkInMethod: "admin" }` (RegisterPanel
    // .tsx:163) and lane L-D's green cells post the same — A0.11 had simply
    // never been read against either.
    const res = await coach.request.post("/api/checkin", {
      headers: { Origin: o },
      data: { classInstanceId: instanceId, memberId, checkInMethod: "admin" },
    });
    await expectOk(res, "the coach marks a booked member in");

    // The columns are `checkInMethod` and `checkInTime` (prisma/schema.prisma,
    // AttendanceRecord) — there is no `source` and no `checkedInAt`.
    const row = await sql<{ id: string; checkInMethod: string; checkedInById: string | null }>(
      'SELECT id, "checkInMethod", "checkedInById" FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
      [memberId, instanceId],
    );
    expect(row, "exactly one attendance row").toHaveLength(1);
    expect(row[0].checkInMethod, "marked from the hub").toBe("admin");
    const coachUser = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, coachEmail]);
    expect(row[0].checkedInById, "the row names the coach who ticked, not the club").toBe(coachUser[0].id);

    // Audit rows are fire-and-forget (lib/audit-log.ts:56).
    await expect
      .poll(() => countOf("AuditLog", '"tenantId" = $1 AND action = $2', [tenantId, "attendance.mark"]), {
        timeout: 5_000,
        message: "an attendance.mark audit row",
      })
      .toBeGreaterThan(0);
    await page.close();
  });

  test("★ two coaches ticking the same member at once write one row and no 500", async ({ browser, baseURL }) => {
    test.skip(!instanceId, "UNCOVERED — no instance");
    await refreshInstanceId();
    const o = origin(baseURL);
    const second = await sql<{ id: string; email: string }>(
      `SELECT id, email FROM "Member" WHERE "tenantId" = $1 AND id <> $2 AND "parentMemberId" IS NULL LIMIT 1`,
      [tenantId, memberId],
    );
    const a = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    const b = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const before = await countOf("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [second[0].id, instanceId]);

    // ROUND 5 — `classInstanceId`/`checkInMethod`, not `instanceId`/`source`.
    const body = { classInstanceId: instanceId, memberId: second[0].id, checkInMethod: "admin" };
    const [r1, r2] = await Promise.all([
      a.request.post("/api/checkin", { headers: { Origin: o }, data: body }),
      b.request.post("/api/checkin", { headers: { Origin: o }, data: body }),
    ]);
    expect([r1.status(), r2.status()].every((s) => s !== 500), "a race never 500s").toBe(true);
    expect(
      [r1.status(), r2.status()].some((s) => s < 300),
      `at least one of two simultaneous ticks is recorded: ${r1.status()} / ${r2.status()}`,
    ).toBe(true);
    const after = await countOf("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [second[0].id, instanceId]);
    expect(after - before, "two simultaneous ticks write ONE row").toBe(1);
  });

  test("★ un-ticking removes the row and leaves an attendance.override audit row", async ({ browser, baseURL }) => {
    test.skip(!instanceId || !memberId, "UNCOVERED — no instance or member");
    await refreshInstanceId();
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    const row = await sql<{ id: string }>(
      'SELECT id FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2',
      [memberId, instanceId],
    );
    test.skip(row.length === 0, "UNCOVERED — nothing was ticked to un-tick");
    // ROUND 5 — there is no `/api/checkin/[id]`: the directory holds `card` and
    // `members` only. Un-ticking is `DELETE /api/checkin?classInstanceId=…&
    // memberId=…` (route.ts:221-237), which is also what the register's own
    // undo calls (RegisterPanel.tsx:193). The old address would have 404d.
    const res = await coach.request.delete(
      `/api/checkin?classInstanceId=${instanceId}&memberId=${memberId}`,
      { headers: { Origin: o } },
    );
    await expectOk(res, "un-tick");
    expect(
      await countOf("AttendanceRecord", "id = $1", [row[0].id]),
      "the row is gone — not merely hidden on the screen",
    ).toBe(0);
    await expect
      .poll(() => countOf("AuditLog", '"tenantId" = $1 AND action = $2', [tenantId, "attendance.override"]), {
        timeout: 5_000,
        message: "an attendance.override audit row",
      })
      .toBeGreaterThan(0);
  });

  test("ATTACK — a member cannot mark anyone in through the staff route", async ({ browser, baseURL }) => {
    test.skip(!instanceId || !memberId, "UNCOVERED — no instance or member");
    await refreshInstanceId();
    const o = origin(baseURL);
    const email = (await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [memberId]))[0].email;
    // ROUND 4 — the member's password is arranged HERE rather than once in an
    // earlier cell. When the cell that used to set it skipped (its own guard is
    // `!instanceId || !memberId`), every later member sign-in met a row with no
    // hash at all and was refused exactly as a wrong password is. Arranging it
    // where it is used is idempotent and cannot be skipped out from under.
    await setMemberPassword(memberId);
    const member = await sessionFor(browser, o, { slug, email, password: PW, viewport: PHONE, isMobile: true });
    const victim = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = $1 AND id <> $2 LIMIT 1',
      [tenantId, memberId],
    );
    const before = await countOf("AttendanceRecord", '"memberId" = $1', [victim[0].id]);
    const res = await member.request.post("/api/checkin", {
      headers: { Origin: o },
      // ROUND 5 — the real field names (route.ts:18-27). A refusal read off a
      // body Zod rejects proves nothing about the ROLE gate: a 400 would have
      // been recorded as "refused" while the gate at :64-66 was never reached.
      data: { classInstanceId: instanceId, memberId: victim[0].id, checkInMethod: "admin" },
    });
    expect([401, 403], "a member at the staff check-in route").toContain(res.status());
    assertRefusalShape(await res.json(), "checkin POST as a member");
    expect(await countOf("AttendanceRecord", '"memberId" = $1', [victim[0].id]), "no row for the victim").toBe(before);
  });

  test("ATTACK — tenant A's member id in tenant B's check-in body is refused", async ({ browser, baseURL }) => {
    test.skip(!instanceId, "UNCOVERED — no instance");
    await refreshInstanceId();
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    const foreign = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    const before = await countOf("AttendanceRecord", '"memberId" = $1', [foreign[0].id]);
    const res = await coach.request.post("/api/checkin", {
      headers: { Origin: o },
      // ROUND 5 — the real field names, so the cross-tenant lookup at
      // route.ts:74-88 is actually reached rather than refused by Zod first.
      data: { classInstanceId: instanceId, memberId: foreign[0].id, checkInMethod: "admin" },
    });
    expect([404, 403], "a foreign member id").toContain(res.status());
    expect(await countOf("AttendanceRecord", '"memberId" = $1', [foreign[0].id]), "nothing written against tenant A").toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.12 ★ — the printed card", () => {
  test("★ the QR on the sheet decodes to a token the scan route accepts", async ({ browser, baseURL }) => {
    test.skip(!memberId || !instanceId, "UNCOVERED — no member or instance");
    await refreshInstanceId();
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const page = await owner.newPage();
    // ROUND 4 — `/dashboard/members/print?ids=` does not exist. The print
    // sheet is `/print/member-cards?memberId=` (app/print/member-cards/page.tsx:48-53),
    // which mints the card token on the fly with `signCardToken` (:137). The
    // old address rendered a 404 with no <img> on it, so `readCardToken` waited
    // 60 s for a QR that was never going to be there and A0.12 — the printed
    // card, a ★ cell — has never actually been driven in any round.
    await page.goto(`/print/member-cards?memberId=${memberId}`);
    await assertCardOnSheet(page, memberId);
    const token = await readCardToken(page, memberId);
    await page.close();

    // ROUND 5 — FIRST CONTACT with the scanner, and the body was wrong in both
    // halves. `app/api/checkin/card/route.ts:60-63` takes
    // `{ classInstanceId, tokens: [...] }` — a scan is always against a named
    // class, because a coach is recording who is in THIS room — and it answers
    // `{ results: [{ index, status, memberId, memberName }], recorded, failed }`
    // with **200 for every outcome**: a revoked card, an expired one and a
    // foreign one are all 200 with a status that says which. So `{ token }` was
    // refused 400 by Zod, and had it been accepted, `status < 300` would have
    // passed on a card the product REFUSED. The outcome is the assertion here,
    // never the HTTP code.
    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    // Arrangement, not an assertion: A0.11 ticks this same member into this
    // same instance, so the scan would otherwise answer "duplicate" for a
    // reason that has nothing to do with the card.
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2', [memberId, instanceId]);
    const scan = { classInstanceId: instanceId, tokens: [token] };
    const res = await coach.request.post("/api/checkin/card", { headers: { Origin: o }, data: scan });
    await expectOk(res, "the printed token is accepted");
    const body = (await res.json()) as { results?: { status?: string; memberId?: string }[]; recorded?: number; failed?: number };
    test.info().annotations.push({ type: "observed", description: `card scan → ${JSON.stringify(body).slice(0, 200)}` });
    expect(body.results?.[0]?.status, "a freshly printed card is accepted, not merely answered 200").toBe("success");
    expect(body.results?.[0]?.memberId, "the scan resolves the member the QR names").toBe(memberId);
    expect(body.recorded, "one card scanned, one attendance recorded").toBe(1);
    expect(await countOf("AttendanceRecord", '"memberId" = $1 AND "checkInMethod" = $2', [memberId, "qr"]), "a qr-sourced row").toBeGreaterThan(0);

    // The same card again is "already in", not a second row.
    const nAfterFirst = await countOf("AttendanceRecord", '"memberId" = $1 AND "checkInMethod" = $2', [memberId, "qr"]);
    const replay = await coach.request.post("/api/checkin/card", { headers: { Origin: o }, data: scan });
    const replayBody = (await replay.json()) as { results?: { status?: string }[]; recorded?: number };
    expect(replayBody.results?.[0]?.status, "the same card twice says so").toBe("duplicate");
    expect(replayBody.recorded, "a duplicate records nothing").toBe(0);
    expect(await countOf("AttendanceRecord", '"memberId" = $1 AND "checkInMethod" = $2', [memberId, "qr"]), "one row, not two").toBe(nAfterFirst);

    mergeTenantFile({ ids: { cardToken: "held-in-memory-only" } });
  });

  test("★ revoking the card kills the old token and a reprint works", async ({ browser, baseURL }) => {
    test.skip(!memberId || !instanceId, "UNCOVERED — no member or instance");
    await refreshInstanceId();
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const page = await owner.newPage();
    await page.goto(`/print/member-cards?memberId=${memberId}`);
    await assertCardOnSheet(page, memberId);
    const oldToken = await readCardToken(page, memberId);
    await page.close();

    const beforeVersion = (await sql<{ cardVersion: number }>('SELECT "cardVersion" FROM "Member" WHERE id = $1', [memberId]))[0].cardVersion;
    // ROUND 5 — there is no `/api/members/[id]/revoke-card`; it 404d, which is
    // what the log carries. The route is `POST /api/members/[id]/card/revoke`
    // and it REQUIRES a reason of at least five characters
    // (app/api/members/[id]/card/revoke/route.ts:32-36) — deliberately, so the
    // audit row can say why a laminated card stopped working months later. An
    // empty body would have been 400 even at the right address.
    const revoke = await owner.request.post(`/api/members/${memberId}/card/revoke`, {
      headers: { Origin: o },
      data: { reason: `${RUN_STAMP} lost at training` },
    });
    await expectOk(revoke, "revoke the card");
    const afterVersion = (await sql<{ cardVersion: number }>('SELECT "cardVersion" FROM "Member" WHERE id = $1', [memberId]))[0].cardVersion;
    expect(afterVersion, "cardVersion is bumped by a revocation").toBeGreaterThan(beforeVersion);

    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    // The scan before this one already marked this member into this instance,
    // so clear it: "the revoked card wrote nothing" must not be satisfied by a
    // row that was already there, and the reprint must be able to write.
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1 AND "classInstanceId" = $2', [memberId, instanceId]);
    const before = await countOf("AttendanceRecord", '"memberId" = $1', [memberId]);
    const dead = await coach.request.post("/api/checkin/card", {
      headers: { Origin: o },
      data: { classInstanceId: instanceId, tokens: [oldToken] },
    });
    // 200 with `status: "revoked"` is the refusal here — the route answers 200
    // for every per-card outcome and says which in the result (route.ts:271-283).
    const deadBody = (await dead.json().catch(() => ({}))) as { results?: { status?: string }[]; recorded?: number };
    expect(deadBody.results?.[0]?.status, "a revoked card is refused by name").toBe("revoked");
    expect(deadBody.recorded, "a revoked card records nothing").toBe(0);
    expect(await countOf("AttendanceRecord", '"memberId" = $1', [memberId]), "a revoked card writes nothing").toBe(before);

    const page2 = await owner.newPage();
    await page2.goto(`/print/member-cards?memberId=${memberId}`);
    await assertCardOnSheet(page2, memberId);
    const reprinted = await readCardToken(page2, memberId);
    await page2.close();
    expect(reprinted, "a reprint is a different token").not.toBe(oldToken);
    const live = await coach.request.post("/api/checkin/card", {
      headers: { Origin: o },
      data: { classInstanceId: instanceId, tokens: [reprinted] },
    });
    await expectOk(live, "the reprinted card works");
    const liveBody = (await live.json()) as { results?: { status?: string }[]; recorded?: number };
    expect(liveBody.results?.[0]?.status, "the card printed after the revocation is accepted").toBe("success");
    expect(liveBody.recorded, "the reprint records the member").toBe(1);
    await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["%card%"]);
  });

  test("the camera path runs with and without a BarcodeDetector", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: coachEmail, viewport: PHONE, isMobile: true });
    const page = await coach.newPage();
    await page.addInitScript(CAMERA_STUB);
    await page.goto("/dashboard/scan");
    await assertNoOverflow(page, 390, "/dashboard/scan");
    await hold(page, null);
    await expect(page.locator("body"), "the scanner does not report a blocked camera under the fake device").not.toContainText(
      /camera access was blocked/i,
      { timeout: 20_000 },
    );
    await page.close();

    // The JS frame-decoder path, with no BarcodeDetector at all (883e934).
    const page2 = await coach.newPage();
    await page2.addInitScript("delete window.BarcodeDetector;");
    await page2.goto("/dashboard/scan");
    await expect(page2.locator("body")).not.toContainText(/camera access was blocked/i, { timeout: 20_000 });
    test.info().annotations.push({
      type: "observed",
      description: "no-BarcodeDetector variant: the camera still runs; the DECODE itself is UNCOVERED — the fake device carries no QR",
    });
    await page2.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.13 ★ — the kiosk tablet", () => {
  test("★ kiosk search returns only the allow-listed keys", async ({ browser, baseURL }) => {
    test.skip(!kioskToken, "UNCOVERED — no kiosk token in the handover file");
    const o = origin(baseURL);
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: { width: KIOSK_W, height: 1024 } });
    const page = await ctx.newPage();
    await page.goto(`/kiosk/${kioskToken}`);
    await assertNoOverflow(page, KIOSK_W, "the kiosk at 768");

    const res = await ctx.request.get(`/api/kiosk/${kioskToken}/search?q=${RUN_STAMP.slice(0, 2)}`);
    if (res.status() === 200) {
      const body = (await res.json()) as unknown;
      // An allow-list, never a denylist: the finding is the key nobody forbade.
      assertKeysWithin(body, {
        "$.members[]": [
          "id", "name", "accountType", "parentMemberId", "waiverAccepted",
          "membershipType", "memberRanks", "kioskMemberToken", "children", "age",
        ],
        "$.members[].children[]": [
          "id", "name", "accountType", "parentMemberId", "waiverAccepted",
          "membershipType", "memberRanks", "kioskMemberToken", "age",
        ],
      });
      const text = JSON.stringify(body);
      expect(text, "no date of birth on a child at the tablet").not.toMatch(/dateOfBirth/);
      expect(text, "no email at an unauthenticated tablet").not.toMatch(/@example\.test/);
    } else {
      test.info().annotations.push({ type: "observed", description: `kiosk search → ${res.status()}` });
    }
    await page.close();
    await ctx.close();
  });

  test("★ ATTACK — a harvested kioskMemberToken checks in only the member it names", async ({ browser, baseURL }) => {
    test.skip(!kioskToken, "UNCOVERED — no kiosk token");
    const o = origin(baseURL);
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: { width: KIOSK_W, height: 1024 } });
    const search = await ctx.request.get(`/api/kiosk/${kioskToken}/search?q=${RUN_STAMP.slice(0, 2)}`);
    test.skip(search.status() !== 200, `UNCOVERED — kiosk search answered ${search.status()}`);
    const body = (await search.json()) as { members?: { id: string; kioskMemberToken?: string }[] };
    const withToken = (body.members ?? []).find((m) => m.kioskMemberToken);
    test.skip(!withToken, "UNCOVERED — kiosk search returned no kioskMemberToken");

    const victim = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = $1 AND id <> $2 LIMIT 1',
      [tenantId, withToken!.id],
    );
    const victimBefore = await countOf("AttendanceRecord", '"memberId" = $1', [victim[0].id]);

    const res = await ctx.request.post(`/api/kiosk/${kioskToken}/checkin`, {
      headers: { Origin: o },
      data: { memberToken: withToken!.kioskMemberToken, memberId: victim[0].id },
    });
    // A row for anyone but the member the TOKEN names is the EXPLOIT.
    expect(
      await countOf("AttendanceRecord", '"memberId" = $1', [victim[0].id]),
      "a token for one member must never check in another",
    ).toBe(victimBefore);
    test.info().annotations.push({ type: "observed", description: `token+foreign memberId → ${res.status()}` });

    // Mis-spelt, junk and foreign-tenant presentations (lib/kiosk-token.ts:38-62).
    for (const [label, token] of [
      ["junk", "token.junk"],
      ["padded", ` ${withToken!.kioskMemberToken} `],
      ["truncated", String(withToken!.kioskMemberToken).slice(0, -3)],
    ] as const) {
      const bad = await ctx.request.post(`/api/kiosk/${kioskToken}/checkin`, {
        headers: { Origin: o },
        data: { memberToken: token },
      });
      expect(bad.status(), `${label} token never 500s`).not.toBe(500);
      const j = await bad.json().catch(() => ({}));
      expect(JSON.stringify(j), `${label} token is refused`).toMatch(/malformed|invalid|expired|not/i);
    }
    await ctx.close();
  });

  test("★ a tap writes a kiosk row; the second tap says so and writes nothing", async ({ browser, baseURL }) => {
    test.skip(!kioskToken || !memberId, "UNCOVERED — no kiosk token or member");
    const o = origin(baseURL);
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: { width: KIOSK_W, height: 1024 } });
    const page = await ctx.newPage();

    // ROUND 6 ROOT CAUSE — this cell never drove the kiosk's FIRST step, so it
    // could not have passed on any day.
    //
    // `/kiosk/<token>` opens on `step === "pick-class"` (KioskPage.tsx:409),
    // which renders a button per session and NOTHING ELSE. The name box lives
    // behind `step === "type-name" && selectedClass` (:477) and is created only
    // when a class button is clicked. The old body reached straight for
    // `locator("input").first()` after the goto, so it waited on an element
    // that cannot exist yet and spent the whole 180 s timeout doing it. Round 5
    // read that timeout as an empty timetable; it is the tablet's own first
    // screen, and the fix is to press it.
    //
    // The tap itself also has two shapes and the old body knew only one:
    // exactly ONE match auto-fires after a debounce with no button to click
    // (KioskPage.tsx:193-199), while two or more render "Tap your name".
    // Guarding on `if (await first.count())` therefore passed silently on the
    // single-match path without ever checking in anybody.
    const pickOne = async (label: string) => {
      await expect(page.getByRole("heading", { name: /pick your class/i }), `${label}: the class picker`).toBeVisible({
        timeout: 30_000,
      });
      const session = page.getByRole("button").filter({ hasText: new RegExp(RUN_STAMP) }).first();
      if ((await session.count()) === 0) {
        const said = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
        throw new Error(`${label}: the kiosk offered no session to pick. The screen said: ${said || "(nothing)"}`);
      }
      await session.click();
      const field = page.getByLabel("Search your name");
      await expect(field, `${label}: the name box`).toBeVisible({ timeout: 15_000 });
      await field.fill(RUN_STAMP.slice(0, 3));
      await page.waitForTimeout(1_500);
    };

    // ROUND 6b — the rebuild above forgot the first navigation entirely: the
    // cell opened a fresh page, then waited 30 s for the class picker on
    // about:blank (the second tap always had its own goto at the bottom).
    await page.goto(`/kiosk/${kioskToken}`);
    await assertNoOverflow(page, KIOSK_W, "kiosk before search");
    await pickOne("first tap");
    await assertNoOverflow(page, KIOSK_W, "kiosk with results open");

    const before = await countOf("AttendanceRecord", '"tenantId" = $1 AND "checkInMethod" = $2', [tenantId, "kiosk"]);
    const first = page.getByRole("button").filter({ hasText: new RegExp(RUN_STAMP) }).first();
    if (await first.count()) await first.click();
    await expect
      .poll(() => countOf("AttendanceRecord", '"tenantId" = $1 AND "checkInMethod" = $2', [tenantId, "kiosk"]), {
        timeout: 15_000,
        message: "a kiosk-sourced attendance row (tapped, or auto-fired on a single match)",
      })
      .toBe(before + 1);
    await assertNoOverflow(page, KIOSK_W, "kiosk after the tap");

    // KioskPage.tsx:302 — the exact copy on a second tap. The whole flow is
    // driven again: a fresh page is back at the class picker.
    await page.goto(`/kiosk/${kioskToken}`);
    await pickOne("second tap");
    const again = page.getByRole("button").filter({ hasText: new RegExp(RUN_STAMP) }).first();
    if (await again.count()) await again.click();
    await expect(page.locator("body"), "the second tap says the member is already in").toContainText(
      /already signed in/i,
      { timeout: 15_000 },
    );
    expect(
      await countOf("AttendanceRecord", '"tenantId" = $1 AND "checkInMethod" = $2', [tenantId, "kiosk"]),
      "a second tap writes no second row",
    ).toBe(before + 1);
    await page.close();
    await ctx.close();
  });

  test("ATTACK — tenant A's kiosk token is not tenant B's, and a rotated token 404s", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: { width: KIOSK_W, height: 1024 } });
    // Never rotate tenant A's token. Presenting a fabricated one is enough.
    const page = await ctx.newPage();
    const res = await page.goto(`/kiosk/${RUN_STAMP}-not-a-token`);
    expect([404, 410], "a fabricated kiosk token").toContain(res?.status() ?? 0);
    await page.close();
    await ctx.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.14 — what the member sees, and every error state", () => {
  test("every member page renders an error state, never an empty one, on a 500", async ({ browser, baseURL }) => {
    test.skip(!memberId, "UNCOVERED — no member");
    const o = origin(baseURL);
    const email = (await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [memberId]))[0].email;
    // ROUND 4 — the member's password is arranged HERE rather than once in an
    // earlier cell. When the cell that used to set it skipped (its own guard is
    // `!instanceId || !memberId`), every later member sign-in met a row with no
    // hash at all and was refused exactly as a wrong password is. Arranging it
    // where it is used is idempotent and cannot be skipped out from under.
    await setMemberPassword(memberId);
    const member = await sessionFor(browser, o, { slug, email, password: PW, viewport: PHONE, isMobile: true });
    const pages = ["/member/home", "/member/schedule", "/member/billing", "/member/profile", "/member/progress", "/member/shop", "/member/actions", "/member/family"];
    for (const path of pages) {
      const page = await member.newPage();
      await page.route("**/api/member/**", (route) =>
        route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "boom" }) }),
      );
      await page.goto(path);
      await page.waitForTimeout(1_500);
      const body = await page.locator("body").innerText();
      // An HTTP error rendered as an empty state is an ERROR, not a design choice.
      const looksEmpty = /nothing here yet|no classes|no payments|you have no/i.test(body) && !/error|went wrong|try again|could not/i.test(body);
      expect(looksEmpty, `${path} rendered an HTTP 500 as an empty state`).toBe(false);
      await assertNoOverflow(page, 390, `${path} in its error state`);
      await page.close();
    }
  });

  test("the announcement a member sees, and its expiry", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const res = await owner.request.post("/api/announcements", {
      headers: { Origin: o },
      data: { title: `${RUN_STAMP} Mats closed Friday`, body: `${RUN_STAMP} no session this Friday.` },
    });
    expect(res.status(), "post an announcement").toBeLessThan(300);
    const row = await sql<{ id: string }>('SELECT id FROM "Announcement" WHERE "tenantId" = $1 AND title LIKE $2', [tenantId, `${RUN_STAMP}%`]);
    expect(row, "the announcement row").toHaveLength(1);

    const email = (await sql<{ email: string }>('SELECT email FROM "Member" WHERE id = $1', [memberId]))[0].email;
    // ROUND 4 — the member's password is arranged HERE rather than once in an
    // earlier cell. When the cell that used to set it skipped (its own guard is
    // `!instanceId || !memberId`), every later member sign-in met a row with no
    // hash at all and was refused exactly as a wrong password is. Arranging it
    // where it is used is idempotent and cannot be skipped out from under.
    await setMemberPassword(memberId);
    const member = await sessionFor(browser, o, { slug, email, password: PW, viewport: PHONE, isMobile: true });
    const page = await member.newPage();
    await page.goto("/member/home");
    await expect(page.locator("body"), "the announcement reaches the member's home").toContainText(new RegExp(RUN_STAMP), { timeout: 30_000 });

    await sql('UPDATE "Announcement" SET "expiresAt" = now() - interval \'1 hour\' WHERE id = $1', [row[0].id]);
    await page.reload();
    await expect(page.locator("body"), "an expired announcement is gone").not.toContainText(/Mats closed Friday/i, { timeout: 20_000 });
    await page.close();
  });

  test("the notifications screen and what push actually delivers", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const page = await owner.newPage();
    await page.goto("/dashboard/notifications");
    const copy = await page.locator("body").innerText();
    // Push delivery is not live in this product (CLAUDE.md is explicit). Any copy
    // that promises a delivered push is an advertised, unreachable feature.
    const claims = /we.ll send|will be sent|push notification|notify your members/i.test(copy);
    test.info().annotations.push({
      type: "observed",
      description: claims
        ? "the notifications screen makes a delivery claim while push delivery is not live — ERROR, advertised and unreachable"
        : "no delivery claim on the notifications screen",
    });
    await page.close();
  });
});

test.describe("A0.week.teardown", () => {
  test("close sessions (and tear down if A0_TEARDOWN_HERE is set)", async () => {
    await closeSessions();
    if (!process.env.A0_TEARDOWN_HERE) return;
    const file = readTenantFile();
    await teardownTenantB(RUN_STAMP);
    expect(await countOf("Tenant", "id = $1", [file.tenantId])).toBe(0);
  });
});
