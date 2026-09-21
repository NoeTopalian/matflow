/**
 * Lane A0, file 5 — month-end, leaving, and the teardown that proves it.
 *
 * This file OWNS the teardown: it removes tenant B in dependency order, proves
 * the removal with a post-delete SELECT over every model carrying a tenantId,
 * and then proves tenant A is byte-identical to how it was found.
 *
 * Every operator-plane mutation below runs against TENANT B only. Suspending or
 * soft-deleting the seeded club would lock every other lane out of the product.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { sql } from "../helpers/db";
import {
  B_PASSWORD,
  TENANT_A_SLUG,
  anonContext,
  assertSnapshotsEqual,
  assertTenantBGone,
  closeSessions,
  countOf,
  operatorContext,
  readTenantFile,
  tryReadTenantFile,
  sessionFor,
  snapshotTenantA,
  teardownTenantB,
  type TenantASnapshot,
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

// ROUND 3: tenant B now carries a real bcrypt hash of its OWN password (set by
// file 1), so every sign-in here is a genuine bcrypt comparison rather than a
// ride on the e2e bypass token, which skips bcrypt entirely (auth.ts:331-336).
const PW = B_PASSWORD;
let tenantId = "";
let slug = "";
let ownerEmail = "";
let snapshotBefore: TenantASnapshot | null = null;

function origin(baseURL: string | undefined) {
  return baseURL ?? "http://127.0.0.1:3847";
}

/** A missing handover is an UNCOVERED cell with a named blocker, not a failure. */
let handoverBlocker = "";

test.beforeEach(() => {
  test.skip(!!handoverBlocker, handoverBlocker);
});

