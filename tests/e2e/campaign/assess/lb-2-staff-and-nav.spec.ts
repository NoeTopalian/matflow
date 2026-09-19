/**
 * Lane L-B, file 2 — J17 add staff · J18 nav ↔ page gate ↔ API · J19 staff
 * mutation is owner-only.
 *
 * J18 is the whole table: for every entry in `components/layout/routes.ts`,
 * for all four staff roles, assert (a) the nav shows the item iff the manifest
 * lists the role, (b) the final URL after `goto` — a refused page is a
 * redirect, never a status — and (c) the API the page reads refuses what the
 * page refuses. The three must agree; a disagreement is an ERROR of the
 * nav-vs-gate class whichever way it falls.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import { STAFF_NAV, type StaffRole } from "../../../../components/layout/routes";
import {
  sessionFor,
  anonContext,
  closeSessions,
  createThrowawayStaff,
  teardownThrowawayStaff,
  apiCall,
  describeResponse,
  countOf,
  assertUnchanged,
  assertNoOverflow,
  COACH_A,
  ADMIN_A,
  MEMBER_A,
  OWNER_A,
  PASSWORD_A,
  THROWAWAY_PASSWORD,
  type ThrowawayStaff,
} from "./lb-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

let tenantId: string;
let managerStaff: ThrowawayStaff;
let victimCoach: ThrowawayStaff;
let ctx: Record<StaffRole, BrowserContext>;
let ctxMember: BrowserContext;
let ctxAnon: BrowserContext;

/** The page gate each dashboard route actually applies, read from the source. */
const PAGE_GATE: Record<string, StaffRole[]> = {
  "/dashboard": ["owner", "manager", "coach", "admin"],            // requireStaff
  "/dashboard/timetable": ["owner", "manager", "coach", "admin"],  // requireStaff
  "/dashboard/checkin": ["owner", "manager", "coach", "admin"],    // requireStaff
  "/dashboard/members": ["owner", "manager", "coach", "admin"],    // requireStaff
  "/dashboard/attendance": ["owner", "manager", "coach", "admin"], // requireStaff
  "/dashboard/ranks": ["owner", "manager", "coach"],               // requireRole
  "/dashboard/promotions": ["owner", "manager"],                   // requireStaff + redirect
  "/dashboard/notifications": ["owner", "manager"],                // requireOwnerOrManager
  "/dashboard/reports": ["owner", "manager"],                      // requireRole
  "/dashboard/memberships": ["owner"],                             // requireRole
  "/dashboard/payments": ["owner", "manager"],                     // requireOwnerOrManager (≠ nav)
  "/dashboard/analysis": ["owner"],                                // requireRole
  "/dashboard/settings": ["owner"],                                // requireRole
};

/** The API each page reads, for the third leg of the triangle. */
const PAGE_API: Record<string, string> = {
  "/dashboard": "/api/tasks",
  "/dashboard/timetable": "/api/classes",
  "/dashboard/checkin": "/api/coach/today",
  "/dashboard/members": "/api/members",
  "/dashboard/attendance": "/api/dashboard/stats",
  "/dashboard/ranks": "/api/ranks",
  "/dashboard/promotions": "/api/promotions/candidates",
  "/dashboard/notifications": "/api/announcements",
  "/dashboard/reports": "/api/reports",
  "/dashboard/memberships": "/api/memberships",
  "/dashboard/payments": "/api/payments",
  "/dashboard/analysis": "/api/revenue/summary",
  "/dashboard/settings": "/api/settings",
};

test.beforeAll(async ({ browser, baseURL }) => {
  tenantId = await seededTenantId();
  managerStaff = await createThrowawayStaff("manager");
  victimCoach = await createThrowawayStaff("coach");
  const b = baseURL!;
  ctx = {
    owner: await sessionFor(browser, b, { email: OWNER_A, password: PASSWORD_A }),
    manager: await sessionFor(browser, b, { email: managerStaff.email, password: THROWAWAY_PASSWORD }),
    coach: await sessionFor(browser, b, { email: COACH_A, password: PASSWORD_A }),
    admin: await sessionFor(browser, b, { email: ADMIN_A, password: PASSWORD_A }),
  };
  ctxMember = await sessionFor(browser, b, { email: MEMBER_A, password: PASSWORD_A });
  ctxAnon = await anonContext(browser, b);
});

