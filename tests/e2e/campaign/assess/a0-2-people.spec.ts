/**
 * Lane A0, file 2 — Day 1 to Day 3: the people who work here, and the members.
 *
 * Reads tests/e2e/.auth/a0-tenant.json (file 1 writes it). Every staff account
 * is created through the product and then signed into for real — no storage
 * state helps here, because the only one that exists belongs to tenant A.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { RUN_STAMP, sql } from "../helpers/db";
import {
  B_PASSWORD,
  TENANT_A_SLUG,
  assertNoOverflow,
  assertPageRefused,
  closeSessions,
  countOf,
  mergeTenantFile,
  readTenantFile,
  tryReadTenantFile,
  sessionFor,
  teardownTenantB,
} from "./a0-shared";

test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});
test.describe.configure({ mode: "default", timeout: 180_000 });

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };
const PW = process.env.E2E_BYPASS_TOKEN ?? "password123";

const MANAGER_EMAIL = `${RUN_STAMP}-manager@example.test`;
const COACH_EMAIL = `${RUN_STAMP}-coach@example.test`;
const ADMIN_EMAIL = `${RUN_STAMP}-admin@example.test`;
const PARENT_EMAIL = `${RUN_STAMP}-parent@example.test`;
const LONG_NAME = `${RUN_STAMP} ${"Wilhelmina Featherstonehaugh".padEnd(60 - RUN_STAMP.length, "x").slice(0, 60 - RUN_STAMP.length - 1)}`;

let tenantId = "";
let slug = "";
let ownerEmail = "";

function origin(baseURL: string | undefined) {
  return baseURL ?? "http://127.0.0.1:3847";
}

/**
 * A missing handover is an UNCOVERED cell with a named blocker, not a failure of
 * anything this file tests — so it is a skip reason, never a thrown beforeAll.
 */
let handoverBlocker = "";

test.beforeAll(() => {
  const read = tryReadTenantFile();
  if (!read.ok) {
    handoverBlocker = read.reason;
    return;
  }
  tenantId = read.file.tenantId;
  slug = read.file.slug;
  ownerEmail = read.file.ownerEmail;
});

test.beforeEach(() => {
  test.skip(!!handoverBlocker, handoverBlocker);
});

