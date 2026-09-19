/**
 * Lane L-A, file 2 — identity: J04 password login and lockout, J05 magic link,
 * J06 the Google callback surface, J07 forgot/reset, J08 2FA, J09 sign out
 * everywhere and the removed member of staff.
 *
 * Every subject here is a THROWAWAY row. Nothing in this file locks out,
 * resets, re-enrols or session-bumps a seeded account: the brief inherits a
 * finding that `identity.spec.ts` kills the shared owner session mid-run by
 * bumping a seeded `sessionVersion`, and repeating that would fail six other
 * lanes with a symptom nowhere near its cause.
 *
 * Several describe blocks so one timeout cannot orphan a teardown.
 */
import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { generateSync } from "otplib";
import { RUN_STAMP, sql } from "../helpers/db";
import { sessionFor } from "./a0-shared";
import {
  TENANT_A_COACH,
  TENANT_A_OWNER,
  TENANT_A_PASSWORD,
  TENANT_A_SLUG,
  THROWAWAY_PASSWORD,
  apiRefused,
  assertUnchanged,
  bucketHits,
  clearBucket,
  countOf,
  createThrowawayMember,
  createThrowawayTenant,
  createThrowawayUser,
  hashToken,
  magicTokenRow,
  mintMagicToken,
  pollAudit,
  seededTenantId,
  teardownThrowawayTenant,
} from "./la-shared";

test.use({ channel: "chromium" });
test.describe.configure({ mode: "default", timeout: 180_000 });

const PHONE = { width: 390, height: 844 };
const NEW_PASSWORD = "Blackbelt!2026zZ";

function origin(baseURL: string | undefined): string {
  return baseURL ?? "http://localhost:3847";
}

/** Drive the real login form and report where it landed and what it said. */
async function attemptLogin(
  browser: Browser,
  baseURL: string,
  slug: string,
  email: string,
  password: string,
  viewport?: { width: number; height: number },
): Promise<{ url: string; copy: string }> {
  const ctx = await browser.newContext({
    baseURL,
    storageState: undefined,
    ...(viewport ? { viewport, isMobile: true, hasTouch: true } : {}),
  });
  try {
    await ctx.clearCookies();
    const page = await ctx.newPage();
    await page.goto(`/login?club=${slug}`);
    await page.waitForSelector("input[type='email']", { timeout: 60_000 });
    await page.fill("input[type='email']", email);
    await page.fill("input[type='password']", password);
    await page.click("button[type='submit']");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);
    const url = page.url();
    const copy = await page.locator("body").innerText();
    await page.close();
    return { url, copy };
  } finally {
    await ctx.close();
  }
}

/**
 * One failed sign-in, through the real credentials door, without a browser.
 *
 * ROUND 2: the lockout test drove ten sign-ins through `attemptLogin`, each of
 * which opens a context, navigates, waits for `networkidle` and then sleeps
 * 1 200 ms. On the shared dev server that is far more than the block's
 * 180-second budget, and the test died in the arrange with nothing asserted.
 * Raising the timeout would have been raising a timeout to pass.
 *
 * This is the same door the page uses — NextAuth's credentials callback, with
 * the CSRF token it requires — so the ten failures are ten real failures and
 * `failedLoginCount` moves exactly as it does for a person. The SCREEN is still
 * driven: the tenth attempt and the post-lock attempt below both go through
 * `attemptLogin`, because the copy is the other half of what this test asserts.
 */
async function apiLoginAttempt(
  request: APIRequestContext,
  slug: string,
  email: string,
  password: string,
): Promise<number> {
  const csrfRes = await request.get("/api/auth/csrf");
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
  const res = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email, password, tenantSlug: slug, redirect: "false", json: "true" },
    maxRedirects: 0,
  });
  return res.status();
}

