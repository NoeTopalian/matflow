import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHmac, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseEnvFile } from "dotenv";
import bcrypt from "bcryptjs";
import { encode } from "next-auth/jwt";
import {
  RUN_STAMP,
  cleanupRun,
  createMember,
  getMember,
  seededTenantId,
  setTenantStatus,
  sql,
} from "./helpers/db";

/**
 * IDENTITY + SESSION REVOCATION — through a browser.
 *
 * Four identity defects were fixed on 13 Sep (3e5ea88, 1aa6f99) and every one
 * of them was proved by a unit test against a function, not by a person who
 * could or could not get in. This file drives the actual doors.
 *
 *   V-3  lib/session-revocation.ts  — a MISSING row is a revoked session.
 *   V-5  app/api/magic-link/verify  — the JWT now carries `memberId`.
 *   Case lib/email-normalise.ts     — writes normalise to lowercase.
 *   Adm  lib/tenant-admission.ts    — all three doors ask, not just password.
 *
 * READ tests/e2e/campaign/NOTES-L4.md BEFORE CHANGING ANYTHING HERE. It records
 * every selector, the two places where this file arranges state the UI cannot
 * reach and why that is honest, and — more importantly — the things it does NOT
 * prove and the reason each one is out of reach.
 *
 * ── RUN THIS FILE ON ITS OWN WORKER ──────────────────────────────────────────
 *
 *     npx playwright test tests/e2e/campaign/identity.spec.ts --workers=1
 *
 * Two of these tests SUSPEND the shared seeded club for a few seconds. With
 * `fullyParallel: true` (playwright.config.ts) any other spec logging in during
 * that window would be refused at the door and would fail for a reason that has
 * nothing to do with it. `mode: "serial"` below stops the tests IN THIS FILE
 * racing each other; only `--workers=1` stops the rest of the suite racing them.
 *
 * Cost of `mode: "serial"`: a failure skips the tests after it. That is the
 * right trade while the suspension window exists — a green run that never
 * suspended anything would be worse than a short report.
 */

// Same budget as auth.setup.ts: a cold `next dev` compile of /login, /dashboard
// and /member/profile is measured in tens of seconds on the first hit, and
// several of these tests pay that cost in a fresh context.
/**
 * The page's own alert, excluding Next's route announcer — an empty
 * <div role="alert" id="__next-route-announcer__"> that exists on every page and
 * makes a bare getByRole("alert") a strict-mode violation everywhere.
 */
function loginAlert(page: import("@playwright/test").Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

// ── Secrets and cookie shape, mirrored from the app ──────────────────────────

/**
 * The signing secret, resolved EXACTLY as lib/auth-secret.ts resolves it
 * (NEXTAUTH_SECRET first, then AUTH_SECRET — inverting that order signs with a
 * different key than the server verifies with, which is the bug that file's own
 * header warns about).
 *
 * playwright.config.ts loads `.env.test`, which deliberately carries only the
 * test-branch DATABASE_URL and the E2E flags — no auth secret. The dev server
 * gets its secret from `.env`. So this reads `.env` too, but PARSES it into a
 * local object rather than loading it into `process.env`: `.env` also holds the
 * PRODUCTION DATABASE_URL, and this suite writes. Nothing from that file is
 * allowed anywhere near this process's environment.
 */
let cachedSecret: string | null = null;
function authSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (fromEnv) return (cachedSecret = fromEnv);

  const parsed = parseEnvFile(readFileSync(resolve(process.cwd(), ".env")));
  const fromFile = parsed.NEXTAUTH_SECRET ?? parsed.AUTH_SECRET;
  if (!fromFile) {
    throw new Error(
      "No NEXTAUTH_SECRET / AUTH_SECRET in the environment or in .env — this file " +
        "cannot mint a magic-link token or a session cookie the server will accept.",
    );
  }
  return (cachedSecret = fromFile);
}