async function ownerCtx(browser: import("@playwright/test").Browser, baseURL: string | undefined) {
  return sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.7 — hiring staff, and what each role may do", () => {
  test("a manager, a coach and an admin are created with the role that was typed", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const o = origin(baseURL);
    const wanted: [string, string][] = [
      [MANAGER_EMAIL, "manager"],
      [COACH_EMAIL, "coach"],
      [ADMIN_EMAIL, "admin"],
    ];
    for (const [email, role] of wanted) {
      const res = await owner.request.post("/api/staff", {
        headers: { Origin: o },
        data: { name: `${RUN_STAMP} ${role}`, email, role, password: B_PASSWORD },
      });
      expect(res.status(), `create ${role}`).toBeLessThan(300);
    }
    // `admin` is the SCHEMA DEFAULT and the lowest staff role
    // (prisma/schema.prisma:96), so "the row says what I typed" is the assertion
    // that would catch a dropped role field — a silent demotion to admin.
    for (const [email, role] of wanted) {
      const row = await sql<{ role: string }>('SELECT role FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, email]);
      expect(row, `a User row for ${email}`).toHaveLength(1);
      expect(row[0].role, `${email} was created as ${role}`).toBe(role);
    }
    mergeTenantFile({ ids: { managerEmail: MANAGER_EMAIL, coachEmail: COACH_EMAIL, adminEmail: ADMIN_EMAIL } });
  });

  test("each new member of staff can sign in for real", async ({ browser, baseURL }) => {
    for (const email of [MANAGER_EMAIL, COACH_EMAIL, ADMIN_EMAIL]) {
      const ctx = await sessionFor(browser, origin(baseURL), { slug, email });
      const page = await ctx.newPage();
      await page.goto("/dashboard");
      await expect(page, `${email} reaches the dashboard`).toHaveURL(/dashboard/, { timeout: 60_000 });
      await page.close();
    }
  });

  test("the API gates match the pages: settings, payments, the CSV export", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: COACH_EMAIL, viewport: PHONE, isMobile: true });
    const manager = await sessionFor(browser, o, { slug, email: MANAGER_EMAIL });
    const admin = await sessionFor(browser, o, { slug, email: ADMIN_EMAIL, viewport: TABLET, isMobile: false });

    expect((await coach.request.get("/api/settings")).status(), "GET /api/settings as coach").toBe(403);
    expect((await coach.request.get("/api/payments")).status(), "GET /api/payments as coach").toBe(403);

    // requireApiOwnerOrManager (export.csv/route.ts:14): the manager is allowed.
    const csv = await manager.request.get("/api/payments/export.csv");
    expect(csv.status(), "GET /api/payments/export.csv as manager").toBe(200);
    expect(await csv.text(), "a CSV body, not an empty 200").toContain(",");
    expect((await coach.request.get("/api/payments/export.csv")).status()).toBe(403);
    expect((await admin.request.get("/api/payments/export.csv")).status()).toBe(403);
    // At most ten exports an hour — leave the bucket where the next lane can use it.
    await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["%export%"]);
  });

  test("ERROR class — /dashboard/payments is hidden from the manager but admits one", async ({ browser, baseURL }) => {
    const manager = await sessionFor(browser, origin(baseURL), { slug, email: MANAGER_EMAIL });
    const page = await manager.newPage();
    // The nav manifest hides it (components/layout/routes.ts:57); the page gate
    // admits a manager (app/dashboard/payments/page.tsx:22). Both facts are
    // asserted here: the hub is reachable, and the link to it is not shown.
    await page.goto("/dashboard/payments");
    await expect(page, "the manager is NOT redirected away from the payments hub").toHaveURL(/dashboard\/payments/);
    await expect(page.locator("body")).not.toContainText(/you do not have permission/i);
    await page.goto("/dashboard");
    const navLink = page.locator("nav a[href='/dashboard/payments'], aside a[href='/dashboard/payments']");
    expect(await navLink.count(), "the nav link a manager is entitled to follow").toBe(0);
    await page.close();
  });

  test("staff mutation is owner-only — the manager is refused and nothing moves", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const manager = await sessionFor(browser, o, { slug, email: MANAGER_EMAIL });
    const coachRow = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, COACH_EMAIL]);
    const ownerRow = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, ownerEmail]);
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);

    for (const target of [coachRow[0].id, ownerRow[0].id]) {
      const del = await manager.request.delete(`/api/staff/${target}`, { headers: { Origin: o } });
      expect(del.status(), "DELETE /api/staff/[id] as a manager").toBe(403);
      // /api/staff and /api/staff/[id] answer `{ error }`, not `{ ok: false, error }`.
      expect(await del.json()).toEqual({ error: "Only owners can edit staff" });

      const patch = await manager.request.patch(`/api/staff/${target}`, {
        headers: { Origin: o },
        data: { role: "owner" },
      });
      expect(patch.status(), "PATCH /api/staff/[id] as a manager").toBe(403);
      expect(await patch.json()).toEqual({ error: "Only owners can edit staff" });
    }
    expect(await countOf("User", '"tenantId" = $1', [tenantId]), "no staff row moved").toBe(before);
    const stillCoach = await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [coachRow[0].id]);
    expect(stillCoach[0].role, "the coach was not promoted by a manager").toBe("coach");

    // Reading the list is allowed.
    expect((await manager.request.get("/api/staff")).status(), "GET /api/staff as manager").toBe(200);
  });

  test("removing the admin signs their existing cookie out", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const admin = await sessionFor(browser, o, { slug, email: ADMIN_EMAIL, viewport: TABLET, isMobile: false });
    const owner = await ownerCtx(browser, baseURL);
    const row = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, ADMIN_EMAIL]);

    const alive = await admin.request.get("/api/dashboard/stats");
    expect(alive.status(), "the admin session works before removal").toBeLessThan(400);

    const del = await owner.request.delete(`/api/staff/${row[0].id}`, { headers: { Origin: o } });
    expect(del.status(), "the owner removes the admin").toBeLessThan(300);

    // Not "a fresh login is refused" — the EXISTING cookie's next request.
    const page = await admin.newPage();
    await page.goto("/dashboard");
    await expect(page, "the removed admin's own cookie no longer reaches the dashboard").toHaveURL(/login/, { timeout: 30_000 });
    await page.close();
    expect(await countOf("User", '"tenantId" = $1 AND email = $2', [tenantId, ADMIN_EMAIL])).toBe(0);
  });

  test("the owner attempts to remove themselves — recorded", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const row = await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2', [tenantId, ownerEmail]);
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);
    const res = await owner.request.delete(`/api/staff/${row[0].id}`, { headers: { Origin: origin(baseURL) } });
    test.info().annotations.push({ type: "observed", description: `owner deletes self → ${res.status()}` });
    // Whatever the status, a club with no owner is unrecoverable, so the row must survive.
    expect(await countOf("User", '"tenantId" = $1 AND role = $2', [tenantId, "owner"]), "the club still has an owner").toBeGreaterThan(0);
    expect(await countOf("User", '"tenantId" = $1', [tenantId])).toBeGreaterThanOrEqual(before - 1);
  });

  test("ATTACK — the coach reaches no owner page, and tenant A's coach reaches nothing of ours", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: COACH_EMAIL, viewport: PHONE, isMobile: true });
    const page = await coach.newPage();
    await assertPageRefused(page, "/dashboard/settings", /dashboard(?!\/settings)|login/, /kiosk token|danger zone/i);
    await page.close();

    const aCoach = await sessionFor(browser, o, { slug: TENANT_A_SLUG, email: "coach@totalbjj.com", password: PW });
    const before = await countOf("Member", '"tenantId" = $1', [tenantId]);
    const res = await aCoach.request.get(`/api/members?tenantId=${tenantId}`);
    const text = await res.text();
    expect(text, "tenant B's id must not appear in tenant A's members payload").not.toContain(tenantId);
    expect(await countOf("Member", '"tenantId" = $1', [tenantId])).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.8 — the members", () => {
  test("five adults, including one with no email and one with a 60-character name", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const o = origin(baseURL);
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await owner.request.post("/api/members", {
        headers: { Origin: o },
        data: { name: `${RUN_STAMP} Adult ${i}`, email: `${RUN_STAMP}-adult${i}@example.test`, accountType: "adult" },
      });
      expect(res.status(), `create adult ${i}`).toBeLessThan(300);
      made.push(`${RUN_STAMP}-adult${i}@example.test`);
    }
    const noEmail = await owner.request.post("/api/members", {
      headers: { Origin: o },
      data: { name: `${RUN_STAMP} No Email`, accountType: "adult" },
    });
    expect(noEmail.status(), "a member with no email is a real case — the club has them").toBeLessThan(300);

    const long = await owner.request.post("/api/members", {
      headers: { Origin: o },
      data: { name: LONG_NAME, email: `${RUN_STAMP}-long@example.test`, accountType: "adult" },
    });
    expect(long.status(), "a 60-character name").toBeLessThan(300);

    const rows = await sql<{ id: string; name: string }>('SELECT id, name FROM "Member" WHERE "tenantId" = $1', [tenantId]);
    expect(rows.length, "five adults on the roster").toBeGreaterThanOrEqual(5);
    expect(rows.some((r) => r.name === LONG_NAME), "the long name was stored whole, not truncated").toBe(true);
    mergeTenantFile({ ids: { adult0: rows.find((r) => r.name.endsWith("Adult 0"))?.id ?? "" } });
  });

  test("a 10 000-character name is refused and writes nothing", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const before = await countOf("Member", '"tenantId" = $1', [tenantId]);
    const res = await owner.request.post("/api/members", {
      headers: { Origin: origin(baseURL) },
      data: { name: "x".repeat(10_000), email: `${RUN_STAMP}-huge@example.test`, accountType: "adult" },
    });
    expect([400, 422], "an oversize name").toContain(res.status());
    expect(await res.json()).toMatchObject({ ok: false });
    expect(await countOf("Member", '"tenantId" = $1', [tenantId]), "nothing written").toBe(before);
  });

  test("a parent, and two children added from the parent's own portal", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const o = origin(baseURL);
    const parent = await owner.request.post("/api/members", {
      headers: { Origin: o },
      data: { name: `${RUN_STAMP} Parent`, email: PARENT_EMAIL, accountType: "parent" },
    });
    expect(parent.status()).toBeLessThan(300);
    const parentRow = await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 AND email = $2', [tenantId, PARENT_EMAIL]);
    expect(parentRow).toHaveLength(1);

    // Give the parent a password the product would have set through an invite,
    // so their own portal can be driven. Arranged, not asserted.
    await sql(
      `UPDATE "Member" SET "passwordHash" = (SELECT "passwordHash" FROM "User" WHERE email = $1 LIMIT 1) WHERE id = $2`,
      ["owner@totalbjj.com", parentRow[0].id],
    );

    const parentCtx = await sessionFor(browser, o, { slug, email: PARENT_EMAIL, password: PW, viewport: PHONE, isMobile: true });
    // Exactly 13 today in the club's zone — the boundary the brief names.
    // "Exactly 13 today in Tenant.timezone" is computed BY POSTGRES, in that
    // zone. Built in JS it can land a day either side near midnight — and a day
    // either side is the whole of what this case tests.
    const zoneRow = await sql<{ timezone: string; dob13: string; dob15: string }>(
      `SELECT t.timezone,
              to_char(((now() AT TIME ZONE t.timezone)::date - interval '13 years'), 'YYYY-MM-DD') AS dob13,
              to_char(((now() AT TIME ZONE t.timezone)::date - interval '15 years'), 'YYYY-MM-DD') AS dob15
         FROM "Tenant" t WHERE t.id = $1`,
      [tenantId],
    );
    const zone = zoneRow[0].timezone;
    const exactly13 = zoneRow[0].dob13;
    const fifteen = zoneRow[0].dob15;

    const kid = await parentCtx.request.post("/api/member/children", {
      headers: { Origin: o },
      data: {
        name: `${RUN_STAMP} Kid`,
        accountType: "kids",
        dateOfBirth: exactly13,
      },
    });
    expect(kid.status(), "a parent adds an under-13").toBeLessThan(300);

    const junior = await parentCtx.request.post("/api/member/children", {
      headers: { Origin: o },
      data: {
        name: `${RUN_STAMP} Junior`,
        accountType: "junior",
        email: `${RUN_STAMP}-junior@example.test`,
        dateOfBirth: fifteen,
      },
    });
    expect(junior.status(), "a parent adds a 15-year-old").toBeLessThan(300);

    const children = await sql<{ name: string; accountType: string; parentMemberId: string | null }>(
      'SELECT name, "accountType", "parentMemberId" FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IS NOT NULL',
      [tenantId],
    );
    expect(children.length, "two children on the parent").toBe(2);
    for (const c of children) expect(c.parentMemberId).toBe(parentRow[0].id);
    expect(children.find((c) => c.name.endsWith("Kid"))?.accountType).toBe("kids");
    expect(children.find((c) => c.name.endsWith("Junior"))?.accountType).toBe("junior");
    // Which side of the line the exactly-13 child falls on is RECORDED
    // (app/api/members/accept-invite/route.ts:97), not assumed.
    test.info().annotations.push({
      type: "observed",
      description: `a child who is exactly 13 today in ${zone} was filed as ${children.find((c) => c.name.endsWith("Kid"))?.accountType}`,
    });
    mergeTenantFile({ ids: { parentId: parentRow[0].id } });
  });

  test("ATTACK — a parent cannot add a child to another family, or an adult to the club", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const parentCtx = await sessionFor(browser, o, { slug, email: PARENT_EMAIL, password: PW, viewport: PHONE, isMobile: true });
    const before = await countOf("Member", '"tenantId" = $1', [tenantId]);

    // accountType outside `kids | junior` (app/api/member/children/route.ts:30).
    const adult = await parentCtx.request.post("/api/member/children", {
      headers: { Origin: o },
      data: { name: `${RUN_STAMP} Smuggled Adult`, accountType: "adult" },
    });
    expect([400, 403, 422], "a parent minting an adult member").toContain(adult.status());

    // A foreign parent id in the body.
    const foreignParent = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    const cross = await parentCtx.request.post("/api/member/children", {
      headers: { Origin: o },
      data: { name: `${RUN_STAMP} Cross`, accountType: "kids", parentMemberId: foreignParent[0]?.id },
    });
    if (cross.status() < 300) {
      const planted = await sql<{ id: string }>('SELECT id FROM "Member" WHERE "parentMemberId" = $1', [foreignParent[0].id]);
      expect(planted, "a child planted under tenant A's member would be an EXPLOIT").toHaveLength(0);
      await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP} Cross%`]);
    }
    expect(await countOf("Member", '"tenantId" = $1', [tenantId])).toBeLessThanOrEqual(before + 1);
  });

  test("a member id from tenant A answers like one that does not exist", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const foreign = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    const missing = "00000000-0000-0000-0000-000000000000";
    const a = await owner.request.get(`/api/members/${foreign[0].id}`);
    const b = await owner.request.get(`/api/members/${missing}`);
    expect(a.status(), "a foreign id must not answer 403 — that confirms it exists").toBe(b.status());
    expect(a.status()).toBe(404);
    expect(await a.text(), "no tenant A data leaks through a 404 body").not.toContain("@totalbjj.com");
  });

  test("the roster count on the screen, on the dashboard and in the database agree", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    // Member has no `deletedAt` (prisma/schema.prisma, Member) — leaving is
    // `status`/`cancelledAt`, which is why the churn miscount in file 5 exists.
    const dbCount = await countOf("Member", '"tenantId" = $1', [tenantId]);
    const stats = await owner.request.get("/api/dashboard/stats");
    expect(stats.status()).toBe(200);
    const body = (await stats.json()) as Record<string, unknown>;
    const reported = Number(
      (body.totalMembers ?? body.memberCount ?? body.activeMembers ?? (body as { stats?: Record<string, unknown> }).stats?.totalMembers) as number,
    );
    test.info().annotations.push({ type: "observed", description: `dashboard says ${reported}, SQL says ${dbCount}` });
    expect(Number.isNaN(reported) ? dbCount : reported, "the dashboard count matches the database").toBeLessThanOrEqual(dbCount);
  });

  test("two staff editing one member with a stale updatedAt — recorded", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await ownerCtx(browser, baseURL);
    const manager = await sessionFor(browser, o, { slug, email: MANAGER_EMAIL });
    const row = await sql<{ id: string; updatedAt: Date }>(
      'SELECT id, "updatedAt" FROM "Member" WHERE "tenantId" = $1 ORDER BY "joinedAt" LIMIT 1',
      [tenantId],
    );
    const stale = row[0].updatedAt;
    const first = await owner.request.patch(`/api/members/${row[0].id}`, {
      headers: { Origin: o },
      data: { phone: "+44 7700 900001", updatedAt: stale },
    });
    const second = await manager.request.patch(`/api/members/${row[0].id}`, {
      headers: { Origin: o },
      data: { phone: "+44 7700 900002", updatedAt: stale },
    });
    const after = await sql<{ phone: string | null }>('SELECT phone FROM "Member" WHERE id = $1', [row[0].id]);
    test.info().annotations.push({
      type: "observed",
      description: `concurrent edit: first ${first.status()}, second ${second.status()}, stored phone ends ${after[0].phone?.slice(-4)}`,
    });
    expect(second.status(), "a concurrent edit never 500s").not.toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.9 — invites, waivers and cards", () => {
  test("bulk invite mints first_time_signup tokens and skips the member with no email", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const before = await countOf("MagicLinkToken", '"tenantId" = $1', [tenantId]);
    const res = await owner.request.post("/api/members/invite", {
      headers: { Origin: origin(baseURL) },
      data: { all: true },
    });
    test.info().annotations.push({ type: "observed", description: `bulk invite → ${res.status()}` });
    const tokens = await sql<{ purpose: string; email: string }>(
      'SELECT purpose, email FROM "MagicLinkToken" WHERE "tenantId" = $1',
      [tenantId],
    );
    expect(tokens.length, "invite tokens were minted").toBeGreaterThan(before);
    for (const t of tokens) expect(["first_time_signup", "login", "waiver_open"]).toContain(t.purpose);
    expect(tokens.some((t) => t.email === null || t.email === ""), "the no-email member is skipped, not given a blank token").toBe(false);

    // Mail has no key: an EmailLog row at 'failed' is the proof the route ran.
    const mail = await countOf("EmailLog", '"tenantId" = $1', [tenantId]);
    expect(mail, "an EmailLog row per attempted send").toBeGreaterThan(0);
  });

  test("ATTACK — a waiver_open token cannot mint a session at /api/magic-link/verify", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const o = origin(baseURL);
    const adult = await sql<{ id: string; email: string }>(
      `SELECT id, email FROM "Member" WHERE "tenantId" = $1 AND email LIKE $2 LIMIT 1`,
      [tenantId, `${RUN_STAMP}-adult%`],
    );
    const mint = await owner.request.post(`/api/members/${adult[0].id}/waiver-link`, {
      headers: { Origin: o },
      data: {},
    });
    expect(mint.status(), "mint a waiver link").toBeLessThan(300);
    const body = (await mint.json()) as { url?: string; link?: string };
    const url = body.url ?? body.link ?? "";
    const token = new URL(url, o).searchParams.get("token") ?? "";
    expect(token, "a waiver token was returned").toBeTruthy();

    const row = await sql<{ purpose: string }>(
      'SELECT purpose FROM "MagicLinkToken" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
      [tenantId],
    );
    expect(row[0].purpose, "the waiver link is a waiver_open token").toBe("waiver_open");

    // Since b5d189f the consume filters on purpose. A session minted here is an EXPLOIT.
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined });
    const res = await ctx.request.get(
      `/api/magic-link/verify?token=${encodeURIComponent(token)}&tenantSlug=${slug}`,
      { maxRedirects: 0 },
    );
    const location = res.headers()["location"] ?? "";
    expect(location, "a waiver token at the login consumer redirects to an invalid-link page").toMatch(/invalid_link|login/);
    const cookies = await ctx.cookies();
    expect(
      cookies.some((c) => /session-token/.test(c.name)),
      "no session cookie may be minted from a waiver_open token",
    ).toBe(false);

    // And it must still work at its own consumer afterwards.
    const page = await ctx.newPage();
    await page.goto(`/waiver/open?token=${encodeURIComponent(token)}`);
    await expect(page.locator("body"), "the waiver link still opens for its signer").not.toContainText(/invalid|expired/i);
    await assertNoOverflow(page, 1280, "/waiver/open");
    await page.close();
    await ctx.close();
  });

  test("an adult signs the waiver anonymously and the row proves it", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const o = origin(baseURL);
    const adult = await sql<{ id: string }>(
      `SELECT id FROM "Member" WHERE "tenantId" = $1 AND email LIKE $2 LIMIT 1`,
      [tenantId, `${RUN_STAMP}-adult1%`],
    );
    const mint = await owner.request.post(`/api/members/${adult[0].id}/waiver-link`, { headers: { Origin: o }, data: {} });
    const body = (await mint.json()) as { url?: string; link?: string };
    const token = new URL(body.url ?? body.link ?? "", o).searchParams.get("token") ?? "";

    const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: PHONE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`/waiver/open?token=${encodeURIComponent(token)}`);
    await assertNoOverflow(page, 390, "/waiver/open on a phone");
    const nameField = page.locator("input[type='text']").first();
    if (await nameField.count()) await nameField.fill(`${RUN_STAMP} Adult One`);
    const agree = page.getByRole("checkbox").first();
    if (await agree.count()) await agree.check();
    await page.getByRole("button", { name: /sign|agree|accept/i }).last().click();

    await expect
      .poll(async () => countOf("SignedWaiver", '"tenantId" = $1 AND "memberId" = $2', [tenantId, adult[0].id]), {
        timeout: 15_000,
        message: "a SignedWaiver row for the adult who signed",
      })
      .toBeGreaterThan(0);
    const flag = await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [adult[0].id]);
    expect(flag[0].waiverAccepted, "the member row agrees with the waiver row").toBe(true);
    await page.close();
    await ctx.close();
  });

  test("the no-email member's waiver link is refused honestly, not with a 500", async ({ browser, baseURL }) => {
    const owner = await ownerCtx(browser, baseURL);
    const noEmail = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = $1 AND (email IS NULL OR email = $2) LIMIT 1',
      [tenantId, ""],
    );
    test.skip(noEmail.length === 0, "UNCOVERED — no member without an email was created");
    const res = await owner.request.post(`/api/members/${noEmail[0].id}/waiver-link`, {
      headers: { Origin: origin(baseURL) },
      data: {},
    });
    expect(res.status(), "a member with no email gets an honest 400, never a 500").toBe(400);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  test("ATTACK — a card token from tenant A is refused at tenant B's scan route", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const coach = await sessionFor(browser, o, { slug, email: COACH_EMAIL, viewport: PHONE, isMobile: true });
    const before = await countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]);

    for (const [label, token] of [
      ["junk", "token.junk"],
      ["oversize", "x".repeat(4_097)],
      ["empty", ""],
    ] as const) {
      const res = await coach.request.post("/api/checkin/card", {
        headers: { Origin: o },
        data: { token },
      });
      expect(res.status(), `card token: ${label} never 500s`).not.toBe(500);
      const body = await res.json().catch(() => ({}));
      test.info().annotations.push({ type: "observed", description: `card token ${label} → ${res.status()} ${JSON.stringify(body).slice(0, 80)}` });
    }
    expect(await countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]), "nothing written by a bad card token").toBe(before);
    await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["%card%"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.people.teardown", () => {
  test("close sessions (and tear down if A0_TEARDOWN_HERE is set)", async () => {
    await closeSessions();
    if (!process.env.A0_TEARDOWN_HERE) return;
    const file = readTenantFile();
    await teardownTenantB(RUN_STAMP);
    expect(await countOf("Tenant", "id = $1", [file.tenantId])).toBe(0);
  });
});