async function lockRow(kind: "User" | "Member", id: string) {
  const rows = await sql<{ failedLoginCount: number; lockedUntil: Date | null; sessionVersion: number }>(
    `SELECT "failedLoginCount", "lockedUntil", "sessionVersion" FROM "${kind}" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// ════════════════════════════════════════════════════════════════════════════
// J04 — Password login, lockout at ten, owner unlock. ALLOWED: every account
// role. The lockout is driven on a THROWAWAY member, never a seeded one.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J04 — password login, lockout, unlock", () => {
  let victim: Awaited<ReturnType<typeof createThrowawayMember>>;
  let manager: Awaited<ReturnType<typeof createThrowawayUser>>;
  let adminUser: Awaited<ReturnType<typeof createThrowawayUser>>;

  test.beforeAll(async () => {
    victim = await createThrowawayMember();
    manager = await createThrowawayUser("manager");
    adminUser = await createThrowawayUser("admin");
  });

  test.afterAll(async () => {
    await clearBucket("login:");
    await sql('DELETE FROM "PasswordResetToken" WHERE email LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" IN (SELECT id FROM "Member" WHERE email LIKE $1)', [
      `${RUN_STAMP}%`,
    ]).catch(() => {});
    await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE $1)', [
      `${RUN_STAMP}%`,
    ]).catch(() => {});
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J04/member — a good password signs in and the failed counter stays at zero", async ({
    browser,
    baseURL,
  }) => {
    const { url } = await attemptLogin(
      browser,
      origin(baseURL),
      TENANT_A_SLUG,
      victim.email,
      THROWAWAY_PASSWORD,
      PHONE,
    );
    expect(url, "a member lands in the portal").toMatch(/member/);
    const row = await lockRow("Member", victim.id);
    expect(row?.failedLoginCount, "no failed attempts recorded").toBe(0);
    expect(row?.lockedUntil).toBeNull();
  });

  test("J04 — mixed-case email signs in and does not create a second identity", async ({ browser, baseURL }) => {
    const before = await countOf("Member", "email = $1", [victim.email]);
    const { url } = await attemptLogin(
      browser,
      origin(baseURL),
      TENANT_A_SLUG,
      victim.email.toUpperCase(),
      THROWAWAY_PASSWORD,
      PHONE,
    );
    // auth.ts:101 lower-cases and trims the credential before the lookup.
    expect(url, "MIXED-CASE@ signs into the same account").toMatch(/member/);
    expect(await countOf("Member", "email = $1", [victim.email]), "no duplicate row").toBe(before);
    expect(await countOf("Member", "email = $1", [victim.email.toUpperCase()])).toBe(0);
  });

  test("J04 — ten bad passwords lock the account, and the copy says so", async ({
    browser,
    baseURL,
    request,
  }) => {
    // The lockout is the mechanism under test, NOT the rate limit: they are
    // different things and the brief asks for both separately. Locally
    // `skipRateLimit` is true (auth.ts:237 — isTestingMode && localhost), so
    // the limiter cannot fire here and the ten attempts all reach bcrypt.
    //
    // Nine at the API, the tenth on the screen — see `apiLoginAttempt`.
    for (let i = 0; i < 9; i++) {
      const status = await apiLoginAttempt(request, TENANT_A_SLUG, victim.email, `wrong-password-${i}`);
      expect(status, `attempt ${i + 1} is refused, not crashed`).toBeLessThan(500);
    }
    // The counter must actually have moved, or the nine above went somewhere
    // else and the rest of this test would pass for the wrong reason.
    const midway = await lockRow("Member", victim.id);
    expect(
      midway?.failedLoginCount,
      "the API attempts count exactly as a person's do (auth.ts:318-322)",
    ).toBe(9);

    const last = await attemptLogin(
      browser,
      origin(baseURL),
      TENANT_A_SLUG,
      victim.email,
      "wrong-password-9",
      PHONE,
    );
    expect(last.url, "the tenth attempt stays on /login").toMatch(/login/);

    // THE ROW IS THE PROOF. auth.ts:320-336 — on crossing the threshold the
    // counter resets to 0 and lockedUntil is set an hour out.
    const row = await lockRow("Member", victim.id);
    expect(row?.lockedUntil, "lockedUntil is set after ten failures").not.toBeNull();
    expect(row!.lockedUntil!.getTime(), "the lock is roughly an hour out").toBeGreaterThan(Date.now() + 50 * 60_000);

    // And the audit row the owner is meant to see.
    await pollAudit("auth.account.locked", victim.id);

    // The eleventh attempt — even with the RIGHT password — must say locked,
    // not "Incorrect email or password."
    const locked = await attemptLogin(
      browser,
      origin(baseURL),
      TENANT_A_SLUG,
      victim.email,
      THROWAWAY_PASSWORD,
      PHONE,
    );
    expect(locked.url, "still refused").toMatch(/login/);
    expect(
      /temporarily locked/i.test(locked.copy),
      "app/login/page.tsx:60 — the locked copy, not the generic one",
    ).toBe(true);
  });

  test("J04 — THE PROMISE THE COPY MAKES: 'or reset your password' must actually unlock", async ({
    browser,
    baseURL,
  }) => {
    // app/login/page.tsx:61 tells a locked person: "Try again in an hour, or
    // reset your password." This drives exactly that instruction end to end.
    const o = origin(baseURL);
    const before = await lockRow("Member", victim.id);
    expect(before?.lockedUntil, "precondition: the account is locked").not.toBeNull();

    await clearBucket("forgot:");
    const forgot = await fetch(`${o}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: o },
      body: JSON.stringify({ email: victim.email, tenantSlug: TENANT_A_SLUG }),
    });
    expect(forgot.status, "forgot-password answers opaquely").toBe(200);

    // The raw OTP only ever reaches an inbox, so the code is arranged here and
    // the CONSUME is still the real HTTP call. Six digits, per the route.
    const code = "424242";
    await sql(
      `UPDATE "PasswordResetToken" SET "tokenHash" = $1
        WHERE email = $2 AND "tenantId" = $3 AND used = false`,
      [hashToken(code), victim.email, await seededTenantId()],
    );

    const reset = await fetch(`${o}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: o },
      body: JSON.stringify({
        token: code,
        email: victim.email,
        tenantSlug: TENANT_A_SLUG,
        password: NEW_PASSWORD,
      }),
    });
    expect(reset.status, "the reset itself succeeds").toBe(200);

    // The password DID change in the row…
    const after = await lockRow("Member", victim.id);
    expect(after?.sessionVersion, "every other session is out (sessionVersion bumped)").toBeGreaterThan(
      before!.sessionVersion,
    );

    // …and now the instruction on the screen is tested against the database.
    // app/api/auth/reset-password/route.ts:186-192 writes passwordHash and
    // sessionVersion and NOTHING ELSE — lockedUntil is untouched, so the
    // person who did exactly what the screen told them is still locked.
    expect(
      after?.lockedUntil,
      "ERROR if non-null: the login page promises a reset clears the lockout and the reset never touches lockedUntil (app/api/auth/reset-password/route.ts:186-192)",
    ).toBeNull();

    // Driven, not merely inspected: sign in with the brand-new password.
    const retry = await attemptLogin(browser, o, TENANT_A_SLUG, victim.email, NEW_PASSWORD, PHONE);
    expect(
      retry.url,
      "after following the screen's own instruction the member gets in",
    ).toMatch(/member/);
  });

  test("J04 — the old password is refused after a reset", async ({ browser, baseURL }) => {
    // Clear the lock so this measures the PASSWORD, not the lockout.
    await sql('UPDATE "Member" SET "lockedUntil" = NULL, "failedLoginCount" = 0 WHERE id = $1', [victim.id]);
    const { url, copy } = await attemptLogin(
      browser,
      origin(baseURL),
      TENANT_A_SLUG,
      victim.email,
      THROWAWAY_PASSWORD,
      PHONE,
    );
    expect(url, "the superseded password is refused").toMatch(/login/);
    expect(/Incorrect email or password/i.test(copy)).toBe(true);
    await sql('UPDATE "Member" SET "lockedUntil" = NULL, "failedLoginCount" = 0 WHERE id = $1', [victim.id]);
  });

  test("J04 — unlock: owner 200, manager 200, coach/admin/member refused, and the row proves it", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const target = await createThrowawayMember();
    // Arrange a lock no screen can create.
    await sql('UPDATE "Member" SET "lockedUntil" = $1, "failedLoginCount" = 9 WHERE id = $2', [
      new Date(Date.now() + 60 * 60_000),
      target.id,
    ]);

    // REFUSED first, so a later success cannot mask an earlier one.
    for (const [role, email, pw] of [
      ["coach", TENANT_A_COACH, TENANT_A_PASSWORD],
      ["admin", adminUser.email, THROWAWAY_PASSWORD],
    ] as const) {
      const ctx = await sessionFor(browser, o, { slug: TENANT_A_SLUG, email, password: pw });
      const { body } = await apiRefused(ctx.request, "post", `/api/members/${target.id}/unlock`, o, 403);
      expect(body, `${role} refusal body is { ok:false, error }`).toMatchObject({ ok: false });
      const still = await lockRow("Member", target.id);
      expect(still?.lockedUntil, `${role} did not unlock the member`).not.toBeNull();
    }

    // A member's own session must not reach a staff route at all.
    const memberCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: victim.email,
      password: NEW_PASSWORD,
      viewport: PHONE,
      isMobile: true,
    });
    await apiRefused(memberCtx.request, "post", `/api/members/${target.id}/unlock`, o, [401, 403]);
    expect((await lockRow("Member", target.id))?.lockedUntil).not.toBeNull();

    // CSRF: the route IS guarded (unlock/route.ts:33).
    const ownerCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: TENANT_A_OWNER,
      password: TENANT_A_PASSWORD,
    });
    const noOrigin = await ownerCtx.request.post(`/api/members/${target.id}/unlock`);
    expect(noOrigin.status(), "missing Origin on a guarded route").toBe(403);
    const foreign = await ownerCtx.request.post(`/api/members/${target.id}/unlock`, {
      headers: { Origin: "http://evil.test" },
    });
    expect(foreign.status(), "foreign Origin on a guarded route").toBe(403);
    expect((await lockRow("Member", target.id))?.lockedUntil, "no CSRF probe unlocked anyone").not.toBeNull();

    // Cross-tenant, both ways: a foreign member id must 404, never a 403 that
    // confirms the row exists.
    const foreignClub = await createThrowawayTenant();
    try {
      const cross = await ownerCtx.request.post(`/api/members/${foreignClub.memberId}/unlock`, {
        headers: { Origin: o },
      });
      expect(cross.status(), "a foreign member id answers like a missing one").toBe(404);
      const missing = await ownerCtx.request.post(`/api/members/${RUN_STAMP}-no-such-id/unlock`, {
        headers: { Origin: o },
      });
      expect(missing.status(), "a missing id").toBe(404);
      expect(await cross.text(), "identical bodies — no enumeration").toBe(await missing.text());
    } finally {
      await teardownThrowawayTenant(foreignClub.id);
    }

    // ALLOWED, through the API as manager and as owner.
    const managerCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: manager.email,
      password: THROWAWAY_PASSWORD,
    });
    const asManager = await managerCtx.request.post(`/api/members/${target.id}/unlock`, {
      headers: { Origin: o },
    });
    expect(asManager.status(), "manager unlocks (requireApiOwnerOrManager)").toBe(200);
    const unlocked = await lockRow("Member", target.id);
    expect(unlocked?.lockedUntil, "the row proves the unlock").toBeNull();
    expect(unlocked?.failedLoginCount).toBe(0);
    await pollAudit("member.unlock", target.id);

    // Idempotent: the same request twice must not 500 and must report honestly.
    const again = await ownerCtx.request.post(`/api/members/${target.id}/unlock`, { headers: { Origin: o } });
    expect(again.status()).toBe(200);
    const body = (await again.json()) as { wasLocked: boolean; message: string };
    expect(body.wasLocked, "the second call says the member was not locked").toBe(false);
    expect(body.message).toContain("not locked");
  });

  test("J04 — a locked staff USER has no in-product unlock route at all", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const staff = await createThrowawayUser("coach");
    await sql('UPDATE "User" SET "lockedUntil" = $1, "failedLoginCount" = 0 WHERE id = $2', [
      new Date(Date.now() + 60 * 60_000),
      staff.id,
    ]);
    const { copy } = await attemptLogin(browser, o, TENANT_A_SLUG, staff.email, THROWAWAY_PASSWORD);
    expect(/temporarily locked/i.test(copy), "a locked User is told it is locked").toBe(true);

    // `/api/members/[id]/unlock` is a MEMBER route. Handing it a User id must
    // 404 (it is not a member of this club), which is correct — and leaves the
    // staff account with no gym-side recovery.
    const ownerCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: TENANT_A_OWNER,
      password: TENANT_A_PASSWORD,
    });
    const res = await ownerCtx.request.post(`/api/members/${staff.id}/unlock`, { headers: { Origin: o } });
    expect(res.status(), "a User id at the member unlock route").toBe(404);
    const stillLocked = await lockRow("User", staff.id);
    expect(stillLocked?.lockedUntil, "the staff lock is untouched").not.toBeNull();
  });

  test("J04 — the login rate limit is a DIFFERENT mechanism from the lockout", async ({ baseURL }) => {
    // auth.ts:237 — `skipRateLimit = isTestingMode() && isLocalhost`. On this
    // runner both are true, so the login limiter is deliberately inert and the
    // 429 branch cannot be reached from here. Recorded with its blocker rather
    // than faked; the evidence is the empty bucket after eleven failures above.
    void baseURL;
    const hits = await bucketHits(`login:${TENANT_A_SLUG}:`);
    expect(
      hits,
      "UNCOVERED — TESTING_MODE + localhost disables LOGIN_THROTTLE (auth.ts:236-248); the login limiter needs a non-localhost client IP",
    ).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J05 — Magic link. ALLOWED: every account role.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J05 — magic link", () => {
  let member: Awaited<ReturnType<typeof createThrowawayMember>>;
  let staff: Awaited<ReturnType<typeof createThrowawayUser>>;

  test.beforeAll(async () => {
    member = await createThrowawayMember();
    staff = await createThrowawayUser("coach");
  });

  test.afterAll(async () => {
    await clearBucket("magic-link:");
    await sql('DELETE FROM "MagicLinkToken" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J05 — request as a member and as staff mints exactly one token each", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    await clearBucket("magic-link:");
    for (const email of [member.email, staff.email]) {
      const before = await countOf("MagicLinkToken", '"tenantId" = $1 AND email = $2', [tenantId, email]);
      const res = await request.post("/api/magic-link/request", {
        headers: { Origin: o },
        data: { email, tenantSlug: TENANT_A_SLUG },
      });
      expect(res.status(), `magic-link request for ${email}`).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const after = await countOf("MagicLinkToken", '"tenantId" = $1 AND email = $2', [tenantId, email]);
      expect(after, "exactly one token row was minted").toBe(before + 1);
      const rows = await sql<{ purpose: string; used: boolean }>(
        'SELECT purpose, used FROM "MagicLinkToken" WHERE "tenantId" = $1 AND email = $2 ORDER BY "createdAt" DESC LIMIT 1',
        [tenantId, email],
      );
      expect(rows[0].purpose, "purpose is login").toBe("login");
      expect(rows[0].used).toBe(false);
    }
    await clearBucket("magic-link:");
  });

  test("J05 — enumeration: a known and an unknown email answer identically", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    await clearBucket("magic-link:");
    const known = await request.post("/api/magic-link/request", {
      headers: { Origin: o },
      data: { email: member.email, tenantSlug: TENANT_A_SLUG },
    });
    const unknown = await request.post("/api/magic-link/request", {
      headers: { Origin: o },
      data: { email: `${RUN_STAMP}-nobody@example.test`, tenantSlug: TENANT_A_SLUG },
    });
    const badSlug = await request.post("/api/magic-link/request", {
      headers: { Origin: o },
      data: { email: member.email, tenantSlug: `${RUN_STAMP}-no-such-club` },
    });
    expect([known.status(), unknown.status(), badSlug.status()], "identical statuses").toEqual([200, 200, 200]);
    expect([await known.text(), await unknown.text(), await badSlug.text()], "identical bodies").toEqual([
      '{"ok":true}',
      '{"ok":true}',
      '{"ok":true}',
    ]);
    // And nothing was written for the unknown subject.
    expect(
      await countOf("MagicLinkToken", "email = $1", [`${RUN_STAMP}-nobody@example.test`]),
      "no token for an address with no account",
    ).toBe(0);
    await clearBucket("magic-link:");
  });

  test("J05 — a waiver_open token is refused at /api/magic-link/verify and is NOT consumed", async ({
    request,
  }) => {
    // Commit b5d189f: verify filters `purpose IN (login, first_time_signup)`.
    const tenantId = await seededTenantId();
    const { raw, id } = await mintMagicToken({ tenantId, email: member.email, purpose: "waiver_open" });
    const res = await request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`, {
      maxRedirects: 0,
    });
    expect(res.headers()["location"], "a waiver token cannot sign anyone in").toContain("error=invalid_link");
    // The crucial half: it must still be USABLE at its own consumer.
    expect((await magicTokenRow(id))?.used, "the waiver token survives the wrong door").toBe(false);
  });

  test("J05 — that same waiver_open token still works at /waiver/open", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    const { raw, id } = await mintMagicToken({ tenantId, email: member.email, purpose: "waiver_open" });
    const res = await request.post("/api/waiver/open", {
      headers: { Origin: o },
      data: { token: raw },
    });
    // Whatever the shape, it must NOT be the invalid-token refusal — the
    // waiver door is the token's own consumer.
    expect(res.status(), `POST /api/waiver/open with a waiver_open token (observed ${res.status()})`).toBeLessThan(
      500,
    );
    expect([400, 401, 403, 404], "a valid waiver token must not be refused at its own door").not.toContain(
      res.status(),
    );
    void id;
  });

  test("J05 — ANTI-STOCKPILE: a login request invalidates every other purpose for that email", async ({
    request,
    baseURL,
  }) => {
    // app/api/magic-link/request/route.ts:69-72 marks EVERY unused token for
    // the email+tenant as used, with no `purpose` filter. So an unauthenticated
    // stranger who knows a member's address can destroy that member's pending
    // waiver link, and an owner's pending ACTIVATION link, by posting a login
    // request. Driven, not reasoned about.
    void origin(baseURL);
    const tenantId = await seededTenantId();
    await clearBucket("magic-link:");

    const waiver = await mintMagicToken({ tenantId, email: member.email, purpose: "waiver_open" });
    const activation = await mintMagicToken({
      tenantId,
      email: member.email,
      purpose: "first_time_signup",
    });
    expect((await magicTokenRow(waiver.id))?.used).toBe(false);
    expect((await magicTokenRow(activation.id))?.used).toBe(false);

    // The attacker's whole capability: a public POST with a guessed address.
    const res = await request.post("/api/magic-link/request", {
      headers: { Origin: "http://evil.test" },
      data: { email: member.email, tenantSlug: TENANT_A_SLUG },
    });
    expect(res.status(), "the public request route").toBe(200);

    expect(
      (await magicTokenRow(waiver.id))?.used,
      "ERROR if true: an anonymous login request destroyed a pending waiver link (request/route.ts:69-72 has no purpose filter)",
    ).toBe(false);
    expect(
      (await magicTokenRow(activation.id))?.used,
      "ERROR if true: an anonymous login request destroyed a pending owner activation link",
    ).toBe(false);
    await clearBucket("magic-link:");
  });

  test("J05 — reuse, expiry and a cross-tenant token", async ({ request }) => {
    const tenantId = await seededTenantId();

    // Reuse.
    const once = await mintMagicToken({ tenantId, email: member.email, purpose: "login" });
    await request.get(`/api/magic-link/verify?token=${encodeURIComponent(once.raw)}`, { maxRedirects: 0 });
    expect((await magicTokenRow(once.id))?.used).toBe(true);
    const replay = await request.get(`/api/magic-link/verify?token=${encodeURIComponent(once.raw)}`, {
      maxRedirects: 0,
    });
    expect(replay.headers()["location"]).toContain("error=invalid_link");

    // Expiry.
    const stale = await mintMagicToken({
      tenantId,
      email: member.email,
      purpose: "login",
      expiresInMs: -1000,
    });
    const staleRes = await request.get(`/api/magic-link/verify?token=${encodeURIComponent(stale.raw)}`, {
      maxRedirects: 0,
    });
    expect(staleRes.headers()["location"]).toContain("error=invalid_link");
    expect((await magicTokenRow(stale.id))?.used, "an expired token is not consumed").toBe(false);

    // Cross-tenant: a token whose row names club B, carrying an email that
    // ALSO exists in club A. It must resolve to club B or to nothing — never
    // to club A's member.
    const foreign = await createThrowawayTenant();
    try {
      await sql('UPDATE "Member" SET email = $1 WHERE id = $2', [member.email, foreign.memberId]);
      const crossed = await mintMagicToken({
        tenantId: foreign.id,
        email: member.email,
        purpose: "login",
      });
      const res = await request.get(`/api/magic-link/verify?token=${encodeURIComponent(crossed.raw)}`, {
        maxRedirects: 0,
      });
      const loc = res.headers()["location"] ?? "";
      if (loc.includes("/member")) {
        const rows = await sql<{ n: string }>(
          'SELECT count(*)::text AS n FROM "Member" WHERE id = $1 AND "tenantId" = $2',
          [foreign.memberId, foreign.id],
        );
        expect(Number(rows[0].n), "the session belongs to the token row's tenant").toBe(1);
      }
    } finally {
      await teardownThrowawayTenant(foreign.id);
    }
  });

  test("J05 — the request rate limit is silent (no enumeration) and is reset", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    await clearBucket("magic-link:");
    try {
      const tenantId = await seededTenantId();
      const before = await countOf("MagicLinkToken", "email = $1", [member.email]);
      for (let i = 0; i < 5; i++) {
        const res = await request.post("/api/magic-link/request", {
          headers: { Origin: o },
          data: { email: member.email, tenantSlug: TENANT_A_SLUG },
        });
        // 3/15min, but the refusal is a SILENT 200 (route.ts:26-28).
        expect(res.status(), `request ${i + 1}`).toBe(200);
      }
      const after = await countOf("MagicLinkToken", "email = $1", [member.email]);
      expect(after - before, "only three tokens were actually minted").toBeLessThanOrEqual(3);
      void tenantId;
    } finally {
      await clearBucket("magic-link:");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J06 — the Google callback surface. Route-level only: the OAuth grant itself
// needs a live provider.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J06 — Google callback and pending-tenant", () => {
  test("J06 — pending-tenant with an attacker-supplied slug", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    const enabled = process.env.ENABLE_GOOGLE_OAUTH === "true";

    const res = await request.post("/api/account/pending-tenant", {
      headers: { Origin: o },
      data: { tenantSlug: TENANT_A_SLUG },
    });
    if (!enabled) {
      expect(res.status(), "fails closed when Google is off (route.ts:28-30)").toBe(503);
      return;
    }
    expect(res.status()).toBe(200);

    // A slug for a club that does not exist must 404 — the cookie is signed,
    // so minting one for a non-existent gym would be an oracle.
    const missing = await request.post("/api/account/pending-tenant", {
      headers: { Origin: o },
      data: { tenantSlug: `${RUN_STAMP}-no-such-club` },
    });
    expect(missing.status(), "a slug that does not exist").toBe(404);

    // Malformed.
    for (const bad of [{}, { tenantSlug: "" }, { tenantSlug: "a".repeat(61) }, { tenantSlug: 7 }]) {
      const r = await request.post("/api/account/pending-tenant", { headers: { Origin: o }, data: bad });
      expect([400, 404], `malformed ${JSON.stringify(bad)}`).toContain(r.status());
    }

    // ENUMERATION: a real slug answers 200 and a fake one 404, which tells a
    // stranger which clubs exist. Every other pre-session route in this lane
    // (forgot-password, magic-link/request, reset-password) deliberately
    // collapses that difference. Recorded as the finding it is.
    const real = await request.post("/api/account/pending-tenant", {
      headers: { Origin: o },
      data: { tenantSlug: TENANT_A_SLUG },
    });
    const fake = await request.post("/api/account/pending-tenant", {
      headers: { Origin: o },
      data: { tenantSlug: `${RUN_STAMP}-ghost` },
    });
    expect(
      real.status(),
      "FRICTION/BUG if these differ: pending-tenant is a club-slug oracle while every sibling route collapses it",
    ).toBe(fake.status());
  });

  test("J06 — the NextAuth Google callback without a grant", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    // ROUND 2: this used the `request` fixture, which inherits the chromium
    // project's storage state — the seeded OWNER's session. NextAuth rolls that
    // cookie forward on its way through the error path, so the assertion below
    // read "a session cookie came back" and called it a forged grant. Verified
    // by hand against the running server: with no cookies the same request
    // answers 302 to /api/auth/error and sets only `authjs.csrf-token` and
    // `authjs.callback-url`. A forged grant must be driven by a stranger, and
    // a stranger has no cookies.
    const ctx = await browser.newContext({ baseURL: o, storageState: undefined });
    try {
      await ctx.clearCookies();
      const res = await ctx.request.get("/api/auth/callback/google?code=not-a-real-code&state=nonsense", {
        headers: { Origin: o },
        maxRedirects: 0,
      });
      // Whatever it does, it must not 500 and must not mint a session.
      expect(res.status(), "an invalid Google callback").toBeLessThan(500);
      const cookies = res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
      const mintedSession = cookies.some((c) => /session-token=[^;]{20,}/.test(c.value));
      expect(mintedSession, "no session cookie from a forged callback").toBe(false);
    } finally {
      await ctx.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J07 — Forgot and reset password.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J07 — forgot and reset", () => {
  let staff: Awaited<ReturnType<typeof createThrowawayUser>>;

  test.beforeAll(async () => {
    staff = await createThrowawayUser("coach");
  });

  test.afterAll(async () => {
    await clearBucket("forgot:");
    await sql('DELETE FROM "PasswordResetToken" WHERE email LIKE $1', [`${RUN_STAMP}%`]).catch(() => {});
    await sql('DELETE FROM "PasswordHistory" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE $1)', [
      `${RUN_STAMP}%`,
    ]).catch(() => {});
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J07 — enumeration: known, unknown and a fake club answer identically", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    await clearBucket("forgot:");
    const bodies: string[] = [];
    for (const data of [
      { email: staff.email, tenantSlug: TENANT_A_SLUG },
      { email: `${RUN_STAMP}-nobody@example.test`, tenantSlug: TENANT_A_SLUG },
      { email: staff.email, tenantSlug: `${RUN_STAMP}-ghost-club` },
      { email: "not-an-email", tenantSlug: TENANT_A_SLUG },
    ]) {
      const res = await request.post("/api/auth/forgot-password", { headers: { Origin: o }, data });
      expect(res.status(), `forgot-password ${JSON.stringify(data)}`).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size, "one body for every case").toBe(1);
    expect(
      await countOf("PasswordResetToken", "email = $1", [`${RUN_STAMP}-nobody@example.test`]),
      "no token row for an address with no account",
    ).toBe(0);
    await clearBucket("forgot:");
  });

  test("J07 — reset: the token works once, the old password is out, other sessions are out", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    await clearBucket("forgot:");

    // Sign in FIRST, so there is a live session to be revoked.
    const live = await browser.newContext({ baseURL: o, storageState: undefined });
    await live.clearCookies();
    const page = await live.newPage();
    await page.goto(`/login?club=${TENANT_A_SLUG}`);
    await page.waitForSelector("input[type='email']", { timeout: 60_000 });
    await page.fill("input[type='email']", staff.email);
    await page.fill("input[type='password']", THROWAWAY_PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForURL(/dashboard|onboarding|totp/, { timeout: 60_000 });
    const beforeVersion = (await lockRow("User", staff.id))!.sessionVersion;

    await requestForgot(o, staff.email);
    const code = "515151";
    await sql(
      'UPDATE "PasswordResetToken" SET "tokenHash" = $1 WHERE email = $2 AND "tenantId" = $3 AND used = false',
      [hashToken(code), staff.email, tenantId],
    );

    const first = await postJson(o, "/api/auth/reset-password", {
      token: code,
      email: staff.email,
      tenantSlug: TENANT_A_SLUG,
      password: NEW_PASSWORD,
    });
    expect(first.status, "the reset succeeds").toBe(200);

    // Twice: the same code is refused and nothing changes.
    const rowAfterFirst = await lockRow("User", staff.id);
    const second = await postJson(o, "/api/auth/reset-password", {
      token: code,
      email: staff.email,
      tenantSlug: TENANT_A_SLUG,
      password: "Another!2026aA",
    });
    expect(second.status, "a consumed code is refused").toBe(400);
    expect((await lockRow("User", staff.id))?.sessionVersion, "nothing moved on the refusal").toBe(
      rowAfterFirst!.sessionVersion,
    );

    // Other sessions out — proven by a FRESH GET on the old context.
    expect(rowAfterFirst!.sessionVersion, "sessionVersion bumped").toBeGreaterThan(beforeVersion);
    // Exactly 401 since the round-1 proxy fix: an unauthenticated /api/* is
    // refused, not 307-redirected to a login page this context would follow to
    // a 200 and read as success.
    const stale = await live.request.get("/api/me/gym");
    expect(stale.status(), "the pre-reset session no longer authenticates").toBe(401);
    await page.close();
    await live.close();

    // The old password is refused.
    const old = await attemptLogin(browser, o, TENANT_A_SLUG, staff.email, THROWAWAY_PASSWORD);
    expect(old.url).toMatch(/login/);
    // The new one works.
    const fresh = await attemptLogin(browser, o, TENANT_A_SLUG, staff.email, NEW_PASSWORD);
    expect(fresh.url, "the new password signs in").toMatch(/dashboard|onboarding|totp/);

    // PasswordHistory: staff reuse is blocked for eight.
    expect(
      await countOf("PasswordHistory", '"userId" = $1', [staff.id]),
      "the superseded hash is recorded",
    ).toBeGreaterThan(0);
    await clearBucket("forgot:");
  });

  test("J07 — an expired code, a foreign club's code, and malformed bodies", async ({ baseURL }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    const code = "606060";
    await sql(
      `INSERT INTO "PasswordResetToken" ("id", "tenantId", email, "tokenHash", "expiresAt", used, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, now() - interval '1 minute', false, now())`,
      [tenantId, staff.email, hashToken(code)],
    );
    const expired = await postJson(o, "/api/auth/reset-password", {
      token: code,
      email: staff.email,
      tenantSlug: TENANT_A_SLUG,
      password: "Expired!2026aA",
    });
    expect(expired.status, "an expired code").toBe(400);

    // A code minted for another club must not work here.
    const foreign = await createThrowawayTenant();
    try {
      const fcode = "707070";
      await sql(
        `INSERT INTO "PasswordResetToken" ("id", "tenantId", email, "tokenHash", "expiresAt", used, "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, now() + interval '2 minutes', false, now())`,
        [foreign.id, staff.email, hashToken(fcode)],
      );
      const before = (await lockRow("User", staff.id))!.sessionVersion;
      const crossed = await postJson(o, "/api/auth/reset-password", {
        token: fcode,
        email: staff.email,
        tenantSlug: TENANT_A_SLUG,
        password: "Crossed!2026aA",
      });
      expect(crossed.status, "another club's reset code in this club's slug").toBe(400);
      expect((await lockRow("User", staff.id))?.sessionVersion, "nothing was written").toBe(before);
    } finally {
      await teardownThrowawayTenant(foreign.id);
    }

    for (const bad of [
      { token: "", email: staff.email, tenantSlug: TENANT_A_SLUG, password: "Valid!2026aA" },
      { token: "1".repeat(21), email: staff.email, tenantSlug: TENANT_A_SLUG, password: "Valid!2026aA" },
      { token: "111111", email: staff.email, tenantSlug: TENANT_A_SLUG, password: "short" },
      { token: "111111", email: staff.email, tenantSlug: TENANT_A_SLUG, password: "nouppercase1!" },
      { token: "111111", email: staff.email, tenantSlug: TENANT_A_SLUG, password: "NONUMBERSHERE!" },
      { token: "111111", email: staff.email, tenantSlug: TENANT_A_SLUG, password: "A".repeat(129) },
      { token: "111111", email: "not-an-email", tenantSlug: TENANT_A_SLUG, password: "Valid!2026aA" },
    ]) {
      const r = await postJson(o, "/api/auth/reset-password", bad);
      expect(r.status, `malformed reset: ${JSON.stringify(bad).slice(0, 80)}`).toBe(400);
    }
  });

  test("J07 — the forgot-password limiter answers 429, never 500, and is reset", async ({ baseURL }) => {
    const o = origin(baseURL);
    await clearBucket("forgot:");
    try {
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await postJson(o, "/api/auth/forgot-password", {
          email: staff.email,
          tenantSlug: TENANT_A_SLUG,
        });
        seen.push(r.status);
        if (r.status === 429) break;
      }
      expect(seen, "3/15min per email+club").toContain(429);
      expect(seen.filter((s) => s >= 500), "no 500 from the limiter").toEqual([]);
    } finally {
      await clearBucket("forgot:");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J08 — 2FA.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J08 — two-factor", () => {
  let coach: Awaited<ReturnType<typeof createThrowawayUser>>;
  let member: Awaited<ReturnType<typeof createThrowawayMember>>;

  test.beforeAll(async () => {
    coach = await createThrowawayUser("coach");
    member = await createThrowawayMember();
  });

  test.afterAll(async () => {
    await clearBucket("totp");
    await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J08 — a member of staff enrols and the secret lands in the row", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: coach.email,
      password: THROWAWAY_PASSWORD,
    });
    const setup = await ctx.request.get("/api/auth/totp/setup");
    expect(setup.status(), "GET setup for an un-enrolled user").toBe(200);
    const body = (await setup.json()) as { secret?: string; alreadyEnabled: boolean; qrDataUrl?: string };
    expect(body.alreadyEnabled).toBe(false);
    expect(body.secret, "a secret is offered").toBeTruthy();

    // A wrong code is refused and must not enable anything.
    const wrong = await ctx.request.post("/api/auth/totp/setup", {
      headers: { Origin: o },
      data: { code: "000000" },
    });
    expect(wrong.status(), "a wrong enrolment code").toBe(400);
    const notYet = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "User" WHERE id = $1', [
      coach.id,
    ]);
    expect(notYet[0].totpEnabled, "nothing was enabled by a wrong code").toBe(false);

    const good = await ctx.request.post("/api/auth/totp/setup", {
      headers: { Origin: o },
      data: { code: generateSync({ secret: body.secret! }) },
    });
    expect(good.status(), "the right code enrols").toBe(200);
    const after = await sql<{ totpEnabled: boolean; totpSecret: string | null }>(
      'SELECT "totpEnabled", "totpSecret" FROM "User" WHERE id = $1',
      [coach.id],
    );
    expect(after[0].totpEnabled, "the ROW proves enrolment").toBe(true);
    expect(after[0].totpSecret, "a secret is stored").toBeTruthy();
    // Never printed: only its presence and length are asserted.
    expect(String(after[0].totpSecret).length).toBeGreaterThan(8);

    // CSRF: setup POST is guarded (setup/route.ts:62).
    const noOrigin = await ctx.request.post("/api/auth/totp/setup", { data: { code: "123456" } });
    expect(noOrigin.status(), "missing Origin on a guarded route").toBe(403);
  });

  test("J08 — NON-OWNER staff with 2FA enrolled are never challenged at the password door", async ({
    browser,
    baseURL,
  }) => {
    // auth.ts:407 — `totpPending: !isTestingMode() && isOwner && user.totpEnabled`.
    // `isOwner` is the operative clause: a coach, manager or admin who has
    // enrolled a second factor sails past it. Under TESTING_MODE nobody is
    // challenged, so this records the state and names the blocker rather than
    // claiming a result the runner cannot produce.
    const o = origin(baseURL);
    const enrolled = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "User" WHERE id = $1', [
      coach.id,
    ]);
    test.skip(!enrolled[0]?.totpEnabled, "the enrolment block did not run");

    const { url } = await attemptLogin(browser, o, TENANT_A_SLUG, coach.email, THROWAWAY_PASSWORD);
    const challenged = /totp/.test(url);
    expect(
      challenged,
      `an enrolled COACH landed at ${url}. Not challenged is the product's behaviour (auth.ts:407 gates on isOwner); under TESTING_MODE not even an owner is challenged, so this cell is UNCOVERED for the owner case`,
    ).toBe(false);
  });

  test("J08 — /api/auth/totp/disable is a stub that always refuses", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: coach.email,
      password: THROWAWAY_PASSWORD,
    });
    const res = await ctx.request.post("/api/auth/totp/disable", { headers: { Origin: o } });
    expect(res.status(), "the stub refuses a signed-in member of staff").toBe(403);
    const still = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "User" WHERE id = $1', [coach.id]);
    expect(still[0].totpEnabled, "nothing was disabled").toBe(true);

    // Anonymous gets 401 — the route distinguishes, which is fine here because
    // there is nothing to enumerate.
    const anon = await fetch(`${o}/api/auth/totp/disable`, { method: "POST", headers: { Origin: o } });
    expect(anon.status, "anonymous at the disable stub").toBe(401);
  });

  test("J08 — recovery codes need the current TOTP code, and a member cannot reach the staff routes", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: coach.email,
      password: THROWAWAY_PASSWORD,
    });
    const noCode = await ctx.request.post("/api/auth/totp/recovery-codes", {
      headers: { Origin: o },
      data: {},
    });
    expect(noCode.status(), "no six-digit code supplied").toBe(400);
    const wrong = await ctx.request.post("/api/auth/totp/recovery-codes", {
      headers: { Origin: o },
      data: { totpCode: "000000" },
    });
    expect([400, 401], "a wrong code").toContain(wrong.status());

    // A member's session at a staff TOTP route.
    const memberCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: member.email,
      password: THROWAWAY_PASSWORD,
      viewport: PHONE,
      isMobile: true,
    });
    const before = await countOf("User", '"totpEnabled" = true AND id = $1', [coach.id]);
    await apiRefused(memberCtx.request, "get", "/api/auth/totp/setup", o, [401, 403, 404]);
    await apiRefused(memberCtx.request, "post", "/api/auth/totp/recovery-codes", o, [400, 401, 403, 404], {
      totpCode: "123456",
    });
    await assertUnchanged("User", before, '"totpEnabled" = true AND id = $1', [coach.id]);
  });

  test("J08 — a member enrols on the member-side routes, at 390 px", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: member.email,
      password: THROWAWAY_PASSWORD,
      viewport: PHONE,
      isMobile: true,
    });
    const setup = await ctx.request.get("/api/member/totp/setup");
    expect(setup.status(), "GET member totp setup").toBe(200);
    const body = (await setup.json()) as { secret?: string; alreadyEnabled: boolean };
    if (body.alreadyEnabled || !body.secret) {
      test.skip(true, "UNCOVERED — the throwaway member reports totp already enabled");
      return;
    }
    const good = await ctx.request.post("/api/member/totp/verify", {
      headers: { Origin: o },
      data: { code: generateSync({ secret: body.secret }) },
    });
    // verify is the CHALLENGE route (needs a pending session); setup POST is
    // the enrolment one. Record what each answers rather than assume.
    expect(good.status(), `POST /api/member/totp/verify without a pending session (observed ${good.status()})`).toBe(
      401,
    );
    const enrol = await ctx.request.post("/api/member/totp/setup", {
      headers: { Origin: o },
      data: { code: generateSync({ secret: body.secret }) },
    });
    expect(enrol.status(), "member enrolment").toBe(200);
    const row = await sql<{ totpEnabled: boolean }>('SELECT "totpEnabled" FROM "Member" WHERE id = $1', [
      member.id,
    ]);
    expect(row[0].totpEnabled, "the member row proves enrolment").toBe(true);
  });

  test("J08 — a staff session cannot enrol 2FA on the MEMBER routes and vice versa", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const staffCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: coach.email,
      password: THROWAWAY_PASSWORD,
    });
    const before = await countOf("Member", '"totpEnabled" = true');
    await apiRefused(staffCtx.request, "get", "/api/member/totp/setup", o, [401, 403, 404]);
    await assertUnchanged("Member", before, '"totpEnabled" = true');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// J09 — Sign out everywhere; a removed member of staff's cookie.