/**
 * lib/token-hash.ts, reimplemented rather than imported.
 *
 * No spec in tests/e2e/** imports through the `@/` alias, so none of them proves
 * Playwright's transform resolves tsconfig paths, and `@/lib/token-hash` would
 * drag in `@/lib/auth-secret`'s import-time production guard as well. Six lines
 * duplicated beats a resolution failure that reads as a product bug. If
 * lib/token-hash.ts ever changes algorithm, this goes stale silently — NOTES-L4
 * records that as the cost.
 */
function hashToken(raw: string): string {
  return createHmac("sha256", authSecret()).update(raw).digest("hex");
}

/**
 * lib/auth-cookie.ts. `next dev` runs with NODE_ENV=development, so the server
 * writes and reads the non-secure name. Computed the same way the app computes
 * it so a production-mode run does not silently write a cookie nobody reads.
 */
const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

// The password every seeded account is hashed with (prisma/seed.ts) and the one
// this file hashes onto the members it creates. NOT the E2E bypass token —
// that path falls back to "first owner in the tenant" when no account matches
// the email, which would silently sign a member test in as the owner.
const PASSWORD = "password123";

// ── Fixtures this file builds ────────────────────────────────────────────────

interface SeededTenant {
  id: string;
  slug: string;
  name: string;
  primaryColor: string | null;
  secondaryColor: string | null;
  textColor: string | null;
}

async function seededTenant(): Promise<SeededTenant> {
  const rows = await sql<SeededTenant>(
    `SELECT id, slug, name, "primaryColor", "secondaryColor", "textColor"
     FROM "Tenant" WHERE slug = $1`,
    ["totalbjj"],
  );
  if (rows.length === 0) throw new Error('Seeded tenant "totalbjj" is missing — run npm run seed.');
  return rows[0];
}

/** Give a member a password they can actually type, and get them past the
 *  first-run wizard so the portal underneath is what renders. */
async function makeLoginable(memberId: string): Promise<void> {
  await sql(
    `UPDATE "Member" SET "passwordHash" = $1, "onboardingCompleted" = true WHERE id = $2`,
    [bcrypt.hashSync(PASSWORD, 10), memberId],
  );
}

/**
 * A throwaway staff row belonging to this run. Named with RUN_STAMP so the
 * afterAll sweep finds it and a human reading the table can see where it came
 * from. Role `coach`, not `owner`: the dashboard layout redirects an owner to
 * /onboarding when the tenant has not completed setup, which would turn a
 * revocation result into a routing result.
 */
async function createThrowawayStaff(): Promise<{ id: string; email: string; name: string }> {
  const tenant = await seededTenant();
  const suffix = Math.random().toString(36).slice(2, 8);
  const email = `${RUN_STAMP}-${suffix}@example.test`;
  const name = `Campaign Coach ${suffix}`;
  const rows = await sql<{ id: string }>(
    `INSERT INTO "User" ("id", "tenantId", "email", "name", "passwordHash", "role", "sessionVersion", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'coach', 0, now(), now())
     RETURNING id`,
    [tenant.id, email, name, bcrypt.hashSync(PASSWORD, 10)],
  );
  return { id: rows[0].id, email, name };
}

/**
 * Mint the session cookie for a staff row by hand, in the same shape auth.ts's
 * jwt() callback produces — with ONE deliberate omission, `sessionVersionCheckedAt`.
 *
 * That omission is the whole reason the V-3 tests below can run at all, and it
 * is not a cheat. auth.ts gates the revocation DB round-trip behind a 10-minute
 * cache stamped on that claim; a token that carries no stamp rechecks on its
 * very first request. Two real session types are in exactly this state:
 *
 *   - every magic-link session, because app/api/magic-link/verify/route.ts
 *     hand-rolls its payload and never sets the claim (read it — the field is
 *     absent from both branches of `jwtPayload`); and
 *   - every ordinary session older than ten minutes, which is all of them.
 *
 * So this reproduces a state the product reaches on its own, without waiting
 * ten minutes of wall-clock in a test run. See NOTES-L4.md for what that does
 * and does not license us to claim.
 */
