/**
 * E2E — 2FA-optional spec (2026-05-07): owner DEFER path.
 *
 * Proves the mandatory-enrolment gate is gone:
 *   1. An unenrolled owner signs in and reaches /dashboard directly — NOT
 *      redirected to /login/totp/setup (the removed gate).
 *   2. The dashboard renders the recommendation banner while totpEnabled=false.
 *   3. The owner can later enrol from the deferred state; once enrolled the
 *      banner clears and totpEnabled flips true on the session.
 *
 * API-driven, mirroring tests/e2e/auth/totp-enrolment-flow.spec.ts. Requires a
 * running dev server (playwright.config webServer) + seeded Total BJJ tenant.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

const TENANT_SLUG = "totalbjj";
const OWNER_EMAIL = "owner@totalbjj.com";
const OWNER_PASSWORD = "password123";
// POST /api/auth/totp/setup enforces assertSameOrigin (CSRF defence on the
// account-takeover-adjacent enrol endpoint). The Playwright API context sends
// no Origin by default, so we set one matching the base URL.
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

async function resetOwnerTotp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.user.updateMany({
      where: { email: OWNER_EMAIL },
      data: { totpEnabled: false, totpSecret: null, totpRecoveryCodes: [], sessionVersion: { increment: 1 } },
    });
    // POST /api/auth/totp/setup allows 5 verifies per 10 min per user, counted
    // in the shared, persistent RateLimitHit table that is never reset between
    // runs. One enrolment per run is well inside that, but back-to-back full
    // runs plus local re-runs accumulate and the 6th returns 429 — a failure
    // with no bearing on the defer behaviour under test. Sibling auth specs
    // (member-password-reset, member-account-unlock) already clear their own
    // buckets; this spec was the omission. RateLimitHit has no RLS.
    const user = await prisma.user.findFirst({ where: { email: OWNER_EMAIL }, select: { id: true } });
    if (user) {
      await prisma.rateLimitHit.deleteMany({
        where: { bucket: { in: [`totp-setup-verify:${user.id}`, `login:ip:::1`, `login:ip:127.0.0.1`, `login:ip:unknown`, `login:${TENANT_SLUG}:${OWNER_EMAIL}`] } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

// A TOTP code is only valid for its own 30-second step. Between minting one
// here and the server validating it there is an HTTP round trip handled by a
// loaded `next dev` against a remote Neon branch (session lookup, rate-limit
// check, then the verify transaction — several hundred ms each). A code minted
// near the end of a step can therefore expire in flight, which the route
// reports as an invalid code: `verify failed: 400`, with nothing wrong in the
// app. Starting every code at the top of a fresh step removes the boundary.
async function awaitFreshTotpStep() {
  const STEP_MS = 30_000;
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining < 15_000) await new Promise((r) => setTimeout(r, remaining + 250));
}

async function signIn(request: APIRequestContext) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: OWNER_EMAIL, password: OWNER_PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
  expect(res.status(), `login failed: ${res.status()}`).toBeLessThan(400);
}

// Storage-audit hardening (2026-08-16): this spec mutates auth state (TOTP /
// lockout / tokens) through a direct Prisma client on the ambient DATABASE_URL.
// Refuse to run against the prod Neon branch — same guard as ui-audit-staff.
test.beforeAll(() => {
  if ((process.env.DATABASE_URL ?? "").includes("ep-bold-wave")) {
    throw new Error(
      "Refusing to run: DATABASE_URL points at the PROD Neon branch (ep-bold-wave). Use the .env.test branch.",
    );
  }
});

// Serial: beforeEach nulls totpSecret, and `fullyParallel: true` otherwise
// dispatches this file's two tests to different workers, where the reset lands
// between the other test's GET setup and its POST verify (`verify failed: 400`).
// The fresh-step wait above can add up to ~15s before a code is minted, on
// top of a sign-in and two API round trips against a loaded `next dev` and a
// remote Neon branch. Playwright's 30s default leaves no room for that.
test.describe.configure({ timeout: 90_000 });

test.describe.serial("2FA-optional — owner defer flow", () => {
  test.beforeEach(async () => {
    await resetOwnerTotp();
  });

  test("unenrolled owner reaches /dashboard with the recommend banner (no setup redirect)", async ({ page, request }) => {
    await signIn(request);
    // Share the API auth cookies with the browser context.
    const cookies = await request.storageState();
    await page.context().addCookies(cookies.cookies);

    const resp = await page.goto("/dashboard");
    // The removed gate would have 3xx-redirected to /login/totp/setup.
    expect(page.url()).toContain("/dashboard");
    expect(page.url()).not.toContain("/login/totp/setup");
    expect(resp?.status() ?? 200).toBeLessThan(400);

    await expect(page.getByText(/two-factor authentication is recommended/i)).toBeVisible();
  });

  test("owner can enrol from the deferred state and the banner clears", async ({ request }) => {
    await signIn(request);

    const setup = await request.get("/api/auth/totp/setup");
    expect(setup.ok()).toBe(true);
    const { secret, alreadyEnabled } = (await setup.json()) as { secret: string; alreadyEnabled: boolean };
    expect(alreadyEnabled).toBe(false);

    await awaitFreshTotpStep();
    const verify = await request.post("/api/auth/totp/setup", {
      data: { code: generateSync({ secret }) },
      headers: { Origin: BASE },
    });
    expect(verify.status(), `verify failed: ${verify.status()}`).toBe(200);

    const session = await (await request.get("/api/auth/session")).json();
    expect(session?.user?.email).toBe(OWNER_EMAIL);
    expect(session?.user?.totpEnabled).toBe(true); // banner condition is now false → banner gone
  });
});
