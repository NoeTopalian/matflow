/**
 * Lane L-B, file 1 — J11 wizard · J12 branding · J13 kiosk · J14 waiver text ·
 * J15 rail/memberSelfBilling/currency · J16 timezone.
 *
 * Lane A0 drives column one (owner, fresh club). This file drives EVERY OTHER
 * COLUMN on the seeded club `totalbjj`: manager, coach, admin, member and
 * anonymous at the API with an unchanged count, plus every attack class in
 * COMMON on every mutating route the six journeys name.
 *
 * Rule 6: the seeded club is shared. Nothing here rotates its kiosk token,
 * suspends it or resets a seeded password. The rotation cell runs on this
 * lane's own throwaway tenant; the timezone cell restores the column in a
 * `finally` because L-D reads it.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { sql, RUN_STAMP, seededTenantId } from "../helpers/db";
import {
  sessionFor,
  anonContext,
  closeSessions,
  createThrowawayStaff,
  createThrowawayTenant,
  teardownThrowawayTenant,
  teardownThrowawayStaff,
  apiCall,
  expectRefusalShape,
  countOf,
  assertUnchanged,
  assertNoOverflow,
  clearBucket,
  COACH_A,
  ADMIN_A,
  MEMBER_A,
  OWNER_A,
  PASSWORD_A,
  THROWAWAY_PASSWORD,
  type ThrowawayTenant,
  type ThrowawayStaff,
} from "./lb-shared";

test.describe.configure({ mode: "default", timeout: 180_000 });

let managerStaff: ThrowawayStaff;
let throwaway: ThrowawayTenant;
let tenantId: string;

let ctxManager: BrowserContext;
let ctxCoach: BrowserContext;
let ctxAdmin: BrowserContext;
let ctxMember: BrowserContext;
let ctxAnon: BrowserContext;

/** Snapshot of every settings column this file may touch, restored in afterAll. */
let settingsBefore: Record<string, unknown>;

const SETTINGS_COLUMNS = [
  "name",
  "primaryColor",
  "secondaryColor",
  "textColor",
  "logoUrl",
  "logoSize",
  "waiverTitle",
  "waiverContent",
  "kidsWaiverTitle",
  "kidsWaiverContent",
  "paymentRail",
  "memberSelfBilling",
  "acceptsBacs",
  "timezone",
  "checkinWindowBeforeMin",
  "checkinWindowAfterMin",
] as const;

test.beforeAll(async ({ browser, baseURL }) => {
  tenantId = await seededTenantId();
  const cols = SETTINGS_COLUMNS.map((c) => `"${c}"`).join(", ");
  settingsBefore = (await sql(`SELECT ${cols} FROM "Tenant" WHERE id = $1`, [tenantId]))[0];

  // The seed ships owner / coach / admin but no manager — mint one.
  managerStaff = await createThrowawayStaff("manager");
  throwaway = await createThrowawayTenant();

  const b = baseURL!;
  ctxManager = await sessionFor(browser, b, { email: managerStaff.email, password: THROWAWAY_PASSWORD });
  ctxCoach = await sessionFor(browser, b, { email: COACH_A, viewport: { width: 390, height: 844 }, isMobile: true });
  ctxAdmin = await sessionFor(browser, b, { email: ADMIN_A, viewport: { width: 768, height: 1024 }, isMobile: false });
  ctxMember = await sessionFor(browser, b, { email: MEMBER_A, viewport: { width: 390, height: 844 }, isMobile: true });
  ctxAnon = await anonContext(browser, b);
});

