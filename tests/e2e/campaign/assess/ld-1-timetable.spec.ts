/**
 * Lane L-D, file 1 — the timetable column (J31–J35, J41 routing).
 *
 * Lane A0 drives J31/J32 once as the owner on a fresh club. Everything here is
 * the REST of the column: every other role at the route, every malformed body,
 * every cross-tenant path, and the two claims the code makes about itself that
 * nothing has ever checked — that a class is on the timetable the moment it is
 * created, and that the three minting sites cannot fight.
 *
 * Every mutating call carries an explicit `Origin` (Playwright's request context
 * is not a browser and sends none, and `lib/csrf.ts` 403s that before any role
 * gate runs) and `maxRedirects: 0` (an unauthenticated /api/* call is 307'd to
 * /login, and a followed redirect reports the login page's 200 as a success).
 */
import { test, expect } from "@playwright/test";
import {
  OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL, PASSWORD,
  SCOPE, RUN_STAMP, sql, seededTenantId, sessionFor, memberSession, anonContext, closeSessions,
  post, patch, del, get,
  mkClass, mkInstance, mkStaff, mkTenant, teardownClasses, teardownTenant, countRows,
} from "./ld-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

type Fx = {
  tenantId: string;
  ownerHash: string;
  managerEmail: string;
  foreign: { id: string; slug: string };
  foreignClassId: string;
  foreignInstanceId: string;
};
let fx: Fx;
let origin: string;

const NAME = (s: string) => `${SCOPE} ld1 ${s}`;

test.beforeAll(async ({ baseURL }) => {
  origin = baseURL!;
  const tenantId = await seededTenantId();
  const hashRows = await sql<{ passwordHash: string }>(
    'SELECT "passwordHash" FROM "User" WHERE "tenantId" = $1 AND email = $2',
    [tenantId, OWNER_EMAIL],
  );
  if (hashRows.length === 0) throw new Error(`${OWNER_EMAIL} is missing — re-seed the test branch.`);
  const ownerHash = hashRows[0].passwordHash;

  // The seed has no `manager`; borrow the owner's hash so it signs in with the
  // same credential the rest of the suite uses. Deleted in afterAll.
  const manager = await mkStaff(tenantId, "manager", ownerHash);

  // A whole second club, so every cross-tenant probe has a real foreign id to
  // aim at without Lane A0's file having to exist.
  const foreign = await mkTenant();
  const foreignClassId = await mkClass(foreign.id, `${RUN_STAMP} foreign class`);
  const foreignInstanceId = await mkInstance(foreignClassId);

  fx = { tenantId, ownerHash, managerEmail: manager.email, foreign, foreignClassId, foreignInstanceId };
});

test.afterAll(async () => {
  await closeSessions();
  await teardownClasses(fx.tenantId, SCOPE);
  await teardownClasses(fx.tenantId, RUN_STAMP);
  await teardownTenant(fx.foreign.id);
  await sql('DELETE FROM "AuditLog" WHERE "tenantId" = $1 AND metadata::text LIKE $2', [fx.tenantId, `%${SCOPE}%`]).catch(() => {});
  await sql('DELETE FROM "User" WHERE email LIKE $1', [`${SCOPE}-%@example.test`]);
  // Teardown is proved by a SELECT, never by the absence of an error.
  const left = await countRows("Class", '"tenantId" = $1 AND name LIKE $2', [fx.tenantId, `${SCOPE}%`]);
  expect(left, "run-stamped classes survived teardown").toBe(0);
});

// ── J31 · create: the role column, the minimum, the malformed ────────────────