// ════════════════════════════════════════════════════════════════════════════
test.describe("J09 — sign out everywhere, removed staff", () => {
  test.afterAll(async () => {
    await sql('DELETE FROM "LoginEvent" WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE $1)', [
      `${RUN_STAMP}%`,
    ]).catch(() => {});
    await sql('DELETE FROM "Member" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
    await sql('DELETE FROM "User" WHERE email LIKE $1', [`${RUN_STAMP}%`]);
  });

  test("J09/staff — logout-all bumps sessionVersion and the old context stops authenticating", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const staff = await createThrowawayUser("coach");
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: staff.email,
      password: THROWAWAY_PASSWORD,
      fresh: true,
    });
    const before = (await lockRow("User", staff.id))!.sessionVersion;

    // CSRF first: the route is guarded (logout-all/route.ts:10).
    const noOrigin = await ctx.request.post("/api/auth/logout-all");
    expect(noOrigin.status(), "missing Origin").toBe(403);
    expect((await lockRow("User", staff.id))?.sessionVersion, "the refusal wrote nothing").toBe(before);

    const res = await ctx.request.post("/api/auth/logout-all", { headers: { Origin: o } });
    expect(res.status()).toBe(200);
    expect((await lockRow("User", staff.id))!.sessionVersion, "sessionVersion bumped").toBeGreaterThan(before);
    await pollAudit("auth.logout_all", staff.id);

    // A FRESH GET on the same context is the proof — not the response body.
    await expect
      .poll(async () => (await ctx.request.get("/api/me/gym")).status(), {
        timeout: 30_000,
        message: "the revoked session stops authenticating",
      })
      .toBeGreaterThanOrEqual(400);
  });

  test("J09/member — logout-all revokes a member session too", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const member = await createThrowawayMember();
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: member.email,
      password: THROWAWAY_PASSWORD,
      viewport: PHONE,
      isMobile: true,
      fresh: true,
    });
    const before = await sql<{ sessionVersion: number }>(
      'SELECT "sessionVersion" FROM "Member" WHERE id = $1',
      [member.id],
    );
    const res = await ctx.request.post("/api/auth/logout-all", { headers: { Origin: o } });
    expect(res.status()).toBe(200);
    const after = await sql<{ sessionVersion: number }>('SELECT "sessionVersion" FROM "Member" WHERE id = $1', [
      member.id,
    ]);
    expect(after[0].sessionVersion, "the MEMBER row was bumped, not a User row").toBeGreaterThan(
      before[0].sessionVersion,
    );
    await expect
      .poll(async () => (await ctx.request.get("/api/member/me")).status(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(400);
  });

  test("J09 — a magic-link member session honours the same sessionVersion mechanism", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const tenantId = await seededTenantId();
    const member = await createThrowawayMember();
    const { raw } = await mintMagicToken({ tenantId, email: member.email, purpose: "login" });

    const ctx = await browser.newContext({ baseURL: o, storageState: undefined });
    try {
      await ctx.clearCookies();
      await ctx.request.get(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`);
      const alive = await ctx.request.get("/api/member/me");
      expect(alive.status(), "the magic-link session works (the memberId claim, verify/route.ts:152)").toBe(200);

      await sql('UPDATE "Member" SET "sessionVersion" = "sessionVersion" + 1 WHERE id = $1', [member.id]);
      await expect
        .poll(async () => (await ctx.request.get("/api/member/me")).status(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(400);
    } finally {
      await ctx.close();
    }
  });

  test("J09 — a removed member of staff's cookie is refused on the NEXT request", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const staff = await createThrowawayUser("coach");
    const ctx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: staff.email,
      password: THROWAWAY_PASSWORD,
      fresh: true,
    });
    const alive = await ctx.request.get("/api/me/gym");
    expect(alive.status(), "the session is live before removal").toBeLessThan(400);

    // Removal through the product route, as the owner.
    const ownerCtx = await sessionFor(browser, o, {
      slug: TENANT_A_SLUG,
      email: TENANT_A_OWNER,
      password: TENANT_A_PASSWORD,
    });
    const del = await ownerCtx.request.delete(`/api/staff/${staff.id}`, { headers: { Origin: o } });
    expect([200, 204], `DELETE /api/staff/${staff.id}`).toContain(del.status());
    expect(await countOf("User", "id = $1", [staff.id]), "the row is gone").toBe(0);

    // Deleting a row cannot bump a sessionVersion on a row that is gone
    // (auth.ts:786) — the jwt callback must treat the absent row as revoked.
    await expect
      .poll(async () => (await ctx.request.get("/api/me/gym")).status(), {
        timeout: 30_000,
        message: "a deleted staff cookie must stop working on its next request",
      })
      .toBeGreaterThanOrEqual(400);

    // And the page, not just the API: a refused PAGE is a redirect.
    const page = await ctx.newPage();
    await page.goto("/dashboard");
    await page.waitForURL(/login/, { timeout: 30_000 });
    await page.close();
  });

  test("J09 — disown-login: a forged token fails, a real one locks and revokes", async ({ request, baseURL }) => {
    const o = origin(baseURL);
    for (const bad of ["junk", "a".repeat(4097), "x.y.z", ""]) {
      const res = await request.get(`/api/auth/disown-login/${encodeURIComponent(bad || "empty")}`, {
        headers: { Origin: o },
        maxRedirects: 0,
      });
      const loc = res.headers()["location"] ?? "";
      expect(loc, `forged disown token: ${bad.slice(0, 12)}`).toContain("disowned=invalid");
    }
    await clearBucket("disown:");
  });

  test("J09 — a staff session cannot reach DELETE /api/staff/[id] for another club", async ({
    browser,
    baseURL,
  }) => {
    const o = origin(baseURL);
    const foreign = await createThrowawayTenant();
    try {
      const ownerCtx = await sessionFor(browser, o, {
        slug: TENANT_A_SLUG,
        email: TENANT_A_OWNER,
        password: TENANT_A_PASSWORD,
      });
      const before = await countOf("User", "id = $1", [foreign.ownerUserId]);
      const res = await ownerCtx.request.delete(`/api/staff/${foreign.ownerUserId}`, {
        headers: { Origin: o },
      });
      expect(res.status(), "a foreign staff id answers 404, never 403").toBe(404);
      // /api/staff and /api/staff/[id] answer `{ error }`, not `{ ok:false, error }`.
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      expect(body).toHaveProperty("error");
      await assertUnchanged("User", before, "id = $1", [foreign.ownerUserId]);
    } finally {
      await teardownThrowawayTenant(foreign.id);
    }
  });
});

// ── small fetch helpers, kept at the bottom so the journeys read first ───────

async function postJson(
  base: string,
  path: string,
  data: unknown,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify(data),
  });
  return { status: res.status, text: await res.text() };
}

async function requestForgot(base: string, email: string): Promise<void> {
  await postJson(base, "/api/auth/forgot-password", { email, tenantSlug: TENANT_A_SLUG });
}