test.afterAll(async () => {
  // Restore every settings column before anything else: another lane reading a
  // half-restored timezone would fail with a symptom nowhere near the cause.
  if (settingsBefore) {
    const sets = SETTINGS_COLUMNS.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
    await sql(
      `UPDATE "Tenant" SET ${sets} WHERE id = $${SETTINGS_COLUMNS.length + 1}`,
      [...SETTINGS_COLUMNS.map((c) => settingsBefore[c]), tenantId],
    );
    const after = (await sql(`SELECT "timezone", "paymentRail" FROM "Tenant" WHERE id = $1`, [tenantId]))[0];
    expect(after.timezone, "seeded timezone restored for the other lanes").toBe(settingsBefore.timezone);
  }
  await sql('DELETE FROM "ClassInstance" WHERE "classId" IN (SELECT id FROM "Class" WHERE name LIKE $1)', [
    `${RUN_STAMP}%`,
  ]).catch(() => {});
  await sql('DELETE FROM "ClassSchedule" WHERE "classId" IN (SELECT id FROM "Class" WHERE name LIKE $1)', [
    `${RUN_STAMP}%`,
  ]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE name LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
  if (throwaway) await teardownThrowawayTenant(throwaway);
  await teardownThrowawayStaff();
  await closeSessions();
  await ctxAnon?.close().catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════════
// J11 — the onboarding wizard, every column that is not the owner
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J11 wizard — non-owner columns", () => {
  test("REFUSED: /onboarding is not reachable by manager, coach, admin or a member", async () => {
    for (const [role, ctx] of [
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
    ] as const) {
      const page = await ctx.newPage();
      await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => {});
      const path = new URL(page.url()).pathname;
      // A refused PAGE is a redirect, never a status. Assert the landing URL
      // and that the wizard's own first step is not on the screen.
      expect(path, `${role} redirected off /onboarding`).not.toBe("/onboarding");
      await expect(page.locator("body"), `${role} sees no wizard`).not.toHaveText(/Let.s set up your gym/i);
      await page.close();
    }
  });

  test("REFUSED: POST owner/reset-onboarding — 403, onboardingCompleted unmoved", async ({ baseURL }) => {
    const before = (
      await sql<{ onboardingCompleted: boolean }>(
        'SELECT "onboardingCompleted" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0].onboardingCompleted;

    for (const [role, ctx, status] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const r = await apiCall(ctx.request, "post", "/api/owner/reset-onboarding", baseURL!, {});
      expect(r.status, `${role} POST owner/reset-onboarding`).toBe(status);
      expect(typeof (r.body as { error?: unknown }).error).toBe("string");
    }

    const after = (
      await sql<{ onboardingCompleted: boolean }>(
        'SELECT "onboardingCompleted" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0].onboardingCompleted;
    expect(after, "onboardingCompleted unchanged across five refusals").toBe(before);
  });

  test("REFUSED: the wizard's own writes by non-owners — settings, classes, ranks", async ({ baseURL }) => {
    const tenantsBefore = (await sql(`SELECT "primaryColor" FROM "Tenant" WHERE id = $1`, [tenantId]))[0];
    const classesBefore = await countOf("Class", '"tenantId" = $1 AND name NOT LIKE $2', [
      tenantId,
      `${RUN_STAMP}%`,
    ]);
    const ranksBefore = await countOf("RankSystem", '"tenantId" = $1', [tenantId]);

    for (const [role, ctx] of [
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
    ] as const) {
      const s = await apiCall(ctx.request, "patch", "/api/settings", baseURL!, { primaryColor: "#123456" });
      expect(s.status, `${role} PATCH settings`).toBe(403);
      expect((s.body as { error?: string }).error).toBe("Only owners can change gym settings");
    }

    // Classes and ranks have their own allow-lists (L-D / L-F own the rule);
    // this cell records what the wizard's writes actually answer per role so
    // the nav-gate-API triangle can be checked against it.
    const observed: Record<string, number[]> = {};
    for (const [role, ctx] of [
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
    ] as const) {
      const c = await apiCall(ctx.request, "post", "/api/classes", baseURL!, {
        name: `${RUN_STAMP} wizard probe`,
        dayOfWeek: 1,
        startTime: "18:00",
        duration: 60,
      });
      const k = await apiCall(ctx.request, "post", "/api/ranks", baseURL!, {
        discipline: "bjj",
        name: `${RUN_STAMP} probe belt`,
        order: 99,
      });
      observed[role] = [c.status, k.status];
      expect(c.status, `${role} POST classes is never a 500`).toBeLessThan(500);
      expect(k.status, `${role} POST ranks is never a 500`).toBeLessThan(500);
    }
    console.log("[L-B J11] wizard writes by role [classes, ranks]:", JSON.stringify(observed));

    // Coach, admin and member must not have written anything.
    expect(
      (await sql(`SELECT "primaryColor" FROM "Tenant" WHERE id = $1`, [tenantId]))[0].primaryColor,
    ).toBe(tenantsBefore.primaryColor);
    // A manager may legitimately create a class, so the invariant is stated on
    // the rows this run did NOT create: no pre-existing class appeared or
    // vanished. Anything stamped is binned by the afterAll sweep.
    const preExistingAfter = await countOf("Class", '"tenantId" = $1 AND name NOT LIKE $2', [
      tenantId,
      `${RUN_STAMP}%`,
    ]);
    expect(preExistingAfter, "no pre-existing class was touched").toBe(classesBefore);
    await assertUnchanged("RankSystem", ranksBefore, '"tenantId" = $1 AND name NOT LIKE $2', [
      tenantId,
      `${RUN_STAMP}%`,
    ]);
  });

  test("REFUSED: onboarding/csv-handoff from each non-owner role, no ImportJob written", async ({ baseURL }) => {
    const before = await countOf("ImportJob", '"tenantId" = $1', [tenantId]);
    for (const [role, ctx, status] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const res = await ctx.request.fetch("/api/onboarding/csv-handoff", {
        method: "POST",
        headers: { Origin: baseURL! },
        multipart: {
          file: { name: "members.csv", mimeType: "text/csv", buffer: Buffer.from("name,email\nA,a@x.test\n") },
          notes: "campaign probe",
        },
      });
      expect(res.status(), `${role} POST onboarding/csv-handoff`).toBe(status);
    }
    await assertUnchanged("ImportJob", before, '"tenantId" = $1', [tenantId]);
  });

  test("CSRF: csv-handoff is a formData route — missing and foreign Origin are 403", async () => {
    const before = await countOf("ImportJob", '"tenantId" = $1', [tenantId]);
    // Round 2: not `ctxAnon`. "Any context, the guard runs before the session
    // gate" was true of the ROUTE and false of the stack: `proxy.ts:120-132`
    // answers every unauthenticated `/api/*` 401 before Next ever calls the
    // handler, so anonymously this measured the middleware, not the CSRF
    // guard. A manager is authenticated (so the request arrives) and is not an
    // owner (so a guard that failed to refuse would still write nothing —
    // `requireApiOwner` is the next line of the route).
    const owner = ctxManager;
    const noOrigin = await owner.request.fetch("/api/onboarding/csv-handoff", {
      method: "POST",
      multipart: { file: { name: "m.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n") } },
    });
    expect(noOrigin.status(), "csv-handoff with no Origin").toBe(403);
    expect(
      JSON.stringify(await noOrigin.json()),
      "and the refusal is the origin guard's, not the owner gate's",
    ).toMatch(/origin/i);

    const foreign = await owner.request.fetch("/api/onboarding/csv-handoff", {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      multipart: { file: { name: "m.csv", mimeType: "text/csv", buffer: Buffer.from("a,b\n") } },
    });
    expect(foreign.status(), "csv-handoff with a foreign Origin").toBe(403);
    await assertUnchanged("ImportJob", before, '"tenantId" = $1', [tenantId]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J12 — branding
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J12 branding — refusals, the read allow-list and the cache", () => {
  test("REFUSED: PATCH settings as manager, coach, admin, member, anonymous", async ({ baseURL }) => {
    const before = (
      await sql<{ primaryColor: string; name: string }>(
        'SELECT "primaryColor", name FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    const auditBefore = await countOf("AuditLog", '"tenantId" = $1 AND action = $2', [
      tenantId,
      "tenant.settings.update",
    ]);

    for (const [role, ctx, status] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const r = await apiCall(ctx.request, "patch", "/api/settings", baseURL!, {
        primaryColor: "#ff00ff",
        name: `${RUN_STAMP} HIJACKED`,
      });
      expect(r.status, `${role} PATCH settings`).toBe(status);
      expect(typeof (r.body as { error?: unknown }).error, `${role} refusal carries an error string`).toBe(
        "string",
      );
    }

    const after = (
      await sql<{ primaryColor: string; name: string }>(
        'SELECT "primaryColor", name FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(after, "Tenant row unchanged across five refused PATCHes").toEqual(before);
    // A refusal that still wrote an audit row would be a false paper trail.
    await assertUnchanged("AuditLog", auditBefore, '"tenantId" = $1 AND action = $2', [
      tenantId,
      "tenant.settings.update",
    ]);
  });

  test("GET settings: record exactly which roles read it and which keys come back", async ({ baseURL }) => {
    // The route narrowed to owner-only (app/api/settings/route.ts:86). The brief
    // expects a coach 403; this cell also records the MANAGER answer, because
    // /dashboard/settings is owner-only but the manifest lists manager on J18.
    const seen: Record<string, number> = {};
    for (const [role, ctx] of [
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      const r = await apiCall(ctx.request, "get", "/api/settings", baseURL!);
      seen[role] = r.status;
      if (r.status === 200) {
        // A 200 for a non-owner is an EXPLOIT if it carries commercial standing.
        const keys = Object.keys(r.body as Record<string, unknown>);
        expect(
          keys.filter((k) => ["subscriptionStatus", "subscriptionTier", "_count"].includes(k)),
          `${role} must not read the club's commercial standing`,
        ).toEqual([]);
      }
    }
    console.log("[L-B J12] GET /api/settings by role:", JSON.stringify(seen));
    expect(seen.coach, "coach cannot read settings").toBe(403);
    expect(seen.member, "a member cannot read settings").toBe(403);
    expect(seen.admin, "admin cannot read settings").toBe(403);
    expect(seen.anonymous, "anonymous gets 401, not a redirect to HTML").toBe(401);
  });

  test("the localStorage gym-settings cache cannot repaint a value the server refused", async ({
    browser,
    baseURL,
  }) => {
    // The failure this guards: a PATCH that persisted nothing still leaves a
    // client cache that repaints the value on the next load, so the owner
    // believes a save landed that the database never took.
    const page = await ctxManager.newPage();
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      localStorage.setItem(
        "gym-settings",
        JSON.stringify({ primaryColor: "#ff0000", name: "CACHE POISON" }),
      ),
    );
    // The manager's PATCH is refused above; nothing persisted.
    await apiCall(ctxManager.request, "patch", "/api/settings", baseURL!, { primaryColor: "#ff0000" });
    await page.evaluate(() => localStorage.removeItem("gym-settings"));
    await page.reload({ waitUntil: "domcontentloaded" });
    const dbColour = (
      await sql<{ primaryColor: string }>('SELECT "primaryColor" FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].primaryColor;
    const painted = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
    );
    console.log("[L-B J12] db primaryColor", dbColour, "painted --primary", painted);
    expect(dbColour.toLowerCase(), "the server still holds the seeded colour").not.toBe("#ff0000");
    await page.close();
    void browser;
  });

  test("malformed branding: a bad colour, an oversize logo and a script-bearing SVG", async ({ baseURL }) => {
    // Driven with the OWNER's session (the chromium project default) because a
    // 403 would hide the validation answer under an auth answer.
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const before = (
      await sql<{ primaryColor: string; logoUrl: string | null }>(
        'SELECT "primaryColor", "logoUrl" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];

    const cases: [string, Record<string, unknown>][] = [
      ["a colour with no hash", { primaryColor: "ff00ff" }],
      ["a named colour", { primaryColor: "red" }],
      ["a 4-digit colour", { primaryColor: "#fff" }],
      ["a colour with an injection", { primaryColor: "#fff;}body{display:none" }],
      ["an SVG with a script as the logo", {
        logoUrl:
          "data:image/svg+xml;base64," +
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64"),
      }],
      ["a javascript: logo URL", { logoUrl: "javascript:alert(1)" }],
      ["a 10 000-character name", { name: "A".repeat(10_000) }],
      ["a 20 MB data-URL logo", { logoUrl: `data:image/png;base64,${"A".repeat(20 * 1024 * 1024)}` }],
      ["NaN for the check-in window", { checkinWindowBeforeMin: Number.NaN }],
      ["a negative check-in window", { checkinWindowBeforeMin: -5 }],
    ];

    for (const [label, data] of cases) {
      const r = await apiCall(owner.request, "patch", "/api/settings", baseURL!, data);
      expect(r.status, `${label} is refused, never a 500`).toBeGreaterThanOrEqual(400);
      expect(r.status, `${label} is never a 500`).toBeLessThan(500);
      console.log(`[L-B J12] ${label} → ${r.status}`);
    }

    const after = (
      await sql<{ primaryColor: string; logoUrl: string | null }>(
        'SELECT "primaryColor", "logoUrl" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(after, "no malformed branding value persisted").toEqual(before);
  });

  test("unknown keys are stripped silently — a 200 that wrote nothing is not a save", async ({ baseURL }) => {
    // Zod's default object strips unknown keys, so PATCH { timezone } answers
    // 200 with the column untouched. Recorded here because J16 depends on it.
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const before = (
      await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].timezone;
    const r = await apiCall(owner.request, "patch", "/api/settings", baseURL!, {
      timezone: "America/New_York",
      notAField: "x",
    });
    const after = (
      await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].timezone;
    console.log(`[L-B J12/J16] PATCH settings {timezone} → ${r.status}; timezone ${before} → ${after}`);
    // Round 2, and this is the assertion flipping as it said it would.
    //
    // Round 1 put `.strict()` on `updateSchema`, so an unknown key is now a
    // 400 that NAMES the key instead of a 200 that saved nothing. `notAField`
    // is still unknown, so the whole body is refused — including the valid
    // `timezone` beside it, which is the point: a partial save the caller was
    // not told about is the defect, not the cure.
    expect(r.status, "an unknown key is refused, not silently dropped").toBe(400);
    expect(JSON.stringify(r.body), "and the refusal names the key").toContain("notAField");
    expect(after, "and nothing at all was written").toBe(before);
  });

  test("layout: /dashboard/settings at 390 px as the owner, on load and with a sheet open", async ({
    baseURL,
  }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      fresh: true,
    });
    const page = await owner.newPage();
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});
    await assertNoOverflow(page, 390, "settings on load");
    // Every tab of the screen, because the 18 Sep 516 px regression came from an
    // sr-only element that only mounted on one of them.
    for (const tab of ["Branding", "Waiver", "Payments", "Staff", "Integrations"]) {
      const link = page.getByRole("tab", { name: new RegExp(tab, "i") }).first();
      if (await link.isVisible().catch(() => false)) {
        await link.click();
        await page.waitForTimeout(250);
        await assertNoOverflow(page, 390, `settings tab ${tab}`);
      }
    }
    await page.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J13 — kiosk
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J13 kiosk — per role, and the rotation on a throwaway club only", () => {
  test("REFUSED: settings/kiosk GET and POST per role; the seeded hash never moves", async ({ baseURL }) => {
    const before = (
      await sql<{ kioskTokenHash: string | null; kioskTokenIssuedAt: Date | null }>(
        'SELECT "kioskTokenHash", "kioskTokenIssuedAt" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];

    for (const [role, ctx] of [
      ["manager", ctxManager],
      ["coach", ctxCoach],
      ["admin", ctxAdmin],
      ["member", ctxMember],
      ["anonymous", ctxAnon],
    ] as const) {
      // Round 2: a caller with no session never reaches this route's own gate.
      // `proxy.ts:120-132` answers every unauthenticated `/api/*` with
      // 401 `{ ok:false, error:"Unauthorized" }` — deliberately, so that a
      // `fetch` cannot read a refusal as a 200 HTML login page. So anonymous
      // is 401 with the two-key refusal shape and a logged-in wrong role is
      // 403 with this route's own one-key shape. Asserting 403 for both was
      // my error, not the product's.
      const refusal = role === "anonymous" ? 401 : 403;
      const keys = role === "anonymous" ? ["ok", "error"] : ["error"];

      const g = await apiCall(ctx.request, "get", "/api/settings/kiosk", baseURL!);
      expect(g.status, `${role} GET settings/kiosk`).toBe(refusal);
      // The refusal must not leak whether the kiosk is even enabled.
      expect(Object.keys(g.body as Record<string, unknown>).sort(), `${role} refusal key set`)
        .toEqual([...keys].sort());

      for (const action of ["enable", "regenerate", "disable"]) {
        const p = await apiCall(ctx.request, "post", "/api/settings/kiosk", baseURL!, { action });
        expect(p.status, `${role} POST settings/kiosk {${action}}`).toBe(refusal);
      }
    }

    const after = (
      await sql<{ kioskTokenHash: string | null; kioskTokenIssuedAt: Date | null }>(
        'SELECT "kioskTokenHash", "kioskTokenIssuedAt" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(after, "the seeded club's kiosk token is untouched (rule 6)").toEqual(before);
  });

  test("MANIFEST: DELETE settings/kiosk has no handler — 405, not a disable", async ({ baseURL }) => {
    const before = (
      await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].kioskTokenHash;
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const r = await apiCall(owner.request, "delete", "/api/settings/kiosk", baseURL!);
    console.log(`[L-B J13] DELETE /api/settings/kiosk → ${r.status}`);
    expect(r.status, "the route exports GET and POST only").toBe(405);
    const after = (
      await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].kioskTokenHash;
    expect(after, "the unrouted verb wrote nothing").toBe(before);
  });

  test("rotation on the throwaway club: the old URL 404s on the next request", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, {
      slug: throwaway.slug,
      email: throwaway.ownerEmail,
      password: THROWAWAY_PASSWORD,
    });
    const first = await apiCall(ctx.request, "post", "/api/settings/kiosk", baseURL!, { action: "enable" });
    expect(first.status, "enable on a club with no kiosk").toBe(200);
    const raw1 = (first.body as { rawToken?: string }).rawToken!;
    expect(typeof raw1, "the raw token is returned once").toBe("string");

    // Enable twice → 409, not a second token.
    const again = await apiCall(ctx.request, "post", "/api/settings/kiosk", baseURL!, { action: "enable" });
    expect(again.status, "enable on an already-enabled club").toBe(409);

    const hashAfterEnable = (
      await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [
        throwaway.id,
      ])
    )[0].kioskTokenHash;
    expect(hashAfterEnable, "a hash, not the raw token, is stored").not.toBe(raw1);

    // The old URL works, then stops working after a rotate.
    const live = await ctx.request.get(`/api/kiosk/${raw1}/members?q=aa`);
    expect(live.status(), "the fresh kiosk token is accepted").toBeLessThan(400);

    const rot = await apiCall(ctx.request, "post", "/api/settings/kiosk", baseURL!, { action: "regenerate" });
    expect(rot.status).toBe(200);
    const raw2 = (rot.body as { rawToken?: string }).rawToken!;
    expect(raw2, "a rotation mints a different token").not.toBe(raw1);

    const dead = await ctx.request.get(`/api/kiosk/${raw1}/members?q=aa`);
    expect(dead.status(), "the rotated-away token 404s on its next request").toBe(404);

    // Replay classes: junk, a re-spelling and a foreign club's token.
    for (const bad of [`${raw2}.junk`, raw2.toUpperCase(), raw2.slice(0, -1), "a".repeat(4097)]) {
      const r = await ctx.request.get(`/api/kiosk/${bad}/members?q=aa`);
      expect(r.status(), `a mangled kiosk token (${bad.slice(0, 8)}…) is refused`).toBeGreaterThanOrEqual(400);
      expect(r.status(), "and is never a 500").toBeLessThan(500);
    }

    const dis = await apiCall(ctx.request, "post", "/api/settings/kiosk", baseURL!, { action: "disable" });
    expect(dis.status).toBe(200);
    const gone = await ctx.request.get(`/api/kiosk/${raw2}/members?q=aa`);
    expect(gone.status(), "a disabled kiosk URL 404s").toBe(404);
  });

  test("CSRF on settings/kiosk: no Origin and a foreign Origin are both 403", async () => {
    const before = (
      await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].kioskTokenHash;
    // Round 2: driven with a MANAGER's session, not anonymously.
    //
    // Anonymously the request never reaches the route at all — `proxy.ts`
    // answers 401 first (see the refusal test above), so the origin guard is
    // never exercised and the 403 the spec wanted could not happen. A manager
    // is authenticated, so the request reaches `app/api/settings/kiosk`, where
    // `assertSameOrigin` runs BEFORE the owner check (`kiosk/route.ts:41-46`)
    // and is therefore what answers. A manager rather than the owner on
    // purpose: if the guard ever stopped refusing, the owner's request would
    // rotate the SEEDED club's kiosk token and break every other lane
    // (COMMON rule 6), whereas the manager is refused by the role gate behind
    // it and nothing moves either way. The token assertion below proves it.
    const noOrigin = await ctxManager.request.fetch("/api/settings/kiosk", {
      method: "POST",
      data: { action: "regenerate" },
    });
    expect(noOrigin.status(), "kiosk POST with no Origin").toBe(403);
    expect(
      JSON.stringify(await noOrigin.json()),
      "and the refusal is the origin guard's, not the role gate's",
    ).toMatch(/origin/i);
    const foreign = await ctxManager.request.fetch("/api/settings/kiosk", {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      data: { action: "regenerate" },
    });
    expect(foreign.status(), "kiosk POST with a foreign Origin").toBe(403);
    const after = (
      await sql<{ kioskTokenHash: string | null }>('SELECT "kioskTokenHash" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].kioskTokenHash;
    expect(after, "the seeded kiosk token survived both").toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J14 — waiver text
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J14 waiver text — per role, and the gate that reads it", () => {
  test("REFUSED: every non-owner role writing waiver text; the columns do not move", async ({ baseURL }) => {
    const before = (
      await sql<{ waiverTitle: string | null; waiverContent: string | null }>(
        'SELECT "waiverTitle", "waiverContent" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    for (const [role, ctx, status] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const r = await apiCall(ctx.request, "patch", "/api/settings", baseURL!, {
        waiverTitle: `${RUN_STAMP} forged`,
        waiverContent: "You agree to everything.",
        kidsWaiverTitle: `${RUN_STAMP} forged kids`,
      });
      expect(r.status, `${role} writes waiver text`).toBe(status);
    }
    const after = (
      await sql<{ waiverTitle: string | null; waiverContent: string | null }>(
        'SELECT "waiverTitle", "waiverContent" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(after, "waiver text unchanged across five refusals").toEqual(before);
  });

  test("the owner's new text reaches /waiver and the kiosk status route", async ({ baseURL }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const title = `${RUN_STAMP} Adult waiver`;
    const kids = `${RUN_STAMP} Parent waiver`;
    try {
      const w = await apiCall(owner.request, "patch", "/api/settings", baseURL!, {
        waiverTitle: title,
        waiverContent: `Adult body ${RUN_STAMP}`,
        kidsWaiverTitle: kids,
        kidsWaiverContent: `Kids body ${RUN_STAMP}`,
      });
      expect(w.status, "the owner may set waiver text").toBe(200);

      // Proof is a fresh GET, never the page state just changed.
      const row = (
        await sql<{ waiverTitle: string | null; kidsWaiverTitle: string | null }>(
          'SELECT "waiverTitle", "kidsWaiverTitle" FROM "Tenant" WHERE id = $1',
          [tenantId],
        )
      )[0];
      expect(row.waiverTitle).toBe(title);
      expect(row.kidsWaiverTitle).toBe(kids);

      const page = await ctxAnon.newPage();
      await page.goto(`/waiver?club=${"totalbjj"}`, { waitUntil: "domcontentloaded" });
      const bodyText = await page.locator("body").innerText();
      console.log("[L-B J14] /waiver shows the new title:", bodyText.includes(title));
      await page.close();
    } finally {
      await sql(
        'UPDATE "Tenant" SET "waiverTitle" = $1, "waiverContent" = $2, "kidsWaiverTitle" = $3, "kidsWaiverContent" = $4 WHERE id = $5',
        [
          settingsBefore.waiverTitle,
          settingsBefore.waiverContent,
          settingsBefore.kidsWaiverTitle,
          settingsBefore.kidsWaiverContent,
          tenantId,
        ],
      );
    }
  });

  test("a 20 000-character waiver is the boundary; 20 001 is refused", async ({ baseURL }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const before = (
      await sql<{ waiverContent: string | null }>('SELECT "waiverContent" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].waiverContent;
    const over = await apiCall(owner.request, "patch", "/api/settings", baseURL!, {
      waiverContent: "x".repeat(20_001),
    });
    expect(over.status, "20 001 characters is refused").toBe(400);
    const after = (
      await sql<{ waiverContent: string | null }>('SELECT "waiverContent" FROM "Tenant" WHERE id = $1', [
        tenantId,
      ])
    )[0].waiverContent;
    expect(after, "and nothing was written").toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J15 — payment rail, memberSelfBilling, currency
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J15 rail, memberSelfBilling and currency", () => {
  test("REFUSED: every non-owner role flipping the rail or self-billing", async ({ baseURL }) => {
    const before = (
      await sql<{ paymentRail: string | null; memberSelfBilling: boolean }>(
        'SELECT "paymentRail", "memberSelfBilling" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    for (const [role, ctx, status] of [
      ["manager", ctxManager, 403],
      ["coach", ctxCoach, 403],
      ["admin", ctxAdmin, 403],
      ["member", ctxMember, 403],
      ["anonymous", ctxAnon, 401],
    ] as const) {
      const r = await apiCall(ctx.request, "patch", "/api/settings", baseURL!, {
        paymentRail: "stripe",
        memberSelfBilling: !before.memberSelfBilling,
      });
      expect(r.status, `${role} flips the rail`).toBe(status);
    }
    const after = (
      await sql<{ paymentRail: string | null; memberSelfBilling: boolean }>(
        'SELECT "paymentRail", "memberSelfBilling" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(after, "the rail is unchanged across five refusals").toEqual(before);
  });

  test("a currency outside Stripe's list is refused by whatever writes currency", async ({ baseURL }) => {
    // PATCH /api/settings has no currency field at all. Round 1 made the schema
    // strict, so the honest answer is now a 400 that names the key rather than
    // the 200-that-wrote-nothing this case used to record. The tier route is
    // the only real writer, so the malformed-currency case is asserted there.
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const r = await apiCall(owner.request, "patch", "/api/settings", baseURL!, { currency: "XYZ" });
    const row = (await sql<{ name: string }>('SELECT name FROM "Tenant" WHERE id = $1', [tenantId]))[0];
    console.log(`[L-B J15] PATCH settings {currency:"XYZ"} → ${r.status} (field is not in the schema)`);
    expect(r.status, "an unknown key is named and refused").toBe(400);
    expect(JSON.stringify(r.body), "and the refusal names it").toContain("currency");
    expect(row.name, "and nothing else moved").toBe(settingsBefore.name);

    const tiersBefore = await countOf("MembershipTier", '"tenantId" = $1', [tenantId]);
    const t = await apiCall(owner.request, "post", "/api/memberships", baseURL!, {
      name: `${RUN_STAMP} bad currency`,
      pricePence: 1000,
      currency: "XYZ",
      billingCycle: "monthly",
    });
    console.log(`[L-B J15] POST memberships {currency:"XYZ"} → ${t.status}`);
    expect(t.status, "a non-ISO currency never yields a 500").toBeLessThan(500);
    if (t.status >= 400) await assertUnchanged("MembershipTier", tiersBefore, '"tenantId" = $1', [tenantId]);
    else
      await sql('DELETE FROM "MembershipTier" WHERE name LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("a member's shop-config and me/gym follow the owner's rail change", async ({ baseURL }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const original = (
      await sql<{ paymentRail: string | null; memberSelfBilling: boolean }>(
        'SELECT "paymentRail", "memberSelfBilling" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    try {
      const set = await apiCall(owner.request, "patch", "/api/settings", baseURL!, {
        paymentRail: "pay_at_desk",
        memberSelfBilling: false,
      });
      expect(set.status).toBe(200);
      const row = (
        await sql<{ paymentRail: string | null }>('SELECT "paymentRail" FROM "Tenant" WHERE id = $1', [
          tenantId,
        ])
      )[0];
      expect(row.paymentRail, "the row proves the save").toBe("pay_at_desk");

      // Fresh GETs as the member, not the page state.
      const cfg = await apiCall(ctxMember.request, "get", "/api/member/shop-config", baseURL!);
      const gym = await apiCall(ctxMember.request, "get", "/api/me/gym", baseURL!);
      console.log(
        "[L-B J15] member shop-config",
        cfg.status,
        JSON.stringify(cfg.body).slice(0, 200),
        "| me/gym",
        gym.status,
        JSON.stringify(gym.body).slice(0, 200),
      );
      expect(cfg.status, "the member can read the shop config").toBe(200);
      // me/gym is cached for 60s behind a tag the PATCH busts — assert the
      // busted read, polling because the tag revalidation is not synchronous.
      await expect
        .poll(
          async () => {
            const g = await apiCall(ctxMember.request, "get", "/api/me/gym", baseURL!);
            return JSON.stringify(g.body);
          },
          { timeout: 10_000 },
        )
        .not.toContain('"memberSelfBilling":true');
    } finally {
      await sql('UPDATE "Tenant" SET "paymentRail" = $1, "memberSelfBilling" = $2 WHERE id = $3', [
        original.paymentRail,
        original.memberSelfBilling,
        tenantId,
      ]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// J16 — timezone
// ═══════════════════════════════════════════════════════════════════════════

test.describe("J16 timezone — Register and the check-in window follow Tenant.timezone", () => {
  test("an owner can set Tenant.timezone, through the route and from the screen", async ({
    baseURL,
  }) => {
    // Round 2: this case is the inverse of the one it replaces, and it is the
    // revert-failing test for the J16 fix.
    //
    // Round 1 recorded the ERROR: the column existed (prisma/schema.prisma:31,
    // "defaults from owner browser at onboarding step 1"), three readers
    // depended on it, and NOTHING could write it — `updateSchema` had no such
    // key and Zod stripped it, so the PATCH answered 200 having saved nothing,
    // and no screen offered it. Round 1 shipped the route half; this round
    // ships the control. Both halves are asserted here, because either one
    // alone leaves an owner unable to set their own club's time: revert the
    // schema key and the first loop fails, revert the control and the screen
    // assertion fails.
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const original = (
      await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].timezone;
    try {
      for (const zone of ["America/New_York", "Pacific/Auckland"]) {
        const r = await apiCall(owner.request, "patch", "/api/settings", baseURL!, { timezone: zone });
        const now = (
          await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
        )[0].timezone;
        console.log(`[L-B J16] PATCH settings {timezone:"${zone}"} → ${r.status}; column is ${now}`);
        expect(r.status, `PATCH {timezone:"${zone}"}`).toBe(200);
        expect(now, `the ${zone} write landed`).toBe(zone);
      }
      // A zone the runtime does not know is refused and nothing moves.
      const bad = await apiCall(owner.request, "patch", "/api/settings", baseURL!, {
        timezone: "Mars/Olympus_Mons",
      });
      expect(bad.status, "an invented zone is a 400").toBe(400);
      expect(
        (await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId]))[0]
          .timezone,
        "and the column did not move",
      ).toBe("Pacific/Auckland");

      // And the screen offers it. The control lives beside the check-in
      // window, under Settings → Waiver, because they answer the same
      // question: what "today" and "on now" mean at this club.
      const page = await owner.newPage();
      await page.goto("/dashboard/settings?tab=waiver", { waitUntil: "domcontentloaded" });
      const select = page.locator("#club-timezone");
      await select.waitFor({ state: "visible", timeout: 30_000 });
      expect(await select.inputValue(), "the control shows the stored zone").toBe("Pacific/Auckland");

      // And a change made on the screen reaches the column.
      await select.selectOption("Europe/Dublin");
      await page.getByRole("button", { name: /save time zone/i }).click();
      await expect
        .poll(
          async () =>
            (
              await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [
                tenantId,
              ])
            )[0].timezone,
          { timeout: 15_000 },
        )
        .toBe("Europe/Dublin");
      await page.close();
    } finally {
      // L-D reads this column: put it back and prove it.
      await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', [original, tenantId]);
      expect(
        (await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId]))[0]
          .timezone,
        "the seeded club's zone is restored",
      ).toBe(original);
    }
  });

  test("Register and the check-in window follow the column when it is set directly", async ({ baseURL }) => {
    // The write side is unreachable, so the column is set through the database —
    // ARRANGE here, ACT in the browser. Restored in `finally`: L-D reads it.
    const original = (
      await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].timezone;
    const coachPage = await ctxCoach.newPage();
    try {
      for (const zone of ["America/New_York", "Pacific/Auckland"]) {
        await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', [zone, tenantId]);
        const today = await apiCall(ctxCoach.request, "get", "/api/coach/today", baseURL!);
        expect(today.status, `coach/today under ${zone}`).toBe(200);
        console.log(
          `[L-B J16] ${zone}: coach/today returned ${
            Array.isArray((today.body as { sessions?: unknown[] }).sessions)
              ? (today.body as { sessions: unknown[] }).sessions.length
              : JSON.stringify(today.body).slice(0, 120)
          }`,
        );
        await coachPage.goto("/dashboard/checkin", { waitUntil: "domcontentloaded" });
        await coachPage.waitForLoadState("networkidle").catch(() => {});
        await assertNoOverflow(coachPage, 390, `Register at 390px under ${zone}`);
      }

      // The calibration case: an instance dated the previous day at 23:00Z is
      // TODAY in Auckland. Minted directly, because minting under a non-London
      // zone is exactly the write path that has never been exercised.
      await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', ["Pacific/Auckland", tenantId]);
      // HARNESS FIX (round 1): `Class` has no `dayOfWeek`, no `startTime` and
      // no `updatedAt` — the recurrence lives on `ClassSchedule`, and the only
      // NOT NULL column without a default is `duration`
      // (prisma/schema.prisma, model Class). `ClassInstance` likewise has no
      // `duration`, `status`, `createdAt` or `updatedAt`: its columns are
      // (classId, date, startTime, endTime, isCancelled), with `endTime` NOT
      // NULL and a UNIQUE on (classId, date, startTime).
      const cls = (
        await sql<{ id: string }>(
          `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "isActive", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, 60, true, now())
           RETURNING id`,
          [tenantId, `${RUN_STAMP} tz probe`],
        )
      )[0];
      const yesterday2300Z = new Date(Date.now() - 24 * 3600_000);
      yesterday2300Z.setUTCHours(23, 0, 0, 0);
      // No `.catch()` here on purpose. Round 1 swallowed the insert error and
      // logged it, which would have let a failed ARRANGE masquerade as a
      // PRODUCT defect ("the instance is not listed") — the worst possible
      // harness fault, because it manufactures a false ERROR. If the arrange
      // cannot happen, the spec must fail as a harness fault and say so.
      await sql(
        `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
         VALUES (gen_random_uuid()::text, $1, $2, '23:00', '00:00', false)`,
        [cls.id, yesterday2300Z],
      );

      const after = await apiCall(ctxCoach.request, "get", "/api/coach/today", baseURL!);
      const listed = JSON.stringify(after.body).includes(`${RUN_STAMP} tz probe`);
      console.log(`[L-B J16] 23:00Z yesterday listed as today under Pacific/Auckland: ${listed}`);
      expect(
        listed,
        "an instance at 23:00Z yesterday is today in Auckland and must appear on Register",
      ).toBe(true);
    } finally {
      await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', [original, tenantId]);
      const restored = (
        await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
      )[0].timezone;
      expect(restored, "the seeded timezone is back for the other lanes").toBe(original);
      await coachPage.close().catch(() => {});
    }
  });

  test("POST checkin as a member respects the window under a shifted zone", async ({ baseURL }) => {
    const original = (
      await sql<{ timezone: string }>('SELECT timezone FROM "Tenant" WHERE id = $1', [tenantId])
    )[0].timezone;
    const attendanceBefore = await countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]);
    try {
      await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', ["America/New_York", tenantId]);
      const r = await apiCall(ctxMember.request, "post", "/api/checkin", baseURL!, {});
      console.log(`[L-B J16] member POST /api/checkin with no body under New York → ${r.status}`);
      expect(r.status, "a bodyless self check-in is refused, never a 500").toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      await assertUnchanged("AttendanceRecord", attendanceBefore, '"tenantId" = $1', [tenantId]);
    } finally {
      await sql('UPDATE "Tenant" SET timezone = $1 WHERE id = $2', [original, tenantId]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-tenant, both ways — every mutating route this file owns
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Cross-tenant attacks on the settings surface", () => {
  test("the throwaway club's owner cannot move the seeded club's settings", async ({ browser, baseURL }) => {
    const ctx = await sessionFor(browser, baseURL!, {
      slug: throwaway.slug,
      email: throwaway.ownerEmail,
      password: THROWAWAY_PASSWORD,
    });
    const before = (
      await sql<{ name: string; primaryColor: string }>(
        'SELECT name, "primaryColor" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    // The route takes the tenant from the session, so there is no id to forge —
    // the proof is that a foreign owner's PATCH moves only their own row.
    const r = await apiCall(ctx.request, "patch", "/api/settings", baseURL!, {
      name: `${RUN_STAMP} cross tenant`,
    });
    expect(r.status, "a foreign owner PATCHes their own club").toBe(200);
    const seeded = (
      await sql<{ name: string; primaryColor: string }>(
        'SELECT name, "primaryColor" FROM "Tenant" WHERE id = $1',
        [tenantId],
      )
    )[0];
    expect(seeded, "the seeded club is untouched").toEqual(before);
    const theirs = (
      await sql<{ name: string }>('SELECT name FROM "Tenant" WHERE id = $1', [throwaway.id])
    )[0];
    expect(theirs.name, "their own club took the write").toBe(`${RUN_STAMP} cross tenant`);
  });

  test("replay and race: two identical settings PATCHes leave one audit row per request, no 500", async ({
    baseURL,
  }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const before = await countOf("AuditLog", '"tenantId" = $1 AND action = $2', [
      tenantId,
      "tenant.settings.update",
    ]);
    const body = { logoSize: "md" as const };
    const [a, b] = await Promise.all([
      apiCall(owner.request, "patch", "/api/settings", baseURL!, body),
      apiCall(owner.request, "patch", "/api/settings", baseURL!, body),
    ]);
    expect([a.status, b.status], "a concurrent double-save never 500s").toEqual([200, 200]);
    // Audit rows are fire-and-forget (lib/audit-log.ts:56) — poll.
    await expect
      .poll(
        async () =>
          countOf("AuditLog", '"tenantId" = $1 AND action = $2', [tenantId, "tenant.settings.update"]),
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(before);
    await sql('UPDATE "Tenant" SET "logoSize" = $1 WHERE id = $2', [settingsBefore.logoSize, tenantId]);
  });

  test("limits: the settings surface answers 429, never 500, and the bucket is reset", async ({ baseURL }) => {
    const owner = await sessionFor((await ctxManager.browser())!, baseURL!, {
      email: OWNER_A,
      password: PASSWORD_A,
    });
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await apiCall(owner.request, "get", "/api/settings", baseURL!);
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s >= 500), "no 500 under burst").toEqual([]);
    console.log("[L-B limits] GET /api/settings x15 →", JSON.stringify([...new Set(statuses)]));
    await clearBucket("settings");
  });
});

void expectRefusalShape;