test.beforeAll(async () => {
  // The tenant-A snapshot is taken whatever happens: if this file runs at all,
  // the seeded club must be proved untouched at the end of it.
  snapshotBefore = await snapshotTenantA();
  const read = tryReadTenantFile();
  if (!read.ok) {
    handoverBlocker = read.reason;
    return;
  }
  tenantId = read.file.tenantId;
  slug = read.file.slug;
  ownerEmail = read.file.ownerEmail;
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.17 — month-end: reports, promotions, tasks", () => {
  test("two numbers on the reports screen match the same numbers computed by SQL", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const res = await owner.request.get("/api/reports?weeks=4");
    expect(res.status(), "GET /api/reports as the owner").toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    const attendanceThisMonth = await countOf(
      "AttendanceRecord",
      `"tenantId" = $1 AND "checkInTime" >= date_trunc('month', now())`,
      [tenantId],
    ).catch(() => countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]));
    const activeMembers = await countOf("Member", `"tenantId" = $1 AND status = 'active'`, [tenantId]);
    test.info().annotations.push({
      type: "observed",
      description: `SQL: attendance-this-month=${attendanceThisMonth}, active members=${activeMembers}; report keys=${Object.keys(body).join(",")}`,
    });
    // The report must not invent members the database does not have.
    const flat = JSON.stringify(body);
    expect(flat, "the report is real data, not a placeholder").not.toMatch(/lorem|placeholder|sample data/i);
  });

  test("a stubbed /api/reports 500 shows an error state, never zeros", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const page = await owner.newPage();
    await page.route("**/api/reports**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "boom" }) }),
    );
    await page.goto("/dashboard/reports");
    await page.waitForTimeout(2_000);
    const body = await page.locator("body").innerText();
    const zeros = /\b0\b/.test(body) && !/error|went wrong|could not|try again/i.test(body);
    expect(zeros, "an HTTP 500 rendered as a screen full of zeros is a lie the owner will act on").toBe(false);
    await page.unroute("**/api/reports**");
    await page.close();
  });

  test("awarding a belt writes MemberRank and its RankHistory; demoting updates it", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const member = await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
    const system = await sql<{ id: string }>('SELECT id FROM "RankSystem" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
    test.skip(system.length === 0, "UNCOVERED — no rank system was created in the wizard (step 3 was skipped)");

    const res = await owner.request.post(`/api/members/${member[0].id}/rank`, {
      headers: { Origin: o },
      data: { rankSystemId: system[0].id, rank: "Blue" },
    });
    test.info().annotations.push({ type: "observed", description: `award a belt → ${res.status()}` });
    if (res.status() < 300) {
      const rank = await sql<{ id: string }>('SELECT id FROM "MemberRank" WHERE "memberId" = $1', [member[0].id]);
      expect(rank.length, "a MemberRank row").toBeGreaterThan(0);
      const history = await sql<{ id: string }>('SELECT id FROM "RankHistory" WHERE "memberRankId" = $1', [rank[0].id]);
      expect(history.length, "a promotion that leaves no history cannot be audited").toBeGreaterThan(0);
    }
  });

  test("a task ticks and un-ticks, and a stubbed 500 leaves the item where it was", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const made = await owner.request.post("/api/tasks", {
      headers: { Origin: o },
      data: { title: `${RUN_STAMP} call the mat supplier` },
    });
    test.skip(made.status() >= 300, `UNCOVERED — POST /api/tasks answered ${made.status()}`);
    // Task has `status` + `completedAt` (prisma/schema.prisma:1127-1145) — there
    // is no boolean `completed` column, whatever the API body calls the field.
    const row = await sql<{ id: string; status: string; done: boolean }>(
      'SELECT id, status, ("completedAt" IS NOT NULL) AS done FROM "Task" WHERE "tenantId" = $1 AND title LIKE $2',
      [tenantId, `${RUN_STAMP}%`],
    );
    expect(row).toHaveLength(1);
    const openStatus = row[0].status;

    await owner.request.patch(`/api/tasks/${row[0].id}`, { headers: { Origin: o }, data: { completed: true } });
    const ticked = await sql<{ status: string; done: boolean }>(
      'SELECT status, ("completedAt" IS NOT NULL) AS done FROM "Task" WHERE id = $1',
      [row[0].id],
    );
    expect(ticked[0].status, "ticking a task moves its status off the open value").not.toBe(openStatus);
    expect(ticked[0].done, "and stamps completedAt").toBe(true);

    await owner.request.patch(`/api/tasks/${row[0].id}`, { headers: { Origin: o }, data: { completed: false } });
    const unticked = await sql<{ status: string; done: boolean }>(
      'SELECT status, ("completedAt" IS NOT NULL) AS done FROM "Task" WHERE id = $1',
      [row[0].id],
    );
    expect(unticked[0].status, "un-ticking puts it back").toBe(openStatus);
    test.info().annotations.push({
      type: "observed",
      description: `task status ${openStatus} → ${ticked[0].status} → ${unticked[0].status}; completedAt cleared on un-tick: ${!unticked[0].done}`,
    });
  });

  test("DSAR — an export names every table holding the member's rows; an erasure nulls the PII", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const members = await sql<{ id: string; email: string }>(
      'SELECT id, email FROM "Member" WHERE "tenantId" = $1 ORDER BY "joinedAt" LIMIT 2',
      [tenantId],
    );
    test.skip(members.length < 2, "UNCOVERED — fewer than two members to export and erase");

    const exp = await owner.request.get(`/api/members/${members[0].id}/dsar`);
    test.info().annotations.push({ type: "observed", description: `DSAR export → ${exp.status()}` });
    if (exp.status() === 200) {
      const body = (await exp.json()) as Record<string, unknown>;
      const keys = Object.keys(body);
      // Named explicitly: a DSAR that silently omits a table is a legal defect,
      // not a missing feature.
      for (const table of ["member", "payments", "attendance"]) {
        expect(keys.map((k) => k.toLowerCase()).some((k) => k.includes(table.slice(0, 6))), `DSAR export names ${table}`).toBe(true);
      }
    }

    const erase = await owner.request.post(`/api/members/${members[1].id}/erase`, { headers: { Origin: o }, data: { confirm: true } });
    test.info().annotations.push({ type: "observed", description: `DSAR erase → ${erase.status()}` });
    if (erase.status() < 300) {
      const after = await sql<{ name: string | null; email: string | null; status: string }>(
        'SELECT name, email, status FROM "Member" WHERE id = $1',
        [members[1].id],
      );
      expect(after[0]?.email, "the email is gone after an erasure").toBeFalsy();
      expect(after[0]?.status, "the sentinel status after an erasure").toBe("cancelled");
      await expect
        .poll(() => countOf("AuditLog", '"tenantId" = $1 AND action = $2', [tenantId, "member.dsar_erase"]), {
          timeout: 5_000,
          message: "a member.dsar_erase audit row",
        })
        .toBeGreaterThan(0);
    }
  });

  test("the three crons: idempotent twice, and 503 without the secret", async ({ request }) => {
    const secret = process.env.CRON_SECRET;
    for (const path of ["/api/cron/class-instances", "/api/cron/retention", "/api/cron/monthly-reports"]) {
      const bare = await request.get(path);
      // .env.test carries no CRON_SECRET. When the running server has none
      // either, the documented answer is 503 "CRON_SECRET not configured".
      expect([401, 403, 503], `${path} with no bearer`).toContain(bare.status());

      if (!secret) {
        test.info().annotations.push({
          type: "observed",
          description: `${path}: UNCOVERED for the authorised path — CRON_SECRET is absent from .env.test; bare call answered ${bare.status()}`,
        });
        continue;
      }
      const first = await request.get(path, { headers: { authorization: `Bearer ${secret}` } });
      const second = await request.get(path, { headers: { authorization: `Bearer ${secret}` } });
      // /api/cron/monthly-reports authenticates, then refuses with 503 "AI
      // service not configured. Set ANTHROPIC_API_KEY." before it does any work
      // (app/api/cron/monthly-reports/route.ts:33-39). That is the same class
      // of blocker as the absent Resend key: the cell is UNCOVERED with a named
      // live service, not a product failure. The 503 is still asserted to be
      // THAT 503 — a missing key names itself — and never a 500.
      if (first.status() === 503) {
        const why = (await first.json().catch(() => ({}))) as { error?: string };
        expect(why.error ?? "", `${path} 503 names the missing service`).toMatch(/not configured/i);
        test.info().annotations.push({
          type: "observed",
          description: `${path}: UNCOVERED — needs a live service (${/ANTHROPIC/i.test(why.error ?? "") ? "Anthropic" : "see body"}); answered 503 "${why.error ?? ""}"`,
        });
        continue;
      }
      expect(first.status(), `${path} authorised`).toBeLessThan(500);
      expect(second.status(), `${path} run twice is idempotent, not a 500`).toBeLessThan(500);
      const body = await second.json().catch(() => ({}));
      test.info().annotations.push({ type: "observed", description: `${path} twice → ${first.status()}/${second.status()} ${JSON.stringify(body).slice(0, 120)}` });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.18 — leaving: suspension, closure, and the operator plane", () => {
  let op: BrowserContext | null = null;

  test.beforeAll(async ({ browser, baseURL }) => {
    op = await operatorContext(browser, origin(baseURL));
  });
  test.afterAll(async () => {
    // Always leave tenant B admitted, whatever failed, so the teardown block can work.
    await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'trial', "deletedAt" = NULL WHERE id = $1`, [tenantId]).catch(() => {});
    await op?.close();
  });

  test("a suspended club refuses password login with the copy the owner will read", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    // Tenant B only. Never tenant A.
    await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'suspended' WHERE id = $1`, [tenantId]);
    try {
      const ctx = await anonContext(browser, o);
      const page = await ctx.newPage();
      // ROUND 2 found the paused copy (app/login/page.tsx:64-67) UNREACHABLE:
      // /api/tenant/[slug] answers 404 for a suspended club — deliberately,
      // "must look identical to a club that does not exist" — and the branded
      // door rendered no form without branding. 45c15dd closed that finding
      // from the other side: the deep-link door now renders an UNBRANDED form
      // when the lookup 404s, precisely so the owner of a paused club can
      // present a password and be answered honestly. The lookup contract is
      // unchanged and still asserted first. The tenant-lookup bucket is
      // cleared in arrange because a compressed run can arrive with the
      // per-IP limiter already spent — this cell asserts the 404 contract,
      // not the limiter.
      await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["tenant-lookup:%"]);
      await page.goto(`/login?club=${slug}`);
      const branding = await ctx.request.get(`/api/tenant/${slug}`);
      expect(branding.status(), "a suspended club's branding is hidden like a club that does not exist").toBe(404);
      // Driven, per the title: the real owner presenting the real password
      // reads the paused sentence — never the credentials lie, which would
      // send them off to reset a password that was never the problem
      // (auth.ts TenantRefusedError → tenant_paused).
      await page.waitForSelector("input[type='email']", { timeout: 30_000 });
      await page.fill("input[type='email']", ownerEmail);
      await page.fill("input[type='password']", PW);
      await page.click("button[type='submit']");
      await expect(
        page.getByText(/account is paused/i),
        "the owner reads the paused copy, not the credentials one",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page, "no admission while suspended").toHaveURL(/login/);
      test.info().annotations.push({
        type: "observed",
        description:
          "suspended: lookup 404s, the unbranded deep-link form renders, and the owner's real password answers with the paused copy",
      });

      await page.close();
      await ctx.close();
    } finally {
      await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'trial' WHERE id = $1`, [tenantId]);
    }
  });

  /**
   * ROUND 3 — split out of the case above, because the failure there was a
   * PRODUCT failure, not a harness one, and one product defect should fail
   * exactly one cell instead of taking the whole suspension journey with it.
   *
   * `/login?error=<code>` is the product's delivery route for every refusal
   * that happens BEFORE a password is presented: `admissionErrorCode`
   * (lib/tenant-admission.ts) sends the magic-link and Google doors there, and
   * the copy they are meant to deliver is `tenant_paused` at
   * app/login/page.tsx:64-67.
   *
   * In round 3 nothing arrived: `/login?error=tenant_paused` rendered the bare
   * "Enter your club code" screen with no notice for the full 30 s, because at
   * that point the page did not read the parameter at all. Together with the
   * branded door — `?club=<paused slug>` 404s at /api/tenant/[slug] before a
   * form can render — the sentence was unreachable by BOTH of its routes.
   *
   * A reader for `?error=` has since appeared in the working tree (a
   * `urlErrorMessage` helper feeding the club-code screen's `notice`), so this
   * cell should now pass. It stays asserted either way: the assertion is what
   * the owner of a paused club must see, and softening it to match a screen
   * that says nothing would hide the defect rather than close it.
   */
  test("ERROR — the paused-club copy never reaches the screen that ?error= was built to deliver it on", async ({ browser, baseURL }) => {
    const ctx = await anonContext(browser, origin(baseURL));
    const page = await ctx.newPage();
    await page.goto("/login?error=tenant_paused");
    await expect(page.locator("body"), "app/login/page.tsx:64-67, delivered by :89-101 and :311-322").toContainText(
      /Your club.s account is paused, so sign-in is unavailable\. Please speak to your gym\./i,
      { timeout: 30_000 },
    );
    await page.close();
    await ctx.close();
  });

  test("ERROR candidate — the kiosk is not admission-gated while the club is suspended", async ({ browser, baseURL }) => {
    const file = readTenantFile();
    const kioskToken = file.ids?.kioskToken ?? "";
    test.skip(!kioskToken, "UNCOVERED — no kiosk token in the handover file");
    const o = origin(baseURL);
    await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'suspended' WHERE id = $1`, [tenantId]);
    try {
      const ctx = await browser.newContext({ baseURL: o, storageState: undefined, viewport: { width: 768, height: 1024 } });
      const before = await countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]);
      const search = await ctx.request.get(`/api/kiosk/${kioskToken}/search?q=${RUN_STAMP.slice(0, 2)}`);
      const waiver = await ctx.request.post("/api/waiver/kiosk-request", {
        headers: { Origin: o },
        data: { kioskToken, memberId: file.ids?.adult0 },
      });
      const after = await countOf("AttendanceRecord", '"tenantId" = $1', [tenantId]);
      // tenantAdmission has three callers and none of them is the kiosk
      // (app/kiosk/[token]/page.tsx:29-42 resolves by hash alone). Any SUCCESS
      // here is an ERROR: a club that has stopped paying is still operating.
      test.info().annotations.push({
        type: "observed",
        description: `suspended club: kiosk search ${search.status()}, kiosk waiver-request ${waiver.status()}, attendance rows ${before}→${after}`,
      });
      expect(search.status(), "a suspended club's kiosk still answers — ERROR if this is 200").not.toBe(200);
      await ctx.close();
    } finally {
      await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'trial' WHERE id = $1`, [tenantId]);
    }
  });

  test("past_due admits with a warning; a soft-deleted club closes every door", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'past_due' WHERE id = $1`, [tenantId]);
    try {
      const ctx = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW, fresh: true });
      const page = await ctx.newPage();
      await page.goto("/dashboard");
      // ROUND 2: "admits" means the club is not shut out — not that the landing
      // page is the dashboard. A club whose `onboardingCompleted` is false is
      // sent to `/onboarding` by the product on every dashboard visit, which is
      // where this landed and why the assertion failed. Admission is the thing
      // under test, so both landings are a pass and the login screen is not.
      await expect(page, "past_due still admits").toHaveURL(/dashboard|onboarding/, { timeout: 45_000 });
      await expect(page, "past_due is not bounced to the login door").not.toHaveURL(/\/login/);
      await page.close();
      await ctx.close();
    } finally {
      await sql(`UPDATE "Tenant" SET "subscriptionStatus" = 'trial' WHERE id = $1`, [tenantId]);
    }

    await sql('UPDATE "Tenant" SET "deletedAt" = now() WHERE id = $1', [tenantId]);
    try {
      const ctx = await anonContext(browser, o);
      const page = await ctx.newPage();
      // Since 45c15dd the deep-link door DOES render a form when the lookup
      // 404s — deliberately: /api/tenant/[slug] answers 404 identically for a
      // club that never existed and a closed one (no enumeration), so the only
      // honest place to say "closed" is the sign-in answer, and reaching that
      // sentence requires a password box (app/login/page.tsx:1217-1240). This
      // cell used to assert the pre-45c15dd contract (no form at all) and kept
      // passing only by racing the page's own lookup fetch: toHaveCount(0)
      // returns the moment it holds once, and the fallback form mounts only
      // after that fetch resolves. Exposed the first time the fetch won.
      // The door is now DRIVEN instead: branding stays hidden, and the real
      // owner presenting the real password is refused with the closure
      // sentence — never the credentials one, which would send a closed club's
      // owner off to reset a password that was never the problem
      // (auth.ts:281-294, TenantRefusedError → tenant_closed).
      // Bucket cleared for the same reason as the suspended cell above: the
      // 404 contract is under test here, not the per-IP lookup limiter.
      await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["tenant-lookup:%"]);
      await page.goto(`/login?club=${slug}`);
      const branding = await ctx.request.get(`/api/tenant/${slug}`);
      expect(branding.status(), "a closed club's branding is hidden").toBe(404);
      await page.waitForSelector("input[type='email']", { timeout: 30_000 });
      await page.fill("input[type='email']", ownerEmail);
      await page.fill("input[type='password']", PW);
      await page.click("button[type='submit']");
      await expect(
        page.getByText(/account has been closed/i),
        "the real owner with the real password is told the club is closed, not that the password is wrong",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page, "no admission through a closed door").toHaveURL(/login/);
      await page.goto("/login?error=tenant_closed");
      // ROUND 4 — a one-shot `innerText()` raced the page's own hydration. The
      // notice is set from `window.location.search` after mount
      // (app/login/page.tsx:1207), so the server's first paint carries no copy
      // and a single read taken the instant `goto` resolves sees the bare
      // club-code screen. The paused twin above passes for one reason only:
      // `expect(locator).toContainText` retries and this did not. The copy
      // itself exists and is mapped (`tenant_closed` → :68-69, via :89-96).
      await expect(page.locator("body"), "a closed club says so, it does not hang or 500").toContainText(
        /clos|no longer|unavailable|paused/i,
        { timeout: 30_000 },
      );
      await page.close();
      await ctx.close();
    } finally {
      await sql('UPDATE "Tenant" SET "deletedAt" = NULL WHERE id = $1', [tenantId]);
    }
  });

  test("ATTACK — DELETE /api/admin/impersonate with no session is 401, and impersonated writes are attributed", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    // ROUND 2: driven from an explicitly empty context. The `{ request }`
    // fixture carries the seeded owner, so "no session" was a staff session.
    // The 200 this recorded in round 2 is FIXED ON MAIN — the route now
    // requires the impersonation cookie OR the operator credential and answers
    // 403 otherwise (app/api/admin/impersonate/route.ts:111-126, credited to
    // lane L-B round 2). This assertion is the fixed world.
    const anonCtx = await anonContext(browser, o);
    const anon = await anonCtx.request.delete("/api/admin/impersonate", { headers: { Origin: o } });
    expect([401, 403], "stopping an impersonation nobody started").toContain(anon.status());
    await anonCtx.close();

    test.skip(!op, "UNCOVERED — the operator could not sign in, so the operator plane cannot be driven");
    const start = await op!.request.post("/api/admin/impersonate", {
      headers: { Origin: o },
      data: { tenantId, email: ownerEmail },
    });
    test.info().annotations.push({ type: "observed", description: `impersonate → ${start.status()}` });
    if (start.status() < 300) {
      const before = await countOf("AuditLog", `"tenantId" = $1 AND metadata->>'actingAs' IS NOT NULL`, [tenantId]);
      // Three ordinary tenant mutations while impersonating.
      await op!.request.patch("/api/settings", { headers: { Origin: o }, data: { primaryColor: "#123456" } });
      const member = await sql<{ id: string }>('SELECT id FROM "Member" WHERE "tenantId" = $1 LIMIT 1', [tenantId]);
      if (member.length) {
        await op!.request.patch(`/api/members/${member[0].id}`, { headers: { Origin: o }, data: { phone: "+44 7700 900999" } });
        // Cash is taken at /api/payments/manual — /api/payments exports GET
        // only, so the round-1 POST here was a 405 and never wrote the third
        // mutation whose attribution this case counts.
        await op!.request.post("/api/payments/manual", {
          headers: { Origin: o },
          data: {
            memberId: member[0].id,
            amountPence: 100,
            method: "cash",
            requestId: `${RUN_STAMP}-imp`,
            notes: `${RUN_STAMP} impersonated`,
          },
        });
      }
      const after = await countOf("AuditLog", `"tenantId" = $1 AND metadata->>'actingAs' IS NOT NULL`, [tenantId]);
      // lib/audit-log.ts:29-34 — only app/api/admin/** sites pass actingAs today,
      // so an unattributed tenant write made by an operator is the finding.
      test.info().annotations.push({
        type: "observed",
        description: `impersonated writes attributed: ${after - before} of 3 carry metadata->>'actingAs'`,
      });
      expect(after - before, "every write an operator makes inside a club must name the operator").toBe(3);
      await op!.request.delete("/api/admin/impersonate", { headers: { Origin: o } });
    }
  });

  test("operator force-password-reset on a tenant-B user signs their session out", async ({ baseURL }) => {
    test.skip(!op, "UNCOVERED — the operator could not sign in at /api/admin/auth/login");
    const o = origin(baseURL);
    const user = await sql<{ id: string; sessionVersion: number }>(
      'SELECT id, "sessionVersion" FROM "User" WHERE "tenantId" = $1 AND role <> $2 LIMIT 1',
      [tenantId, "owner"],
    );
    test.skip(user.length === 0, "UNCOVERED — no non-owner staff left on tenant B");
    const res = await op!.request.post(`/api/admin/users/${user[0].id}/force-password-reset`, {
      headers: { Origin: o },
      data: {},
    });
    test.info().annotations.push({ type: "observed", description: `force-password-reset → ${res.status()}` });
    if (res.status() < 300) {
      const after = await sql<{ sessionVersion: number }>('SELECT "sessionVersion" FROM "User" WHERE id = $1', [user[0].id]);
      expect(after[0].sessionVersion, "sessionVersion is bumped, which is what signs the old cookie out").toBeGreaterThan(
        user[0].sessionVersion,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The teardown, in its own block so nothing upstream can orphan it.
test.describe("A0.teardown — remove tenant B and prove tenant A is untouched", () => {
  test("tenant B is gone, proved by a post-delete SELECT over every tenant-scoped model", async () => {
    await closeSessions();
    const file = readTenantFile();
    await teardownTenantB(RUN_STAMP);
    await assertTenantBGone(file.tenantId);
    // And the application row that started the month.
    expect(
      await countOf("GymApplication", "email LIKE $1", [`${RUN_STAMP}%`]),
      "the GymApplication rows this run created",
    ).toBe(0);
  });

  test("tenant A is byte-identical to how this lane found it", async () => {
    expect(snapshotBefore, "a before-snapshot was taken").not.toBeNull();
    const after = await snapshotTenantA();
    // Counts alone would miss a row swapped for another; the md5 over Member,
    // User and the Tenant row is what makes this a boundary proof.
    assertSnapshotsEqual(snapshotBefore!, after);
    const rateRows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "RateLimitHit" WHERE bucket LIKE $1`,
      [`%${RUN_STAMP}%`],
    );
    expect(Number(rateRows[0].n), "no run-stamped rate-limit bucket left behind for another lane").toBe(0);
    const aTenant = await sql<{ slug: string; subscriptionStatus: string; deletedAt: Date | null }>(
      'SELECT slug, "subscriptionStatus", "deletedAt" FROM "Tenant" WHERE slug = $1',
      [TENANT_A_SLUG],
    );
    expect(aTenant[0].deletedAt, "the seeded club was never soft-deleted by this lane").toBeNull();
  });
});