async function mintStaffSessionCookie(user: { id: string; email: string; name: string }): Promise<string> {
  const tenant = await seededTenant();
  return encode({
    secret: authSecret(),
    salt: SESSION_COOKIE_NAME,
    maxAge: 30 * 24 * 60 * 60,
    token: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: "coach",
      sessionVersion: 0,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      primaryColor: tenant.primaryColor,
      secondaryColor: tenant.secondaryColor,
      textColor: tenant.textColor,
      memberId: null,
      totpPending: false,
      requireTotpSetup: false,
      // true only to keep the 2FA recommendation banner off the dashboard;
      // it is informational and gates nothing (2FA-optional spec, 2026-05-07).
      totpEnabled: true,
      // Set, so the brand-refresh round-trip does not fire and add a second
      // variable to a test about revocation.
      brandFetchedAt: Date.now(),
      // sessionVersionCheckedAt: DELIBERATELY ABSENT — see the note above.
    },
  });
}

/** A clean browser, with none of the owner storageState the `chromium` project
 *  hands every spec. Every login assertion here must start signed out. */
async function signedOutPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

/** The login screen's email step, reached through the club-code lookup exactly
 *  as tests/e2e/auth.setup.ts reaches it. */
async function openLoginForm(page: Page): Promise<void> {
  await page.goto("/login?club=totalbjj");
  // 45s, same as auth.setup.ts: the first /login hit of a run pays Turbopack's
  // on-demand compile before the ?club= lookup can even start.
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
}

async function submitLogin(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", password);
  await page.click("button[type='submit']");
}

/** The staff dashboard, identified by its sidebar rather than by any one page's
 *  copy. `.first()` because MobileNav renders the same hrefs lower in the DOM
 *  (hidden at desktop width; app/dashboard/layout.tsx renders Sidebar first). */