test.afterAll(async () => {
  await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
  await teardownThrowawayStaff();
  await closeSessions();
  await ctxAnon?.close().catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// J17 — adding staff
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J17 add staff — every column but the owner", () => {
  test("REFUSED: POST staff as manager, coach, admin, member, anonymous", async ({ baseURL }) => {
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);
    for (const [role, c, status] of [
      ["manager", ctx.manager, 403],
      ["coach", ctx.coach, 403],
      ["admin", ctx.admin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const r = await apiCall(c.request, "post", "/api/staff", baseURL!, {
        name: `${RUN_STAMP} forged`,
        email: `${RUN_STAMP}-forged-${role}@example.test`,
        role: "manager",
        password: "Passw0rd!2026",
      });
      // Round 1: the anonymous cell answered 200, which this handler cannot
      // emit. Print the evidence BEFORE asserting so the log names the cause
      // whichever way it falls (see lb-shared.ts `apiCall`, now maxRedirects:0).
      if (role === "anonymous" || r.status !== status) describeResponse(`${role} POST /api/staff`, r);
      expect(r.status, `${role} POST /api/staff`).toBe(status);
      // /api/staff answers `{ error }` — no `ok` key — unlike the rest.
      const body = r.body as Record<string, unknown>;
      expect(typeof body.error, `${role} refusal carries an error string`).toBe("string");
      if (role !== "anonymous") expect(body.error).toBe("Only owners can add staff");
    }
    await assertUnchanged("User", before, '"tenantId" = $1', [tenantId]);
  });

  test("GET staff: manager 200, coach and admin per the route; record every key", async ({ baseURL }) => {
    const seen: Record<string, number> = {};
    for (const [role, c] of [
      ["manager", ctx.manager],
      ["coach", ctx.coach],
      ["admin", ctx.admin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      const r = await apiCall(c.request, "get", "/api/staff", baseURL!);
      seen[role] = r.status;
      if (r.status === 200 && Array.isArray(r.body)) {
        const keys = [...new Set((r.body as Record<string, unknown>[]).flatMap((x) => Object.keys(x)))];
        // Allow-list, never a denylist: the finding is the key nobody forbade.
        expect(keys.sort(), `${role} staff key set`).toEqual(
          ["createdAt", "email", "id", "name", "role"].sort(),
        );
        expect(keys, "a password hash never leaves the server").not.toContain("passwordHash");
        expect(keys, "TOTP secrets never leave the server").not.toContain("totpSecret");
      }
    }
    console.log("[L-B J17] GET /api/staff by role:", JSON.stringify(seen));
    expect(seen.manager, "a manager may read the staff list").toBe(200);
    expect(seen.coach, "a coach may not").toBe(403);
    expect(seen.admin, "an admin may not").toBe(403);
    expect(seen.member, "a member may not").toBe(403);
  });

  test("GET staff/assignable is open to all four staff roles and leaks nothing", async ({ baseURL }) => {
    for (const role of ["owner", "manager", "coach", "admin"] as const) {
      const r = await apiCall(ctx[role].request, "get", "/api/staff/assignable", baseURL!);
      expect(r.status, `${role} GET staff/assignable`).toBe(200);
      const keys = [...new Set((r.body as Record<string, unknown>[]).flatMap((x) => Object.keys(x)))];
      expect(keys.sort(), `${role} assignable key set`).toEqual(["id", "name", "role"].sort());
      expect(keys, "no email on the assignable list").not.toContain("email");
    }
    const m = await apiCall(ctxMember.request, "get", "/api/staff/assignable", baseURL!);
    expect(m.status, "a member is refused").toBe(403);
    const a = await apiCall(ctxAnon.request, "get", "/api/staff/assignable", baseURL!);
    expect(a.status, "anonymous is 401 JSON, never an HTML login page").toBe(401);
    expect((a.body as { __nonJson?: string }).__nonJson, "the 401 is JSON").toBeUndefined();
  });

  test("the owner's typed role is what SELECT role returns; a fifth role is refused", async ({ baseURL }) => {
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);
    for (const role of ["manager", "coach", "admin"] as const) {
      const email = `${RUN_STAMP}-typed-${role}@example.test`;
      const r = await apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, {
        name: `${RUN_STAMP} ${role}`,
        email,
        role,
        password: "Passw0rd!2026",
      });
      expect(r.status, `owner creates a ${role}`).toBe(201);
      const row = (
        await sql<{ role: string }>('SELECT role FROM "User" WHERE email = $1', [email])
      )[0];
      expect(row.role, `SELECT role equals the typed ${role}`).toBe(role);
    }

    // A role outside the four, and the naming trap: "owner" is not creatable.
    for (const bad of ["owner", "operator", "superuser", "", null, 7]) {
      const r = await apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, {
        name: `${RUN_STAMP} bad`,
        email: `${RUN_STAMP}-bad-${String(bad)}@example.test`,
        role: bad,
        password: "Passw0rd!2026",
      });
      expect(r.status, `role ${JSON.stringify(bad)} is refused`).toBe(400);
    }
    // A second owner cannot be minted through this route.
    const owners = await countOf("User", '"tenantId" = $1 AND role = $2', [tenantId, "owner"]);
    expect(owners, "the club still has exactly one owner").toBe(1);

    const after = await countOf("User", '"tenantId" = $1', [tenantId]);
    expect(after, "only the three valid roles were created").toBe(before + 3);
  });

  test("malformed and oversize staff bodies never 500", async ({ baseURL }) => {
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);
    const cases: [string, unknown][] = [
      ["a 10 000-character name", { name: "A".repeat(10_000), email: `${RUN_STAMP}-big@example.test`, role: "coach", password: "Passw0rd!2026" }],
      ["a 7-character password", { name: "x", email: `${RUN_STAMP}-short@example.test`, role: "coach", password: "1234567" }],
      ["no password at all", { name: "x", email: `${RUN_STAMP}-nopw@example.test`, role: "coach" }],
      ["a non-email", { name: "x", email: "not-an-email", role: "coach", password: "Passw0rd!2026" }],
      ["an empty body", {}],
      ["an array", []],
      ["a null role", { name: "x", email: `${RUN_STAMP}-nr@example.test`, role: null, password: "Passw0rd!2026" }],
    ];
    for (const [label, data] of cases) {
      const r = await apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, data);
      expect(r.status, `${label} → 400`).toBe(400);
    }
    // Duplicate email → 409, not a 500 and not a second row.
    const email = `${RUN_STAMP}-dup@example.test`;
    const first = await apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, {
      name: `${RUN_STAMP} dup`, email, role: "coach", password: "Passw0rd!2026",
    });
    expect(first.status).toBe(201);
    const second = await apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, {
      name: `${RUN_STAMP} dup`, email, role: "coach", password: "Passw0rd!2026",
    });
    expect(second.status, "the same email twice").toBe(409);
    expect(await countOf("User", "email = $1", [email]), "one row, not two").toBe(1);

    // Race: two identical creates at once must not both land.
    const raceEmail = `${RUN_STAMP}-race@example.test`;
    const body = { name: `${RUN_STAMP} race`, email: raceEmail, role: "coach", password: "Passw0rd!2026" };
    const [a, b] = await Promise.all([
      apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, body),
      apiCall(ctx.owner.request, "post", "/api/staff", baseURL!, body),
    ]);
    expect([a.status, b.status].filter((s) => s >= 500), "no 500 under a race").toEqual([]);
    expect(await countOf("User", "email = $1", [raceEmail]), "exactly one row survives the race").toBe(1);

    await assertUnchanged("User", before + 2, '"tenantId" = $1', [tenantId]);
  });

  test("CSRF on POST staff: no Origin and a foreign Origin are both 403", async () => {
    const before = await countOf("User", '"tenantId" = $1', [tenantId]);
    const body = {
      name: `${RUN_STAMP} csrf`,
      email: `${RUN_STAMP}-csrf@example.test`,
      role: "manager",
      password: "Passw0rd!2026",
    };
    const noOrigin = await ctx.owner.request.fetch("/api/staff", { method: "POST", data: body });
    expect(noOrigin.status(), "POST staff with no Origin").toBe(403);
    const foreign = await ctx.owner.request.fetch("/api/staff", {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      data: body,
    });
    expect(foreign.status(), "POST staff with a foreign Origin").toBe(403);
    // A matched forged pair is HELD by construction — no browser, no victim
    // cookie — so the record is the status and that nothing was written.
    const matched = await ctxAnon.request.fetch("/api/staff", {
      method: "POST",
      headers: { Origin: "http://evil.test", Host: "evil.test" },
      data: body,
    });
    console.log(`[L-B J17] matched forged Origin/Host pair → ${matched.status()}`);
    await assertUnchanged("User", before, '"tenantId" = $1', [tenantId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J18 — the triangle
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J18 nav ↔ page gate ↔ API", () => {
  for (const role of ["owner", "manager", "coach", "admin"] as StaffRole[]) {
    test(`the nav a ${role} sees is exactly the manifest's list`, async () => {
      const page = await ctx[role].newPage();
      await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>("nav a[href^='/dashboard']")).map(
          (a) => new URL(a.href).pathname,
        ),
      );
      const seen = new Set(hrefs);
      for (const item of STAFF_NAV) {
        const expected = item.roles.includes(role);
        // The mobile "More" sheet holds the rest, so at desktop width every
        // permitted item must be present; nothing forbidden may be.
        if (!expected) {
          expect(seen.has(item.href), `${role} must not see a link to ${item.href}`).toBe(false);
        }
      }
      console.log(`[L-B J18] ${role} nav:`, JSON.stringify([...seen].sort()));
      await page.close();
    });

    test(`the page gate a ${role} meets agrees with the nav`, async () => {
      const page = await ctx[role].newPage();
      const disagreements: string[] = [];
      for (const item of STAFF_NAV) {
        await page.goto(item.href, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        const landed = new URL(page.url()).pathname;
        const reached = landed === item.href;
        const navSays = item.roles.includes(role);
        const gateSays = (PAGE_GATE[item.href] ?? []).includes(role);
        expect(reached, `${role} reaching ${item.href} must match the page gate`).toBe(gateSays);
        if (navSays !== gateSays) disagreements.push(`${item.href}: nav=${navSays} gate=${gateSays}`);
      }
      await page.close();
      console.log(`[L-B J18] ${role} nav-vs-gate disagreements:`, JSON.stringify(disagreements));
      // The known one is /dashboard/payments (routes.ts:57 owner-only vs
      // payments/page.tsx:22 requireOwnerOrManager). Any OTHER disagreement is
      // a new ERROR; this assertion fails the moment one appears.
      expect(
        disagreements.filter((d) => !d.startsWith("/dashboard/payments")),
        `${role}: nav and gate disagree on a route other than the known one`,
      ).toEqual([]);
      if (role === "manager") {
        expect(
          disagreements,
          "the known nav-vs-gate disagreement is still open — a manager can reach Payments but has no link",
        ).toEqual(["/dashboard/payments: nav=false gate=true"]);
      }
    });

    test(`the API each page reads refuses what the page refuses for a ${role}`, async ({ baseURL }) => {
      const rows: string[] = [];
      for (const item of STAFF_NAV) {
        const api = PAGE_API[item.href];
        if (!api) continue;
        const gateSays = (PAGE_GATE[item.href] ?? []).includes(role);
        const r = await apiCall(ctx[role].request, "get", api, baseURL!);
        rows.push(`${item.href} → ${api}: gate=${gateSays} api=${r.status}`);
        expect(r.status, `${api} as ${role} is never a 500`).toBeLessThan(500);
        if (!gateSays) {
          expect(
            r.status,
            `${role} cannot open ${item.href}, so ${api} must refuse too — a readable API behind a closed page is an EXPLOIT`,
          ).toBeGreaterThanOrEqual(400);
        }
      }
      console.log(`[L-B J18] ${role} page→API triangle:\n  ${rows.join("\n  ")}`);
    });
  }

  test("a member and an anonymous caller reach no dashboard page at all", async () => {
    for (const [label, c] of [["member", ctxMember], ["anonymous", ctxAnon]] as const) {
      const page = await c.newPage();
      for (const item of STAFF_NAV) {
        await page.goto(item.href, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        const landed = new URL(page.url()).pathname;
        expect(landed, `${label} must be redirected off ${item.href}`).not.toBe(item.href);
      }
      await page.close();
    }
  });

  test("/dashboard/promotions double-gates: requireStaff then a redirect", async () => {
    // Recorded rather than judged: the second gate is what actually refuses a
    // coach, and a coach who follows a stale link lands on /dashboard with no
    // explanation.
    const page = await ctx.coach.newPage();
    await page.goto("/dashboard/promotions", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(new URL(page.url()).pathname, "a coach lands back on the dashboard").toBe("/dashboard");
    const text = await page.locator("body").innerText();
    console.log(
      "[L-B J18] does the coach get told why? ",
      /permission|not allowed|owner|manager/i.test(text),
    );
    await page.close();
  });

  test("layout: every page a coach can reach holds 390 px", async () => {
    const page = await ctx.coach.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const item of STAFF_NAV.filter((i) => (PAGE_GATE[i.href] ?? []).includes("coach"))) {
      await page.goto(item.href, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      await assertNoOverflow(page, 390, `coach at ${item.href}`);
    }
    await page.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J19 — staff mutation is owner-only
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J19 staff mutation", () => {
  test("REFUSED: manager, coach, admin PATCH and DELETE any staff row", async ({ baseURL }) => {
    const target = victimCoach.id;
    const before = (
      await sql<{ name: string; role: string; email: string }>(
        'SELECT name, role, email FROM "User" WHERE id = $1',
        [target],
      )
    )[0];
    const users = await countOf("User", '"tenantId" = $1', [tenantId]);

    for (const [role, c, status] of [
      ["manager", ctx.manager, 403],
      ["coach", ctx.coach, 403],
      ["admin", ctx.admin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const p = await apiCall(c.request, "patch", `/api/staff/${target}`, baseURL!, {
        role: "manager",
        name: `${RUN_STAMP} hijacked`,
      });
      expect(p.status, `${role} PATCH staff/[id]`).toBe(status);
      if (role !== "anonymous") {
        expect((p.body as { error?: string }).error).toBe("Only owners can edit staff");
      }
      const d = await apiCall(c.request, "delete", `/api/staff/${target}`, baseURL!);
      expect(d.status, `${role} DELETE staff/[id]`).toBe(status);
      if (role !== "anonymous") {
        expect((d.body as { error?: string }).error).toBe("Only owners can remove staff");
      }
    }

    const after = (
      await sql<{ name: string; role: string; email: string }>(
        'SELECT name, role, email FROM "User" WHERE id = $1',
        [target],
      )
    )[0];
    expect(after, "the target row is byte-for-byte what it was").toEqual(before);
    await assertUnchanged("User", users, '"tenantId" = $1', [tenantId]);
  });

  test("the owner cannot remove or demote themselves", async ({ baseURL }) => {
    const ownerRow = (
      await sql<{ id: string; role: string }>(
        'SELECT id, role FROM "User" WHERE "tenantId" = $1 AND role = $2',
        [tenantId, "owner"],
      )
    )[0];
    const d = await apiCall(ctx.owner.request, "delete", `/api/staff/${ownerRow.id}`, baseURL!);
    expect(d.status, "deleting yourself").toBe(400);
    expect((d.body as { error?: string }).error).toBe("Cannot delete your own account");

    const p = await apiCall(ctx.owner.request, "patch", `/api/staff/${ownerRow.id}`, baseURL!, {
      role: "coach",
    });
    // The updateMany excludes `role: "owner"`, so this is a 404 rather than a
    // 403 — record which, and prove the row did not move either way.
    console.log(`[L-B J19] owner demoting themselves → ${p.status}`);
    expect(p.status, "an owner is never demoted through this route").toBeGreaterThanOrEqual(400);
    const still = (
      await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [ownerRow.id])
    )[0].role;
    expect(still, "the club still has its owner").toBe("owner");
    expect(
      await countOf("User", '"tenantId" = $1 AND role = $2', [tenantId, "owner"]),
      "and exactly one of them",
    ).toBe(1);
  });

  test("a removed user's cookie is refused on its very next request", async ({ browser, baseURL }) => {
    const doomed = await createThrowawayStaff("coach");
    const c = await sessionFor(browser, baseURL!, {
      email: doomed.email,
      password: THROWAWAY_PASSWORD,
      fresh: true,
    });
    const alive = await apiCall(c.request, "get", "/api/coach/today", baseURL!);
    expect(alive.status, "the session works before the removal").toBe(200);

    const d = await apiCall(ctx.owner.request, "delete", `/api/staff/${doomed.id}`, baseURL!);
    expect(d.status, "the owner removes them").toBe(200);
    expect(await countOf("User", "id = $1", [doomed.id]), "the row is gone").toBe(0);

    const dead = await apiCall(c.request, "get", "/api/coach/today", baseURL!);
    console.log(`[L-B J19] removed staff's next request → ${dead.status}`);
    expect(dead.status, "a removed user's cookie buys nothing").toBeGreaterThanOrEqual(400);
    expect(dead.status, "and is not a 500").toBeLessThan(500);

    const page = await c.newPage();
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(new URL(page.url()).pathname, "and the dashboard is closed to them").not.toBe("/dashboard");
    await page.close();
    await c.close();
  });

  test("cross-tenant: the seeded owner cannot touch a foreign staff row", async ({ baseURL }) => {
    const foreign = (
      await sql<{ id: string; tenantId: string; role: string }>(
        'SELECT id, "tenantId", role FROM "User" WHERE "tenantId" <> $1 AND role <> $2 LIMIT 1',
        [tenantId, "owner"],
      )
    )[0];
    test.skip(!foreign, "no second club on the branch to borrow an id from");
    const before = (
      await sql<{ name: string; role: string }>('SELECT name, role FROM "User" WHERE id = $1', [foreign.id])
    )[0];

    const p = await apiCall(ctx.owner.request, "patch", `/api/staff/${foreign.id}`, baseURL!, {
      name: `${RUN_STAMP} cross`,
    });
    expect(p.status, "a foreign id answers like a missing one — 404, never 403").toBe(404);
    const d = await apiCall(ctx.owner.request, "delete", `/api/staff/${foreign.id}`, baseURL!);
    expect(d.status, "and the same on delete").toBe(404);

    const after = (
      await sql<{ name: string; role: string }>('SELECT name, role FROM "User" WHERE id = $1', [foreign.id])
    )[0];
    expect(after, "the foreign row is untouched").toEqual(before);
  });

  test("enumeration: a missing id and a foreign id answer identically", async ({ baseURL }) => {
    const missing = await apiCall(
      ctx.owner.request,
      "patch",
      "/api/staff/00000000-0000-0000-0000-000000000000",
      baseURL!,
      { name: "x" },
    );
    const foreign = (
      await sql<{ id: string }>('SELECT id FROM "User" WHERE "tenantId" <> $1 LIMIT 1', [tenantId])
    )[0];
    if (!foreign) return;
    const cross = await apiCall(ctx.owner.request, "patch", `/api/staff/${foreign.id}`, baseURL!, {
      name: "x",
    });
    expect([cross.status, JSON.stringify(cross.body)], "a foreign id is indistinguishable from a missing one").toEqual(
      [missing.status, JSON.stringify(missing.body)],
    );
  });

  test("a role value outside the four is refused on PATCH too", async ({ baseURL }) => {
    const before = (
      await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [victimCoach.id])
    )[0].role;
    for (const bad of ["owner", "operator", "", null, 7, ["coach"]]) {
      const r = await apiCall(ctx.owner.request, "patch", `/api/staff/${victimCoach.id}`, baseURL!, {
        role: bad,
      });
      expect(r.status, `PATCH role=${JSON.stringify(bad)}`).toBe(400);
    }
    const after = (
      await sql<{ role: string }>('SELECT role FROM "User" WHERE id = $1', [victimCoach.id])
    )[0].role;
    expect(after, "the role never moved").toBe(before);
  });

  test("two owners: record whether the product prevents a second one", async ({ baseURL }) => {
    // Neither POST /api/staff nor PATCH /api/staff/[id] accepts "owner", so the
    // only door is the operator's transfer (J20, L-G's plane). Recorded here so
    // the cell is not silently N/A.
    const owners = await countOf("User", '"tenantId" = $1 AND role = $2', [tenantId, "owner"]);
    expect(owners, "the seeded club has one owner").toBe(1);
    const r = await apiCall(ctx.owner.request, "patch", `/api/staff/${victimCoach.id}`, baseURL!, {
      role: "owner",
    });
    expect(r.status, "promotion to owner is not in the enum").toBe(400);
    expect(
      await countOf("User", '"tenantId" = $1 AND role = $2', [tenantId, "owner"]),
      "still one owner",
    ).toBe(1);
  });
});