test.describe("J31 create a class", () => {
  const created: string[] = [];

  test("ALLOWED: manager creates at the route and 56 days are minted", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const name = NAME("manager-create");
    const res = await post(ctx.request, "/api/classes", origin, {
      name, duration: 60,
      schedules: [{ dayOfWeek: new Date().getDay(), startTime: "18:00", endTime: "19:00" }],
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    created.push(body.id);

    // The row, not the response. `instancesCreated` is the route's own claim;
    // the count is the product.
    const rows = await sql<{ n: string }>(
      'SELECT count(*)::text AS n FROM "ClassInstance" WHERE "classId" = $1',
      [body.id],
    );
    // ROLLING_WINDOW_DAYS is 56 = 8 weeks, one occurrence per week per slot.
    expect(Number(rows[0].n)).toBe(8);
    expect(body.instancesCreated).toBe(8);

    // A class is on the timetable the moment it is created: today's own slot
    // has an instance, so check-in works now and not from the next cron.
    const today = await sql<{ id: string }>(
      `SELECT id FROM "ClassInstance" WHERE "classId" = $1 AND "startTime" = '18:00' ORDER BY date ASC LIMIT 1`,
      [body.id],
    );
    expect(today.length).toBe(1);
  });

  for (const role of ["coach", "admin", "member"] as const) {
    test(`REFUSED: ${role} cannot create — 403 and nothing written`, async ({ browser, baseURL }) => {
      const ctx = role === "member"
        ? await memberSession(browser, baseURL!)
        : await sessionFor(browser, baseURL!, role === "coach" ? COACH_EMAIL : ADMIN_EMAIL, PASSWORD);
      const name = NAME(`${role}-refused`);
      const before = await countRows("Class", '"tenantId" = $1 AND name = $2', [fx.tenantId, name]);
      const res = await post(ctx.request, "/api/classes", origin, {
        name, duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
      });
      expect(res.status()).toBe(403);
      // This route gates with a raw auth() call, so the body is a bare { error }.
      expect((await res.json()).error).toBe("Forbidden");
      expect(await countRows("Class", '"tenantId" = $1 AND name = $2', [fx.tenantId, name])).toBe(before);
    });
  }

  // The `request` fixture is NOT anonymous — the chromium project carries the
  // owner storageState (playwright.config.ts:100-103), and round 2 proved it:
  // this cell answered 201. Drive anonymous cells from a context with no state.
  test("REFUSED: anonymous — 401, not a followed redirect to /login", async ({ browser, baseURL }) => {
    const anon = await anonContext(browser, baseURL!);
    const request = anon.request;
    const res = await request.post("/api/classes", {
      headers: { Origin: origin }, maxRedirects: 0,
      data: { name: NAME("anon"), duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] },
    });
    expect([307, 401, 403]).toContain(res.status());
    expect(res.status()).not.toBe(201);
    expect(await countRows("Class", 'name = $1', [NAME("anon")])).toBe(0);
    await anon.close();
  });

  test("malformed bodies are refused, and none of them writes", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const before = await countRows("Class", '"tenantId" = $1', [fx.tenantId]);
    const bad: Array<[string, unknown]> = [
      ["dayOfWeek 7", { name: NAME("d7"), duration: 60, schedules: [{ dayOfWeek: 7, startTime: "18:00", endTime: "19:00" }] }],
      ["duration 0", { name: NAME("d0"), duration: 0, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }],
      ["duration 481", { name: NAME("d481"), duration: 481, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }],
      ["no schedules", { name: NAME("nosched"), duration: 60, schedules: [] }],
      ["10 000-char name", { name: "x".repeat(10_000), duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }],
      ["NaN duration", { name: NAME("nan"), duration: "NaN", schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }],
      ["negative duration", { name: NAME("neg"), duration: -60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }],
      ["51 slots", { name: NAME("51"), duration: 60, schedules: Array.from({ length: 51 }, () => ({ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" })) }],
    ];
    for (const [label, data] of bad) {
      const res = await post(ctx.request, "/api/classes", origin, data);
      expect(res.status(), `${label} should be a 400, never a 500`).toBe(400);
    }
    expect(await countRows("Class", '"tenantId" = $1', [fx.tenantId])).toBe(before);
  });

  test("a roster sent on create is stored (was X-7 Task 11: silently dropped)", async ({ browser, baseURL }) => {
    // classCreateSchema (lib/schemas/class.ts:17-40) has no `roster` key, so Zod
    // strips it and POST /api/classes answers 201 with no roster row anywhere.
    // The screen offers the field; the database never receives it.
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const members = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = $1 AND status = $2 LIMIT 1', [fx.tenantId, "active"],
    );
    test.skip(members.length === 0, "no active member in the seeded club to put on a roster");
    const name = NAME("roster-on-create");
    const res = await post(ctx.request, "/api/classes", origin, {
      name, duration: 60,
      schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
      roster: [{ memberId: members[0].id }],
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    created.push(body.id);
    const roster = await countRows("ClassRoster", '"classId" = $1', [body.id]);
    // Fixed in round 1: classCreateSchema keeps `roster` and POST /api/classes
    // writes the ClassRoster rows inside the create transaction.
    expect(roster, "roster sent on create must be stored, or the create must 400").toBe(1);
  });

  test("two creates with the same name both succeed (no unique) and mint their own 8", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const name = NAME("duplicate-name");
    const payload = { name, duration: 60, schedules: [{ dayOfWeek: 2, startTime: "07:00", endTime: "08:00" }] };
    const a = await post(ctx.request, "/api/classes", origin, payload);
    const b = await post(ctx.request, "/api/classes", origin, payload);
    expect(a.status()).toBe(201);
    expect(b.status()).toBe(201);
    const ida = (await a.json()).id as string; const idb = (await b.json()).id as string;
    created.push(ida, idb);
    expect(ida).not.toBe(idb);
    // FRICTION, not an ERROR: two identically-named classes on one timetable.
    expect(await countRows("ClassInstance", '"classId" = $1', [ida])).toBe(8);
    expect(await countRows("ClassInstance", '"classId" = $1', [idb])).toBe(8);
  });
});

// ── J32 · edit, archive, Generate ────────────────────────────────────────────

test.describe("J32 edit, archive, generate", () => {
  test("a start-time move leaves no future instance at the old time", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const day = (new Date().getDay() + 2) % 7;
    const res = await post(ctx.request, "/api/classes", origin, {
      name: NAME("time-move"), duration: 60,
      schedules: [{ dayOfWeek: day, startTime: "18:00", endTime: "19:00" }],
    });
    expect(res.status()).toBe(201);
    const id = (await res.json()).id as string;
    const before = await countRows("ClassInstance", '"classId" = $1 AND "startTime" = $2', [id, "18:00"]);
    expect(before).toBeGreaterThan(0);

    const upd = await patch(ctx.request, `/api/classes/${id}`, origin, {
      schedules: [{ dayOfWeek: day, startTime: "19:00", endTime: "20:00" }],
    });
    expect(upd.status(), await upd.text()).toBe(200);

    const stillOld = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "ClassInstance"
       WHERE "classId" = $1 AND "startTime" = '18:00' AND date >= date_trunc('day', now())`,
      [id],
    );
    expect(Number(stillOld[0].n), "an instance survived at the old start time").toBe(0);
    const atNew = await countRows("ClassInstance", '"classId" = $1 AND "startTime" = $2', [id, "19:00"]);
    expect(atNew).toBe(before);
    // Every marker still lands on the requested weekday.
    const days = await sql<{ dow: string }>(
      `SELECT DISTINCT extract(dow from date)::text AS dow FROM "ClassInstance" WHERE "classId" = $1`, [id],
    );
    expect(days.map((d) => Number(d.dow))).toEqual([day]);
  });

  test("archiving stops new instances being minted", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const res = await post(ctx.request, "/api/classes", origin, {
      name: NAME("archive"), duration: 60,
      schedules: [{ dayOfWeek: 3, startTime: "06:30", endTime: "07:30" }],
    });
    const id = (await res.json()).id as string;
    const gone = await del(ctx.request, `/api/classes/${id}`, origin);
    expect(gone.status()).toBe(200);
    const before = await countRows("ClassInstance", '"classId" = $1', [id]);
    const gen = await post(ctx.request, "/api/instances/generate", origin, { weeks: 8 });
    expect(gen.status()).toBe(200);
    expect(await countRows("ClassInstance", '"classId" = $1', [id]), "an archived class was re-minted").toBe(before);
  });

  test("Generate is idempotent and weeks is bounded", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const first = await post(ctx.request, "/api/instances/generate", origin, { weeks: 4 });
    expect(first.status()).toBe(200);
    const second = await post(ctx.request, "/api/instances/generate", origin, { weeks: 4 });
    expect(second.status()).toBe(200);
    expect((await second.json()).created, "a second identical Generate re-inserted rows").toBe(0);

    // weeks: 999 falls outside z.number().max(52). The route's safeParse failure
    // silently falls back to 4 rather than refusing — recorded as FRICTION.
    const huge = await post(ctx.request, "/api/instances/generate", origin, { weeks: 999 });
    expect(huge.status()).toBe(200);
    const horizon = await sql<{ d: string | null }>(
      `SELECT max(date)::text AS d FROM "ClassInstance" i JOIN "Class" c ON c.id = i."classId" WHERE c."tenantId" = $1`,
      [fx.tenantId],
    );
    const maxDate = horizon[0].d ? new Date(horizon[0].d) : null;
    if (maxDate) {
      const daysOut = (maxDate.getTime() - Date.now()) / 86_400_000;
      expect(daysOut, "weeks:999 minted past the 52-week cap").toBeLessThan(400);
    }
  });

  for (const role of ["coach", "admin", "member"] as const) {
    test(`REFUSED: ${role} cannot PATCH, DELETE or Generate`, async ({ browser, baseURL }) => {
      const ctx = role === "member"
        ? await memberSession(browser, baseURL!)
        : await sessionFor(browser, baseURL!, role === "coach" ? COACH_EMAIL : ADMIN_EMAIL, PASSWORD);
      const cls = await mkClass(fx.tenantId, NAME(`patch-target-${role}`));
      const before = await countRows("ClassInstance", '"classId" = $1', [cls]);
      for (const res of [
        await patch(ctx.request, `/api/classes/${cls}`, origin, { name: NAME("hijacked") }),
        await del(ctx.request, `/api/classes/${cls}`, origin),
        await post(ctx.request, "/api/instances/generate", origin, { weeks: 1 }),
      ]) {
        expect(res.status()).toBe(403);
      }
      const after = await sql<{ name: string; isActive: boolean }>('SELECT name, "isActive" FROM "Class" WHERE id = $1', [cls]);
      expect(after[0].name).toBe(NAME(`patch-target-${role}`));
      expect(after[0].isActive).toBe(true);
      expect(await countRows("ClassInstance", '"classId" = $1', [cls])).toBe(before);
    });
  }

  test("cross-tenant: the seeded manager cannot touch the foreign club's class", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const nameBefore = (await sql<{ name: string }>('SELECT name FROM "Class" WHERE id = $1', [fx.foreignClassId]))[0].name;

    const p = await patch(ctx.request, `/api/classes/${fx.foreignClassId}`, origin, { name: NAME("stolen") });
    expect(p.status(), "a foreign id must answer 404, never 403 (which confirms existence)").toBe(404);

    const g = await get(ctx.request, `/api/classes/${fx.foreignClassId}`);
    expect(g.status()).toBe(404);

    const d = await del(ctx.request, `/api/classes/${fx.foreignClassId}`, origin);
    // Fixed in round 1: DELETE resolves { id, tenantId } before it counts, so a
    // foreign class is a bare 404 and no count reaches the body.
    expect([404], `DELETE answered ${d.status()} for a foreign class: ${await d.text()}`).toContain(d.status());

    const after = await sql<{ name: string; isActive: boolean }>('SELECT name, "isActive" FROM "Class" WHERE id = $1', [fx.foreignClassId]);
    expect(after[0].name).toBe(nameBefore);
    expect(after[0].isActive).toBe(true);
  });

  test("CSRF: a JSON route with no Origin is refused before the role gate", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const name = NAME("csrf-missing-origin");
    const none = await ctx.request.post("/api/classes", {
      maxRedirects: 0,
      data: { name, duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] },
    });
    expect(none.status()).toBe(403);
    const foreignOrigin = await ctx.request.post("/api/classes", {
      headers: { Origin: "http://evil.test" }, maxRedirects: 0,
      data: { name, duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] },
    });
    expect(foreignOrigin.status()).toBe(403);
    expect(await countRows("Class", "name = $1", [name])).toBe(0);
  });
});

// ── J33 · cancel a session ───────────────────────────────────────────────────

test.describe("J33 cancel a session", () => {
  test("ERROR: nothing in the product can set isCancelled", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, fx.managerEmail, PASSWORD);
    const cls = await mkClass(fx.tenantId, NAME("cancel"));
    const inst = await mkInstance(cls);

    // Every route that plausibly owns a cancel, driven with the obvious body.
    const attempts: Array<[string, () => Promise<{ status(): number }>]> = [
      ["PATCH /api/classes/[id] with isCancelled", () => patch(ctx.request, `/api/classes/${cls}`, origin, { isCancelled: true })],
      ["POST /api/classes/[id]/instances with cancel", () => post(ctx.request, `/api/classes/${cls}/instances`, origin, { instanceId: inst, isCancelled: true })],
    ];
    for (const [label, run] of attempts) {
      const res = await run();
      expect([200, 201, 400, 404, 405]).toContain(res.status());
      const row = await sql<{ isCancelled: boolean }>('SELECT "isCancelled" FROM "ClassInstance" WHERE id = $1', [inst]);
      expect(row[0].isCancelled, `${label} set isCancelled — the manifest says nothing can`).toBe(false);
    }
  });

  test("a cancelled session is refused at check-in with a 409", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const cls = await mkClass(fx.tenantId, NAME("cancelled-checkin"));
    const inst = await mkInstance(cls, { isCancelled: true });
    const member = await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 LIMIT 1', [fx.tenantId]);
    test.skip(member.length === 0, "no member in the seeded club");
    const before = await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst]);
    const res = await post(ctx.request, "/api/checkin", origin, { classInstanceId: inst, memberId: member[0].id });
    expect(res.status()).toBe(409);
    expect((await res.json()).error).toContain("cancelled");
    expect(await countRows("AttendanceRecord", '"classInstanceId" = $1', [inst])).toBe(before);
  });
});

// ── J35 · today's sessions ───────────────────────────────────────────────────

test.describe("J35 today's sessions", () => {
  test("every staff role sees today's sessions, materialised on read and idempotent", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    // A class whose only slot is today, with no instance minted by hand.
    const cls = await mkClass(fx.tenantId, NAME("materialise"));
    await sql(
      `INSERT INTO "ClassSchedule" ("id", "classId", "dayOfWeek", "startTime", "endTime", "startDate", "isActive")
       VALUES (gen_random_uuid()::text, $1, $2, '20:15', '21:15', now(), true)`,
      [cls, new Date().getDay()],
    );
    expect(await countRows("ClassInstance", '"classId" = $1', [cls])).toBe(0);

    const first = await get(owner.request, "/api/coach/today");
    expect(first.status()).toBe(200);
    const minted = await countRows("ClassInstance", '"classId" = $1', [cls]);
    expect(minted, "GET /api/coach/today did not materialise today's row").toBe(1);

    const second = await get(owner.request, "/api/coach/today");
    expect(second.status()).toBe(200);
    expect(await countRows("ClassInstance", '"classId" = $1', [cls]), "a second read duplicated the row").toBe(1);

    const listed = (await second.json()) as Array<{ classId: string; status: string }>;
    expect(listed.some((r) => r.classId === cls), "the materialised session is not listed").toBe(true);

    for (const [email, pw] of [[COACH_EMAIL, PASSWORD], [ADMIN_EMAIL, PASSWORD], [fx.managerEmail, PASSWORD]] as const) {
      const ctx = await sessionFor(browser, baseURL!, email, pw);
      const res = await get(ctx.request, "/api/coach/today");
      expect(res.status(), `${email} was refused today's sessions`).toBe(200);
      const rows = (await res.json()) as Array<{ classId: string }>;
      expect(rows.some((r) => r.classId === cls), `${email} cannot see the club's session`).toBe(true);
    }
  });

  test("a class with no active slot contributes nothing", async () => {
    const cls = await mkClass(fx.tenantId, NAME("no-day"));
    expect(await countRows("ClassInstance", '"classId" = $1', [cls])).toBe(0);
  });

  test("REFUSED: a member cannot read the staff register list", async ({ browser, baseURL }) => {
    const ctx = await memberSession(browser, baseURL!);
    const res = await get(ctx.request, "/api/coach/today");
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.ok === false || typeof body.error === "string").toBe(true);
  });

  test("REFUSED: anonymous is not answered with a followed login page", async ({ browser, baseURL }) => {
    const anon = await anonContext(browser, baseURL!);
    const res = await anon.request.get("/api/coach/today", { maxRedirects: 0 });
    expect(res.status()).not.toBe(200);
    expect([307, 401, 403]).toContain(res.status());
    await anon.close();
  });
});

// ── J41 · coach routing ──────────────────────────────────────────────────────

test.describe("J41 coach on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("/dashboard/scan and /dashboard/coach land somewhere real, and the page does not scroll sideways", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, COACH_EMAIL);
    // One page per path. Round 2 ran all three in a single page and the third
    // goto answered `net::ERR_ABORTED`: /dashboard/scan is the card scanner and
    // holds a live getUserMedia stream, and Chromium aborts the navigation that
    // tears it down. A fresh page also stops one route's client state deciding
    // the next route's geometry, which is the thing being measured.
    for (const path of ["/dashboard/checkin", "/dashboard/scan", "/dashboard/coach"]) {
      const page = await ctx.newPage();
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(res?.status(), `${path} answered ${res?.status()}`).toBeLessThan(400);
      // /dashboard/coach is an alias: app/dashboard/coach/page.tsx redirects to
      // /dashboard/checkin (18 Sep 2026). A redirect that lands on a real screen
      // is a pass; a redirect to /login is not.
      expect(page.url(), `${path} bounced to the login page`).not.toContain("/login");
      const [scrollWidth, innerWidth] = await page.evaluate(() => [
        document.documentElement.scrollWidth, window.innerWidth,
      ]);
      expect([scrollWidth, innerWidth], `${path} scrolls sideways at 390`).toEqual([390, 390]);
      await page.close();
    }
  });
});