function dashboardNav(page: Page) {
  return page.locator('a[href="/dashboard/members"]').first();
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

test.afterAll(async () => {
  // Members (+ their children) — the shared helper.
  await cleanupRun();
  // This file's own two extras. Not wrapped in try/catch: if either fails the
  // run should say so loudly rather than quietly leaving rows on a shared
  // branch, which is the exact failure mode helpers/db.ts's header describes.
  await sql(`DELETE FROM "MagicLinkToken" WHERE "email" LIKE $1`, [`${RUN_STAMP}-%@example.test`]);
  await sql(`DELETE FROM "User" WHERE "email" LIKE $1`, [`${RUN_STAMP}-%@example.test`]);
});

// ─────────────────────────────────────────────────────────────────────────────
// TENANT ADMISSION — lib/tenant-admission.ts
// ─────────────────────────────────────────────────────────────────────────────

test("a SUSPENDED club refuses password login — the user is left at a refusal, not a dashboard", async ({
  browser,
}) => {
  const { page, close } = await signedOutPage(browser);
  let restore: (() => Promise<void>) | null = null;

  try {
    // ORDER IS LOAD-THEN-SUSPEND, AND IT IS NOT A DODGE.
    //
    // app/api/tenant/[slug]/route.ts answers 404 for a suspended club — on
    // purpose, so account state cannot be enumerated. Suspend first and
    // /login?club=totalbjj never renders the email form at all, so the password
    // door is never knocked on and auth.ts's admission check is never reached.
    // The test below that one covers that outer gate.
    //
    // This sequence is also the real one: the owner has the sign-in page open,
    // MatFlow suspends the club, and they then press Sign in.
    await openLoginForm(page);
    restore = await setTenantStatus("suspended");

    await submitLogin(page, "coach@totalbjj.com");

    // The refusal the user actually sees. This used to read "Incorrect email or
    // password." — the single message EVERY credentials failure collapsed into,
    // so a locked-out member, a rate-limited member and the owner of a suspended
    // club were all told their password was wrong and sent to reset a password
    // that was fine. Found by this spec; fixed in auth.ts (message-bearing
    // CredentialsSignin subclasses) and app/login/page.tsx (signInMessage).
    //
    // Note the locator: Next renders an always-present EMPTY
    // <div role="alert" id="__next-route-announcer__"> on every page, so a bare
    // getByRole("alert") is ambiguous app-wide.
    await expect(loginAlert(page)).toContainText("club's account is paused", {
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/\/login/);

    // And no session was minted behind the message.
    //
    // Asked of the API rather than by navigating to /dashboard. That route
    // reliably emits `Error: The destination stream closed early.` (digest
    // 755208863) when a client disconnects during its streamed render — which
    // is precisely what a Playwright redirect does — and the app's own
    // instrumentation logs it as an UNHANDLED error with a reference. Repeated
    // occurrences destabilised the dev server badly enough to fail the next
    // navigation with ERR_CONNECTION_REFUSED, which looked like a product bug
    // and was not one. Recorded as a finding; the proof does not need that page.
    // `maxRedirects: 0` is load-bearing. Unauthenticated API requests do not
    // answer 401 — proxy.ts 307s them to the LOGIN PAGE, and the Location is
    // built from NEXTAUTH_URL's origin rather than the request's own host. So
    // following the redirect leaves localhost:<test port> for localhost:3847,
    // where nothing is listening, and the failure surfaces as
    // ERR_CONNECTION_REFUSED — which reads as a crashed server and is nothing
    // of the kind. Both of those are recorded as findings.
    const probe = await page.request.get("/api/member/me", { maxRedirects: 0 });
    expect(
      [307, 302, 401, 403, 404],
      `a session was minted for a suspended club (status ${probe.status()})`,
    ).toContain(probe.status());
  } finally {
    if (restore) await restore();
    await close();
  }
});

test("a SUSPENDED club is not even lookupable — the club-code step refuses before the password step exists", async ({
  browser,
}) => {
  const { page, close } = await signedOutPage(browser);
  const restore = await setTenantStatus("suspended");

  try {
    // A fresh context matters here: /api/tenant/[slug] sends
    // `Cache-Control: public, s-maxage=60` on SUCCESS, so a context that had
    // already looked this club up could be answered from its own HTTP cache.
    // 404s are deliberately not cached, so the negative answer is always live.
    await page.goto("/login?club=totalbjj");

    // The ?club= lookup 404s, so the page never leaves step 1.
    await expect(page.getByRole("heading", { name: "Enter your club code" })).toBeVisible({
      timeout: 45_000,
    });

    // Type it by hand — same outcome, now with a message attached.
    await page.fill("input[aria-label='Club code']", "TOTALBJJ");
    await page.click("button[type='submit']");

    // lib/login-lookup.ts:40 — the 4xx branch.
    await expect(page.getByText("Club not found. Check your code and try again.")).toBeVisible({
      timeout: 30_000,
    });
    // The password form is not merely hidden, it was never rendered.
    await expect(page.locator("input[type='email']")).toHaveCount(0);
  } finally {
    await restore();
    await close();
  }
});

test("a past_due club still ADMITS — a gym behind on MatFlow's invoice is not locked out of its own members", async ({
  browser,
}) => {
  const { page, close } = await signedOutPage(browser);
  const restore = await setTenantStatus("past_due");

  try {
    await openLoginForm(page);
    await submitLogin(page, "coach@totalbjj.com");

    await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
    await expect(dashboardNav(page)).toBeVisible({ timeout: 30_000 });
    await expect(loginAlert(page)).toHaveCount(0);
  } finally {
    await restore();
    await close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL CASE — lib/email-normalise.ts
// ─────────────────────────────────────────────────────────────────────────────

test("an address TYPED in mixed case is stored lowercase, and then signs in under either spelling", async ({
  page,
  browser,
  baseURL,
}) => {
  // ARRANGE THROUGH THE APP'S OWN WRITE PATH, not through helpers/db.ts.
  //
  // This is the one place where using the SQL helper would invert the test.
  // The fix normalises on WRITE (lib/email-normalise.ts, via
  // memberCreateSchema's `emailField()`); the 13 Sep migration
  // 20260913230000_lowercase_emails was a one-off BACKFILL — no trigger, no
  // citext, no constraint. So a row inserted straight into Postgres with
  // capitals in it stays capitalised for ever, and because auth.ts now looks up
  // a lowercased address against a case-sensitive text column, that member
  // cannot sign in under ANY spelling. Asserting otherwise would be asserting a
  // bug. NOTES-L4.md carries the full reasoning, and it is the single most
  // important thing in that file.
  //
  // So: the owner adds a member and types the address with capitals, exactly as
  // a club does off a paper sign-up sheet. `page` carries the owner
  // storageState from the `chromium` project; the Origin header is what
  // lib/csrf.ts's assertSameOrigin requires and Playwright does not send by
  // default.
  const typed = `${RUN_STAMP}-MiXeD@Example.Test`;
  const name = `Mixed Case ${RUN_STAMP}`;

  const created = await page.request.post("/api/members", {
    headers: { origin: baseURL!, "content-type": "application/json" },
    data: { name, email: typed, membershipType: "Monthly" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  // THE FIX, at the layer it was made: what got stored.
  const stored = await getMember(id);
  expect(stored?.email).toBe(typed.toLowerCase());

  // A member created by staff has no password (they are invited). Give them one
  // so the credentials door is reachable — arranging a precondition, not the
  // thing under test.
  await makeLoginable(id);

  // ACT + ASSERT IN THE BROWSER. Both spellings, each in its own signed-out
  // context so neither can inherit the other's session.
  for (const spelling of [typed.toLowerCase(), typed.toUpperCase()]) {
    const { page: fresh, close } = await signedOutPage(browser);
    try {
      await openLoginForm(fresh);
      await submitLogin(fresh, spelling);
      await fresh.waitForURL(/\/member/, { timeout: 45_000 });
      expect(fresh.url(), `signing in as "${spelling}" did not land in the member portal`)
        .toContain("/member");
    } finally {
      await close();
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V-5 — app/api/magic-link/verify/route.ts mints `memberId`
// ─────────────────────────────────────────────────────────────────────────────

test("a magic-link member lands in a WORKING portal — their own name, not 'No member record for this session'", async ({
  browser,
}) => {
  const tenantId = await seededTenantId();
  const member = await createMember({ name: `Magic Link ${RUN_STAMP}` });
  await makeLoginable(member.id);

  // MINTING THE TOKEN ROW RATHER THAN DRIVING /api/magic-link/request.
  //
  // The request route stores only HMAC(raw) (lib/token-hash.ts) and hands the
  // raw value to Resend. There is no way to read it back out of the database,
  // and with RESEND_API_KEY unset the route logs the link to the DEV SERVER's
  // stdout — a process this spec does not own and cannot read.
  //
  // The honest description of what follows: the REQUEST half of magic link is
  // NOT covered here; the VERIFY half — the half V-5 broke — is covered end to
  // end, against a row written exactly as request/route.ts:73-83 writes one
  // (same hash function, same lowercased email, same 30-minute window, same
  // `purpose`). NOTES-L4.md states this as an admitted gap.
  const raw = randomBytes(32).toString("hex");
  await sql(
    `INSERT INTO "MagicLinkToken" ("id", "tenantId", "email", "tokenHash", "purpose", "expiresAt", "used", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'login', $4, false, now())`,
    [tenantId, member.email.toLowerCase(), hashToken(raw), new Date(Date.now() + 30 * 60 * 1000)],
  );

  const { page, close } = await signedOutPage(browser);
  try {
    // Consume the link the way a member does: by opening it.
    await page.goto(`/api/magic-link/verify?token=${encodeURIComponent(raw)}`);
    await page.waitForURL(/\/member\/home/, { timeout: 60_000 });

    // THE V-5 PROOF IS ON /member/profile, AND ONLY THERE.
    //
    // /member/home is NOT a proof and must not be used as one. It reads
    // /api/member/home, which answers a memberId-less session with
    // `demoHome(session.user.name)` — HTTP 200, demo data, greeting the member
    // by the name on their own token. With the V-5 bug in place that page still
    // renders and still says their name. It would pass green over the defect.
    //
    // /member/profile reads /api/member/me, which is the route that answered
    // 404 "No member record for this session". The page throws on a non-ok
    // response (app/member/profile/page.tsx:145) and swaps the identity card
    // for a retry banner. So: name present ⇒ memberId was in the JWT.
    await page.goto("/member/profile");
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({ timeout: 60_000 });

    // Their own name, rendered from /api/member/me's payload
    // (app/member/profile/page.tsx:249). `.first()` because AvatarUploader is
    // also handed the name for its initials/alt text.
    await expect(page.getByText(member.name, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    // And the failure surface is absent — an error is never an empty state
    // (UI-RULES §7), so its absence is a real signal rather than a tautology.
    await expect(page.getByText("Couldn't load your profile — tap retry.")).toHaveCount(0);
  } finally {
    await close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// V-3 — lib/session-revocation.ts: a missing row is a revoked session
//
// Two tests, one variable. Both mint the SAME token shape against a throwaway
// coach; the only difference is whether that coach's row still exists when the
// request arrives. Without the control, the second test would pass just as
// happily if the token were malformed, the secret wrong, or the cookie name
// stale — every one of which also ends at /login.
// ─────────────────────────────────────────────────────────────────────────────

test("control: a hand-minted staff session whose row is PRESENT reaches the dashboard", async ({
  browser,
  baseURL,
}) => {
  const staff = await createThrowawayStaff();
  const cookie = await mintStaffSessionCookie(staff);

  const { page, close } = await signedOutPage(browser);
  try {
    await page.context().addCookies([{ name: SESSION_COOKIE_NAME, value: cookie, url: baseURL! }]);

    await page.goto("/dashboard");
    await expect(dashboardNav(page)).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  } finally {
    await close();
  }
});

test("V-3: the same session is REFUSED once the staff row is hard-deleted", async ({
  browser,
  baseURL,
}) => {
  const staff = await createThrowawayStaff();
  const cookie = await mintStaffSessionCookie(staff);

  // The removal app/api/staff/[id]/route.ts performs: a hard delete. This is
  // precisely the case the old guard could not see — deleting a row cannot bump
  // a `sessionVersion` on a row that is gone, so the lookup returned undefined
  // and `currentVersion !== undefined` short-circuited the whole check.
  await sql(`DELETE FROM "User" WHERE id = $1`, [staff.id]);
  expect(await sql(`SELECT id FROM "User" WHERE id = $1`, [staff.id])).toHaveLength(0);

  const { page, close } = await signedOutPage(browser);
  try {
    await page.context().addCookies([{ name: SESSION_COOKIE_NAME, value: cookie, url: baseURL! }]);

    await page.goto("/dashboard");

    // The invariant that matters, asserted first and on its own: the removed
    // coach does not get a dashboard.
    await expect(dashboardNav(page)).toHaveCount(0, { timeout: 60_000 });

    // Where they land. proxy.ts runs at the edge, where the revocation check is
    // skipped (Prisma is Node-only), so the middleware waves this token through
    // and the Node-runtime layout is what kills it: jwt() returns null,
    // requireSession() finds no session, and lib/authz.ts redirects.
    //
    // If THIS assertion fails while the one above passed, revocation worked and
    // the failure surface is an error page rather than /login. That is a finding
    // about lib/authz.ts, not a false negative here — see NOTES-L4.md.
    await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  } finally {
    await close();
  }
});
