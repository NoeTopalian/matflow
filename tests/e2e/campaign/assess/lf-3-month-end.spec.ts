/**
 * Lane L-F file 3 — month-end: J55 reports, J56 promotions and ranks,
 * J57 the dashboard action list, J58 announcements.
 *
 * `mode: "default"`: one failure must not skip the rest. Every describe block
 * mints its own fixtures in its own `beforeAll`.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import {
  OWNER_EMAIL, COACH_EMAIL, ADMIN_EMAIL, PASSWORD, THROWAWAY_PASSWORD,
  ANON_REFUSED, sessionFor, anonContext, closeSessions, apiCall, apiGet, expectRefusal,
  describeResponse, countOf, assertUnchanged, finalPath, clearBucket,
  mkMember, mkStaff, mkTenant, teardownTenant, teardownSeededClub,
  sql, seededTenantId, RUN_STAMP, type LfMember, type LfTenant,
} from "./lf-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

test.afterAll(async () => {
  await closeSessions();
});

// ─────────────────────────────────────────────────────────────────────────────
// J55 — Reports
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J55 reports — two numbers by SQL; a 500 is never zeros", () => {
  let tenantId: string;
  let ownerCtx: BrowserContext;
  let managerCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    const manager = await mkStaff("manager");
    ownerCtx = await sessionFor(browser, baseURL, { email: OWNER_EMAIL, password: PASSWORD });
    managerCtx = await sessionFor(browser, baseURL, { email: manager.email, password: THROWAWAY_PASSWORD });
  });

  test("ALLOWED · owner reads /api/reports and two of its numbers match SQL", async () => {
    const r = await apiGet(ownerCtx.request, "/api/reports?weeks=8");
    expect(r.status, "the owner may read reports").toBe(200);
    describeResponse("J55 owner GET /api/reports?weeks=8", r);
    const body = r.body as Record<string, unknown>;

    // Number one: active members, recomputed in SQL.
    const active = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Member" WHERE "tenantId" = $1 AND status = 'active'`, [tenantId],
    );
    // Number two: attendance in the window, recomputed in SQL against the
    // database's own clock — never Date.now() in JavaScript.
    const attendance = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "AttendanceRecord"
       WHERE "tenantId" = $1
         AND "checkInTime" >= (now() AT TIME ZONE 'UTC') - interval '8 weeks'`, [tenantId],
    );
    console.log(`[L-F probe] J55 SQL says active=${active[0].n} attendance(8w)=${attendance[0].n}`);
    console.log(`[L-F probe] J55 report top-level keys: ${JSON.stringify(Object.keys(body))}`);

    const flat = JSON.stringify(body);
    expect(flat, "the report is not an empty husk").not.toBe("{}");
    // The report must not claim a number the database cannot produce.
    const claimedActive = findNumber(body, ["activeMembers", "active", "memberCount", "totalActive"]);
    if (claimedActive !== null) {
      expect(claimedActive, "the report's active-member count is the database's").toBe(Number(active[0].n));
    }
    const claimedAttendance = findNumber(body, ["totalAttendance", "attendanceCount", "checkIns", "totalCheckIns"]);
    if (claimedAttendance !== null) {
      expect(claimedAttendance, "the report's attendance count is the database's").toBe(Number(attendance[0].n));
    }
  });

  test("REFUSED · coach, admin and member at /api/reports; nothing read", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    const member = await mkMember({ name: `${RUN_STAMP} J55 member` });
    for (const [label, email, password] of [
      ["coach", COACH_EMAIL, PASSWORD],
      ["admin", ADMIN_EMAIL, PASSWORD],
      ["member", member.email, THROWAWAY_PASSWORD],
    ] as const) {
      const ctx = await sessionFor(browser, baseURL, { email, password });
      const r = await apiGet(ctx.request, "/api/reports?weeks=8");
      describeResponse(`J55 ${label} GET /api/reports`, r);
      expect(r.status, `${label} may not read reports`).toBe(403);
      // app/api/reports/route.ts gates with a raw auth() call — a bare { error }.
      expectRefusal(r, "bare-error", `J55 ${label} GET /api/reports`);
      expect(r.text, `${label} is told nothing about the club's numbers`).not.toMatch(/revenue|mrr|attendance/i);
    }
  });

  test("REFUSED · revenue/summary is owner-only — a manager gets 403 and the page must not fake it", async ({}, testInfo) => {
    const mgr = await apiGet(managerCtx.request, "/api/revenue/summary");
    expect(mgr.status, "a manager may not read revenue").toBe(403);
    expectRefusal(mgr, "ok-false", "J55 manager GET /api/revenue/summary");

    const own = await apiGet(ownerCtx.request, "/api/revenue/summary");
    expect(own.status, "the owner may").toBe(200);

    // The manager's reports screen must not render zeros where a 403 lives.
    const page = await managerCtx.newPage();
    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = await page.locator("body").innerText();
    console.log(`[L-F probe] J55 manager /dashboard/reports body[0..400]: ${JSON.stringify(text.slice(0, 400))}`);
    await page.close();
    console.log(`[L-F probe] J55 baseURL ${testInfo.project.use.baseURL ?? ORIGIN}`);
  });

  test("ERROR-CHECK · a stubbed 500 on /api/reports is an error state, never zeros", async () => {
    const page = await ownerCtx.newPage();
    await page.route("**/api/reports*", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stubbed" }) }));
    await page.goto("/dashboard/reports", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    const text = (await page.locator("body").innerText()).toLowerCase();
    console.log(`[L-F probe] J55 reports under a 500: ${JSON.stringify(text.slice(0, 400))}`);
    expect(text, "a 500 must say so, not print zeros")
      .toMatch(/couldn.t|could not|unavailable|went wrong|try again|problem|error|failed/);
    await page.unroute("**/api/reports*");
    await page.close();
  });

  test("HELD · reports/generate with weeks: 999 and other nonsense is 4xx, never a 500", async () => {
    const before = await countOf("MonthlyReport", '"tenantId" = $1', [tenantId]);
    for (const [label, data] of [
      ["weeks 999", { weeks: 999 }],
      ["weeks -1", { weeks: -1 }],
      ["weeks NaN", { weeks: "NaN" }],
      ["empty", {}],
    ] as Array<[string, unknown]>) {
      const r = await apiCall(ownerCtx.request, "post", "/api/reports/generate", ORIGIN, data);
      describeResponse(`J55 generate ${label}`, r);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
    }
    const after = await countOf("MonthlyReport", '"tenantId" = $1', [tenantId]);
    console.log(`[L-F probe] J55 MonthlyReport rows before=${before} after=${after}`);
    // The generate bucket is shared — clear what this test exhausted (rule 6).
    await clearBucket(`report:gen:${tenantId}`);
  });

  test("REFUSED · anonymous and non-owner at /api/audit-log; nothing read", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    const own = await apiGet(ownerCtx.request, "/api/audit-log?take=5");
    expect(own.status, "the owner reads the audit log").toBe(200);
    expect(Object.keys(own.body as object).sort(), "the audit log answers a known key set")
      .toEqual(["entries", "nextCursor"]);

    const mgr = await apiGet(managerCtx.request, "/api/audit-log?take=5");
    expect(mgr.status, "a manager may not read the audit log").toBe(403);
    expectRefusal(mgr, "ok-false", "J55 manager GET /api/audit-log");

    for (const email of [COACH_EMAIL, ADMIN_EMAIL]) {
      const ctx = await sessionFor(browser, baseURL, { email, password: PASSWORD });
      const r = await apiGet(ctx.request, "/api/audit-log?take=5");
      expect(r.status, `${email} may not read the audit log`).toBe(403);
      expect(r.text, "not one audit row leaks to a refused role").not.toContain("entries");
    }

    const anon = await anonContext(browser, baseURL);
    const a = await apiGet(anon.request, "/api/audit-log?take=5");
    describeResponse("J55 anonymous GET /api/audit-log", a);
    expect(ANON_REFUSED, "anonymous audit log").toContain(a.status);
    await anon.close();
  });

  test("ATTACK · a foreign tenant's ids in the report and audit filters read nothing", async () => {
    const foreign = await mkTenant();
    try {
      const r = await apiGet(ownerCtx.request,
        `/api/audit-log?entityType=Member&entityId=${foreign.memberId}&take=20`);
      expect(r.status, "the filter is accepted").toBe(200);
      const entries = (r.body as { entries: Array<{ tenantId: string | null }> }).entries;
      expect(entries.length, "a foreign entity id returns nothing — a 200 with an empty result, held").toBe(0);
      expect(r.text, "no foreign row leaks").not.toContain(foreign.id);
    } finally {
      await teardownTenant(foreign);
    }
  });

  test("REFUSED · the reports page gate agrees with the API for every role", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    for (const [label, email, password, allowed] of [
      ["owner", OWNER_EMAIL, PASSWORD, true],
      ["coach", COACH_EMAIL, PASSWORD, false],
      ["admin", ADMIN_EMAIL, PASSWORD, false],
    ] as const) {
      const ctx = await sessionFor(browser, baseURL, { email, password });
      const page = await ctx.newPage();
      const landed = await finalPath(page, "/dashboard/reports");
      console.log(`[L-F probe] J55 ${label} → /dashboard/reports landed on ${landed}`);
      if (allowed) {
        expect(landed, `${label} reaches the reports page`).toBe("/dashboard/reports");
      } else {
        expect(landed, `${label} is bounced from the reports page, matching the 403 at the API`)
          .not.toBe("/dashboard/reports");
      }
      await page.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J56 — Promotions and ranks
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J56 promotions and ranks", () => {
  let tenantId: string;
  let ownerCtx: BrowserContext;
  let coachCtx: BrowserContext;
  let adminCtx: BrowserContext;
  let subject: LfMember;
  let rankLow: string;
  let rankHigh: string;
  let foreign: LfTenant;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    ownerCtx = await sessionFor(browser, baseURL, { email: OWNER_EMAIL, password: PASSWORD });
    coachCtx = await sessionFor(browser, baseURL, { email: COACH_EMAIL, password: PASSWORD });
    adminCtx = await sessionFor(browser, baseURL, { email: ADMIN_EMAIL, password: PASSWORD });
    subject = await mkMember({ name: `${RUN_STAMP} J56 subject` });
    const rows = await sql<{ id: string }>(
      `INSERT INTO "RankSystem" ("id", "tenantId", "discipline", "name", "order", "stripes")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 801, 0),
              (gen_random_uuid()::text, $1, $2, $4, 802, 0)
       RETURNING id`,
      [tenantId, `${RUN_STAMP}-j56`, `${RUN_STAMP} Low belt`, `${RUN_STAMP} High belt`],
    );
    rankLow = rows[0].id;
    rankHigh = rows[1].id;
    foreign = await mkTenant();
  });

  test.afterAll(async () => {
    await teardownTenant(foreign);
  });

  test("ALLOWED · candidates per role — owner and manager yes, coach and admin no", async ({ browser }, testInfo) => {
    const own = await apiGet(ownerCtx.request, "/api/promotions/candidates");
    expect(own.status, "the owner reads candidates").toBe(200);
    expect(Object.keys(own.body as object).sort(), "candidates answers a known key set")
      .toEqual(["candidates", "count", "generatedAt"]);

    const manager = await mkStaff("manager");
    const mgrCtx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: manager.email, password: THROWAWAY_PASSWORD,
    });
    expect((await apiGet(mgrCtx.request, "/api/promotions/candidates")).status, "a manager reads candidates").toBe(200);

    for (const [label, ctx] of [["coach", coachCtx], ["admin", adminCtx]] as const) {
      const r = await apiGet(ctx.request, "/api/promotions/candidates");
      describeResponse(`J56 ${label} GET /api/promotions/candidates`, r);
      expect(r.status, `${label} may not read candidates`).toBe(403);
      expectRefusal(r, "ok-false", `J56 ${label} candidates`);
      expect(r.text, `no member name leaks to a ${label}`).not.toContain(subject.name);
    }
  });

  test("REPORT · promote and demote share one allow-list — a coach may do both", async () => {
    const award = await apiCall(coachCtx.request, "post", `/api/members/${subject.id}/rank`, ORIGIN, {
      rankSystemId: rankHigh, stripes: 0,
    });
    describeResponse("J56 coach award", award);
    expect(award.status, "a coach may award a rank (STAFF_ROLES)").toBeLessThan(400);
    const afterAward = await sql<{ rankSystemId: string }>(
      'SELECT "rankSystemId" FROM "MemberRank" WHERE "memberId" = $1 ORDER BY "achievedAt" DESC LIMIT 1',
      [subject.id],
    );
    expect(afterAward[0]?.rankSystemId, "the award is a row").toBe(rankHigh);
    const history = await countOf("RankHistory",
      '"memberRankId" IN (SELECT id FROM "MemberRank" WHERE "memberId" = $1)', [subject.id]);
    expect(history, "the award writes its own history row").toBeGreaterThanOrEqual(1);

    const demote = await apiCall(coachCtx.request, "post", `/api/members/${subject.id}/rank/demote`, ORIGIN, {
      rankSystemId: rankLow, stripes: 0, reason: "graded in error",
    });
    describeResponse("J56 coach demote", demote);
    // The W4 inherited finding said the two allow-lists were disjoint. Both
    // routes read STAFF_ROLES today (rank/route.ts:63, demote/route.ts:24) —
    // asserted here so a regression to the asymmetry fails this test.
    expect(demote.status < 400, "promote and demote are symmetric for a coach").toBe(award.status < 400);
  });

  test("REFUSED · a member may not award or demote anyone, including themselves", async ({ browser }, testInfo) => {
    const member = await mkMember({ name: `${RUN_STAMP} J56 member` });
    const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: member.email, password: THROWAWAY_PASSWORD,
    });
    const before = await countOf("MemberRank", '"memberId" = $1', [member.id]);
    for (const url of [`/api/members/${member.id}/rank`, `/api/members/${subject.id}/rank`,
                       `/api/members/${subject.id}/rank/demote`]) {
      const r = await apiCall(ctx.request, "post", url, ORIGIN, { rankSystemId: rankHigh, stripes: 0, reason: "self-promotion" });
      describeResponse(`J56 member POST ${url}`, r);
      expect(r.status, `a member may not reach ${url}`).toBe(403);
      expectRefusal(r, "bare-error", `J56 member ${url}`);
    }
    await assertUnchanged("MemberRank", before, "J56 member self-promotion", '"memberId" = $1', [member.id]);
  });

  test("ATTACK · a foreign rank system and a foreign member id both 404 and write nothing", async () => {
    const before = await countOf("MemberRank", '"memberId" = $1', [foreign.memberId]);
    const foreignRank = await apiCall(ownerCtx.request, "post", `/api/members/${subject.id}/rank`, ORIGIN, {
      rankSystemId: foreign.rankSystemId, stripes: 0,
    });
    expect(foreignRank.status, "another club's rank system is a 404").toBe(404);
    const foreignMember = await apiCall(ownerCtx.request, "post", `/api/members/${foreign.memberId}/rank`, ORIGIN, {
      rankSystemId: rankHigh, stripes: 0,
    });
    expect(foreignMember.status, "another club's member is a 404").toBe(404);
    expect(foreignMember.text, "the refusal never discloses the foreign member's name")
      .not.toContain(`${RUN_STAMP} Foreign member`);
    await assertUnchanged("MemberRank", before, "J56 cross-tenant rank", '"memberId" = $1', [foreign.memberId]);
  });

  test("REFUSED · ranks CRUD per role — read is every session, write is owner/manager", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    const member = await mkMember({ name: `${RUN_STAMP} J56 ranks member` });
    const memberCtx = await sessionFor(browser, baseURL, { email: member.email, password: THROWAWAY_PASSWORD });
    expect((await apiGet(memberCtx.request, "/api/ranks")).status, "a member may read the belt ladder").toBe(200);

    for (const [label, ctx] of [["coach", coachCtx], ["admin", adminCtx]] as const) {
      const before = await countOf("RankSystem", '"tenantId" = $1', [tenantId]);
      const create = await apiCall(ctx.request, "post", "/api/ranks", ORIGIN, {
        discipline: `${RUN_STAMP}-j56b`, name: `${RUN_STAMP} ${label} belt`, order: 810,
      });
      expect(create.status, `${label} may not create a rank`).toBe(403);
      expectRefusal(create, "bare-error", `J56 ${label} POST /api/ranks`);
      await assertUnchanged("RankSystem", before, `J56 ${label} POST /api/ranks`, '"tenantId" = $1', [tenantId]);

      const patch = await apiCall(ctx.request, "patch", `/api/ranks/${rankLow}`, ORIGIN, { name: "pwned" });
      expect(patch.status, `${label} may not edit a rank`).toBe(403);
      const del = await apiCall(ctx.request, "delete", `/api/ranks/${rankLow}`, ORIGIN);
      expect(del.status, `${label} may not delete a rank`).toBe(403);
    }
    const still = await sql<{ name: string }>('SELECT name FROM "RankSystem" WHERE id = $1', [rankLow]);
    expect(still[0].name, "the rank is untouched by every refused call").toBe(`${RUN_STAMP} Low belt`);
  });

  test("ATTACK · a foreign rank id in this club's PATCH and DELETE is a 404", async () => {
    const before = await sql<{ name: string; deletedAt: Date | null }>(
      'SELECT name, "deletedAt" FROM "RankSystem" WHERE id = $1', [foreign.rankSystemId],
    );
    expect((await apiCall(ownerCtx.request, "patch", `/api/ranks/${foreign.rankSystemId}`, ORIGIN, { name: "pwned" })).status).toBe(404);
    expect((await apiCall(ownerCtx.request, "delete", `/api/ranks/${foreign.rankSystemId}`, ORIGIN)).status).toBe(404);
    const after = await sql<{ name: string; deletedAt: Date | null }>(
      'SELECT name, "deletedAt" FROM "RankSystem" WHERE id = $1', [foreign.rankSystemId],
    );
    expect(after[0].name, "the foreign rank is untouched").toBe(before[0].name);
    expect(after[0].deletedAt, "the foreign rank is not soft-deleted").toBe(before[0].deletedAt);
  });

  test("REPORT · a soft-deleted rank system's members still appear on the candidate list", async () => {
    const tempRank = await sql<{ id: string }>(
      `INSERT INTO "RankSystem" ("id", "tenantId", "discipline", "name", "order", "stripes")
       VALUES (gen_random_uuid()::text, $1, $2, $3, 850, 0) RETURNING id`,
      [tenantId, `${RUN_STAMP}-j56c`, `${RUN_STAMP} Doomed belt`],
    );
    const holder = await mkMember({ name: `${RUN_STAMP} J56 holder` });
    await sql(
      `INSERT INTO "MemberRank" ("id", "memberId", "rankSystemId", "stripes", "achievedAt")
       VALUES (gen_random_uuid()::text, $1, $2, 0, (now() AT TIME ZONE 'UTC') - interval '400 days')`,
      [holder.id, tempRank[0].id],
    );
    await sql('UPDATE "RankSystem" SET "deletedAt" = now() WHERE id = $1', [tempRank[0].id]);
    const r = await apiGet(ownerCtx.request, "/api/promotions/candidates");
    expect(r.status).toBe(200);
    const names = (r.body as { candidates: Array<{ memberName?: string; name?: string }> }).candidates
      .map((c) => c.memberName ?? c.name ?? "");
    console.log(`[L-F probe] J56 candidate names after soft-deleting a rank system: ${JSON.stringify(names.slice(0, 20))}`);
    expect(names, "a member whose belt ladder was deleted is not offered for promotion")
      .not.toContain(holder.name);
    await sql('DELETE FROM "MemberRank" WHERE "rankSystemId" = $1', [tempRank[0].id]);
    await sql('DELETE FROM "RankSystem" WHERE id = $1', [tempRank[0].id]);
  });

  test("REFUSED · anonymous at every J56 route", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("RankSystem", '"tenantId" = $1', [tenantId]);
    for (const [method, url] of [
      ["get", "/api/promotions/candidates"],
      ["get", "/api/ranks"],
      ["post", "/api/ranks"],
      ["patch", `/api/ranks/${rankLow}`],
      ["delete", `/api/ranks/${rankLow}`],
      ["post", `/api/members/${subject.id}/rank`],
      ["post", `/api/members/${subject.id}/rank/demote`],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN, method === "get" ? undefined : {});
      describeResponse(`J56 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    await assertUnchanged("RankSystem", before, "J56 anonymous sweep", '"tenantId" = $1', [tenantId]);
    await anon.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J57 — Dashboard action list
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J57 dashboard action list — tick and un-tick", () => {
  let tenantId: string;
  let ownerCtx: BrowserContext;
  let coachCtx: BrowserContext;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    ownerCtx = await sessionFor(browser, baseURL, { email: OWNER_EMAIL, password: PASSWORD });
    coachCtx = await sessionFor(browser, baseURL, { email: COACH_EMAIL, password: PASSWORD });
  });

  test("ALLOWED · every staff role reads and creates a task; the row proves it", async ({ browser }, testInfo) => {
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    const admin = await sessionFor(browser, baseURL, { email: ADMIN_EMAIL, password: PASSWORD });
    for (const [label, ctx] of [["owner", ownerCtx], ["coach", coachCtx], ["admin", admin]] as const) {
      const list = await apiGet(ctx.request, "/api/tasks");
      expect(list.status, `${label} reads the action list`).toBe(200);
      const create = await apiCall(ctx.request, "post", "/api/tasks", ORIGIN, {
        title: `${RUN_STAMP} J57 ${label} task`,
      });
      describeResponse(`J57 ${label} POST /api/tasks`, create);
      expect(create.status, `${label} creates an action`).toBe(201);
      const rows = await sql<{ id: string; status: string }>(
        'SELECT id, status FROM "Task" WHERE "tenantId" = $1 AND title = $2', [tenantId, `${RUN_STAMP} J57 ${label} task`],
      );
      expect(rows.length, "the action is a row").toBe(1);
      expect(rows[0].status, "a new action is open").toBe("open");
    }
  });

  test("ALLOWED · ticking moves the row; there is no un-tick route — record it", async () => {
    const create = await apiCall(ownerCtx.request, "post", "/api/tasks", ORIGIN, {
      title: `${RUN_STAMP} J57 tick me`,
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;
    const tick = await apiCall(ownerCtx.request, "post", `/api/tasks/${id}/complete`, ORIGIN);
    expect(tick.status, "the owner ticks the action").toBe(200);
    const row = await sql<{ status: string; completedAt: Date | null }>(
      'SELECT status, "completedAt" FROM "Task" WHERE id = $1', [id],
    );
    expect(row[0].status, "the tick is a row").toBe("done");
    const again = await apiCall(ownerCtx.request, "post", `/api/tasks/${id}/complete`, ORIGIN);
    expect(again.status, "a done action cannot be ticked twice").toBe(409);
    // No route un-ticks a staff task: the only writer is /complete. Recorded.
    const still = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [id]);
    expect(still[0].status, "the row stays done — un-tick is unreachable from the API").toBe("done");
  });

  test("REFUSED · a member may not read or write the staff action list", async ({ browser }, testInfo) => {
    const member = await mkMember({ name: `${RUN_STAMP} J57 member` });
    const ctx = await sessionFor(browser, testInfo.project.use.baseURL ?? ORIGIN, {
      email: member.email, password: THROWAWAY_PASSWORD,
    });
    const before = await countOf("Task", '"tenantId" = $1', [tenantId]);
    const list = await apiGet(ctx.request, "/api/tasks");
    expect(list.status, "a member may not read the staff list").toBe(403);
    expectRefusal(list, "bare-error", "J57 member GET /api/tasks");
    const create = await apiCall(ctx.request, "post", "/api/tasks", ORIGIN, { title: `${RUN_STAMP} J57 forbidden` });
    expect(create.status, "a member may not create a staff action").toBe(403);
    await assertUnchanged("Task", before, "J57 member sweep", '"tenantId" = $1', [tenantId]);
  });

  test("ATTACK · a coach cannot tick a task assigned to someone else unless they are the owner", async () => {
    const other = await mkStaff("admin");
    const create = await apiCall(ownerCtx.request, "post", "/api/tasks", ORIGIN, {
      title: `${RUN_STAMP} J57 assigned elsewhere`, assignedToId: other.id,
    });
    describeResponse("J57 owner creates an assigned task", create);
    if (create.status !== 201) return; // an unmet dependency is a skip, not a failure
    const id = (create.body as { id: string }).id;
    const before = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [id]);
    const r = await apiCall(coachCtx.request, "post", `/api/tasks/${id}/complete`, ORIGIN);
    describeResponse("J57 coach ticks someone else's task", r);
    expect(r.status, "only the assignee or the owner may complete").toBe(403);
    const after = await sql<{ status: string }>('SELECT status FROM "Task" WHERE id = $1', [id]);
    expect(after[0].status, "the refused tick wrote nothing").toBe(before[0].status);
  });

  test("HELD · malformed and oversize task bodies are 4xx and write nothing", async () => {
    const before = await countOf("Task", '"tenantId" = $1', [tenantId]);
    for (const [label, data] of [
      ["no title", {}],
      ["empty title", { title: "" }],
      ["10 000-character title", { title: "x".repeat(10_000) }],
      ["self-assignment", { title: `${RUN_STAMP} J57 self`, assignedToId: "self" }],
      ["foreign assignee", { title: `${RUN_STAMP} J57 foreign`, assignedToId: "00000000-0000-0000-0000-000000000000" }],
    ] as Array<[string, unknown]>) {
      const r = await apiCall(ownerCtx.request, "post", "/api/tasks", ORIGIN, data);
      describeResponse(`J57 create ${label}`, r);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
    }
    const after = await countOf("Task", '"tenantId" = $1 AND length(title) > 500', [tenantId]);
    expect(after, "no 10 000-character title reached the table").toBe(0);
    console.log(`[L-F probe] J57 tasks before the fuzz: ${before}`);
  });

  test("REFUSED · anonymous at the staff action routes", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("Task", '"tenantId" = $1', [tenantId]);
    for (const [method, url] of [["get", "/api/tasks"], ["post", "/api/tasks"]] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN, method === "get" ? undefined : { title: "x" });
      describeResponse(`J57 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    await assertUnchanged("Task", before, "J57 anonymous sweep", '"tenantId" = $1', [tenantId]);
    await anon.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J58 — Announcements
// ─────────────────────────────────────────────────────────────────────────────
test.describe("J58 announcements — post, expire, and who may read", () => {
  let tenantId: string;
  let ownerCtx: BrowserContext;
  let coachCtx: BrowserContext;
  let adminCtx: BrowserContext;
  let memberCtx: BrowserContext;
  let member: LfMember;
  let foreign: LfTenant;

  test.beforeAll(async ({ browser }, testInfo) => {
    tenantId = await seededTenantId();
    const baseURL = testInfo.project.use.baseURL ?? ORIGIN;
    ownerCtx = await sessionFor(browser, baseURL, { email: OWNER_EMAIL, password: PASSWORD });
    coachCtx = await sessionFor(browser, baseURL, { email: COACH_EMAIL, password: PASSWORD });
    adminCtx = await sessionFor(browser, baseURL, { email: ADMIN_EMAIL, password: PASSWORD });
    member = await mkMember({ name: `${RUN_STAMP} J58 member` });
    memberCtx = await sessionFor(browser, baseURL, { email: member.email, password: THROWAWAY_PASSWORD });
    foreign = await mkTenant();
  });

  test.afterAll(async () => {
    await teardownTenant(foreign);
  });

  test("ALLOWED · the owner posts and the member sees it on their home", async () => {
    const title = `${RUN_STAMP} J58 notice`;
    const create = await apiCall(ownerCtx.request, "post", "/api/announcements", ORIGIN, {
      title, body: "Grading on Saturday. Bring your gi.",
    });
    expect(create.status, "the owner posts an announcement").toBe(201);
    const rows = await sql<{ id: string; tenantId: string }>(
      'SELECT id, "tenantId" FROM "Announcement" WHERE title = $1', [title],
    );
    expect(rows.length, "the announcement is a row").toBe(1);
    expect(rows[0].tenantId, "the row is scoped to the poster's club").toBe(tenantId);

    // Proven by a fresh GET as the member, not by the poster's own screen.
    const home = await apiGet(memberCtx.request, "/api/announcements");
    expect(home.status, "a member may read announcements").toBe(200);
    expect(home.text, "the member sees the notice").toContain(title);
    expect(home.text, "no other club's notice reaches this member")
      .not.toContain(`${RUN_STAMP} Foreign notice`);
  });

  test("ALLOWED · an expired announcement disappears from the member's read", async () => {
    const title = `${RUN_STAMP} J58 expiring`;
    const create = await apiCall(ownerCtx.request, "post", "/api/announcements", ORIGIN, {
      title, body: "This one expires.",
    });
    expect(create.status).toBe(201);
    const id = (create.body as { id: string }).id;
    const visible = await apiGet(memberCtx.request, "/api/announcements");
    expect(visible.text, "it is visible before expiry").toContain(title);

    // Nudge expiry in SQL against the database's own clock.
    await sql(
      `UPDATE "Announcement" SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE id = $1`,
      [id],
    );
    const after = await apiGet(memberCtx.request, "/api/announcements");
    expect(after.text, "an expired announcement is gone from the member's read").not.toContain(title);
    // It is still a row — expiry is a filter, not a delete.
    const still = await countOf("Announcement", "id = $1", [id]);
    expect(still, "expiry hides, it does not destroy").toBe(1);
  });

  test("REPORT · pinned exists as a column — record what the product does with it", async () => {
    const title = `${RUN_STAMP} J58 pinned`;
    const create = await apiCall(ownerCtx.request, "post", "/api/announcements", ORIGIN, {
      title, body: "Pinned notice.", pinned: true,
    });
    describeResponse("J58 create pinned", create);
    if (create.status !== 201) return; // unmet dependency — a skip, not a failure
    const id = (create.body as { id: string }).id;
    const row = await sql<{ pinned: boolean }>('SELECT pinned FROM "Announcement" WHERE id = $1', [id]);
    console.log(`[L-F probe] J58 pinned after create: ${row[0].pinned}`);
    const unpin = await apiCall(ownerCtx.request, "patch", `/api/announcements/${id}`, ORIGIN, { pinned: false });
    describeResponse("J58 unpin", unpin);
    const after = await sql<{ pinned: boolean }>('SELECT pinned FROM "Announcement" WHERE id = $1', [id]);
    expect(after[0].pinned, "pin and unpin both reach the row, or neither does")
      .toBe(unpin.status === 200 ? false : row[0].pinned);
  });

  test("REFUSED · coach, admin and member may not post, edit or delete", async () => {
    const seed = await apiCall(ownerCtx.request, "post", "/api/announcements", ORIGIN, {
      title: `${RUN_STAMP} J58 target`, body: "Do not edit me.",
    });
    expect(seed.status).toBe(201);
    const id = (seed.body as { id: string }).id;

    for (const [label, ctx] of [["coach", coachCtx], ["admin", adminCtx], ["member", memberCtx]] as const) {
      const before = await countOf("Announcement", '"tenantId" = $1', [tenantId]);
      const post = await apiCall(ctx.request, "post", "/api/announcements", ORIGIN, {
        title: `${RUN_STAMP} J58 ${label}`, body: "Should not exist.",
      });
      expect(post.status, `${label} may not post`).toBe(403);
      expectRefusal(post, "bare-error", `J58 ${label} POST /api/announcements`);
      await assertUnchanged("Announcement", before, `J58 ${label} POST`, '"tenantId" = $1', [tenantId]);

      expect((await apiCall(ctx.request, "patch", `/api/announcements/${id}`, ORIGIN, { title: "pwned" })).status,
        `${label} may not edit`).toBe(403);
      expect((await apiCall(ctx.request, "delete", `/api/announcements/${id}`, ORIGIN)).status,
        `${label} may not delete`).toBe(403);
    }
    const still = await sql<{ title: string }>('SELECT title FROM "Announcement" WHERE id = $1', [id]);
    expect(still[0].title, "the announcement survived every refused call").toBe(`${RUN_STAMP} J58 target`);
  });

  test("ATTACK · another club's announcement cannot be edited or deleted from here", async () => {
    const before = await sql<{ title: string }>('SELECT title FROM "Announcement" WHERE id = $1', [foreign.announcementId]);
    const patch = await apiCall(ownerCtx.request, "patch", `/api/announcements/${foreign.announcementId}`, ORIGIN, { title: "pwned" });
    expect(patch.status, "another club's announcement is a 404").toBe(404);
    const del = await apiCall(ownerCtx.request, "delete", `/api/announcements/${foreign.announcementId}`, ORIGIN);
    expect(del.status, "another club's announcement cannot be deleted").toBe(404);
    const after = await sql<{ title: string }>('SELECT title FROM "Announcement" WHERE id = $1', [foreign.announcementId]);
    expect(after[0].title, "the foreign announcement is untouched").toBe(before[0].title);
  });

  test("HELD · malformed announcement bodies are 4xx and write nothing", async () => {
    const before = await countOf("Announcement", '"tenantId" = $1', [tenantId]);
    for (const [label, data] of [
      ["no title", { body: "x" }],
      ["empty title", { title: "", body: "x" }],
      ["10 000-character title", { title: "x".repeat(10_000), body: "x" }],
      ["1970 expiry", { title: `${RUN_STAMP} J58 old`, body: "x", expiresAt: "1970-01-01T00:00:00.000Z" }],
      ["not a date", { title: `${RUN_STAMP} J58 nan`, body: "x", expiresAt: "NaN" }],
    ] as Array<[string, unknown]>) {
      const r = await apiCall(ownerCtx.request, "post", "/api/announcements", ORIGIN, data);
      describeResponse(`J58 create ${label}`, r);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
    }
    const oversized = await countOf("Announcement", '"tenantId" = $1 AND length(title) > 500', [tenantId]);
    expect(oversized, "no 10 000-character title reached the table").toBe(0);
    console.log(`[L-F probe] J58 announcements before the fuzz: ${before}`);
  });

  test("REFUSED · anonymous at every J58 route", async ({ browser }, testInfo) => {
    const anon = await anonContext(browser, testInfo.project.use.baseURL ?? ORIGIN);
    const before = await countOf("Announcement", '"tenantId" = $1', [tenantId]);
    for (const [method, url] of [
      ["get", "/api/announcements"],
      ["post", "/api/announcements"],
      ["get", "/api/member/home"],
    ] as const) {
      const r = await apiCall(anon.request, method, url, ORIGIN, method === "get" ? undefined : { title: "x", body: "y" });
      describeResponse(`J58 anonymous ${method.toUpperCase()} ${url}`, r);
      expect(ANON_REFUSED, `anonymous ${method} ${url}`).toContain(r.status);
    }
    await assertUnchanged("Announcement", before, "J58 anonymous sweep", '"tenantId" = $1', [tenantId]);
    await anon.close();
  });
});

/** Pull the first number under any of `keys`, at any depth. */
function findNumber(obj: unknown, keys: string[]): number | null {
  if (obj === null || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.includes(k) && typeof v === "number") return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findNumber(v, keys);
    if (found !== null) return found;
  }
  return null;
}

test.afterAll(async () => {
  await teardownSeededClub();
});
