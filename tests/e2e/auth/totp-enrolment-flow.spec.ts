/**
 * E2E test for the full TOTP enrolment flow that broke in production.
 *
 * Drives the API path noe was stuck in:
 *   1. Sign in (credentials)
 *   2. GET /api/auth/totp/setup → returns secret
 *   3. Generate valid 6-digit TOTP code via otplib
 *   4. POST /api/auth/totp/setup → sets totpEnabled=true and re-encodes JWT
 *   5. Inspect Set-Cookie header — must use the v5 name
 *      (`authjs.session-token`), NOT the legacy v4 name
 *   6. Confirm a follow-up authenticated call (e.g. /api/dashboard or
 *      /api/auth/session) succeeds with the new cookie
 *
 * This is the test that would have caught the noe-locked-out incident
 * before deploy. Static guard lives in tests/unit/auth-cookie-name.test.ts.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "node:fs";
import path from "node:path";

// Load DATABASE_URL from .env (no dotenv dep).
function loadEnv() {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

const TENANT_SLUG = "totalbjj";
// Own staff row, NOT the owner. What this spec proves — the enrolment mechanics
// and the v5 session-cookie name — is role-agnostic, and every assertion below
// is made against this constant. owner@totalbjj.com is left to
// owner-defer-totp.spec.ts, which genuinely needs the owner (dashboard access
// plus the owner recommendation banner).
//
// Why it matters: both specs reset TOTP in beforeEach and then call
// GET /api/auth/totp/setup, which ROTATES totpSecret on the row. Sharing the
// owner meant either file's GET could invalidate the other's in-flight code
// between its GET and its POST — surfacing as `verify failed: 400` at
// --workers=2, since separate files run concurrently however each is ordered.
const STAFF_EMAIL = "admin@totalbjj.com";
const STAFF_PASSWORD = "password123";
// POST /api/auth/totp/setup enforces assertSameOrigin (CSRF defence). The
// Playwright API context sends no Origin header by default, so set one.
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";

async function resetOwnerTotp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.user.updateMany({
      where: { email: STAFF_EMAIL },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: [],
        sessionVersion: { increment: 1 },
      },
    });
    // POST /api/auth/totp/setup allows 5 verifies per 10 min per user, counted
    // in the shared, persistent RateLimitHit table that is never reset between
    // runs. Back-to-back full runs plus local re-runs accumulate past it and the
    // 6th returns 429 — nothing to do with the cookie-name regression this spec
    // exists to catch. Sibling auth specs already clear their own buckets;
    // this spec was the omission. RateLimitHit has no RLS.
    const user = await prisma.user.findFirst({ where: { email: STAFF_EMAIL }, select: { id: true } });
    if (user) {
      await prisma.rateLimitHit.deleteMany({
        where: { bucket: { in: [`totp-setup-verify:${user.id}`, `login:ip:::1`, `login:ip:127.0.0.1`, `login:ip:unknown`, `login:${TENANT_SLUG}:${STAFF_EMAIL}`] } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

// A TOTP code is only valid for its own 30-second step, and between minting one
// here and the server validating it there is an HTTP round trip handled by a
// loaded `next dev` against a remote Neon branch. A code minted near the end of
// a step can expire in flight, which the route reports as an invalid code
// (HTTP 400) with nothing wrong in the app. Start every code at a fresh step.
async function awaitFreshTotpStep() {
  const STEP_MS = 30_000;
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining < 15_000) await new Promise((r) => setTimeout(r, remaining + 250));
}

async function signIn(request: APIRequestContext) {
  const csrfRes = await request.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const loginRes = await request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email: STAFF_EMAIL,
      password: STAFF_PASSWORD,
      tenantSlug: TENANT_SLUG,
      json: "true",
    },
    maxRedirects: 0,
  });
  expect(
    loginRes.status(),
    `login failed: ${loginRes.status()} body=${(await loginRes.text()).slice(0, 200)}`,
  ).toBeLessThan(400);
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
// dispatches this file's tests to different workers, where one test's reset
// lands between another's GET setup and its POST verify.
// The fresh-step wait above can add up to ~15s before a code is minted, on
// top of a sign-in and two API round trips against a loaded `next dev` and a
// remote Neon branch. Playwright's 30s default leaves no room for that.
test.describe.configure({ timeout: 90_000 });

test.describe.serial("TOTP enrolment full-flow regression", () => {
  test.beforeEach(async () => {
    await resetOwnerTotp();
  });

  test("verify endpoint sets v5-named session cookie and the body shape is correct", async ({
    request,
  }) => {
    await signIn(request);

    // Step 1: GET secret + QR.
    const setupRes = await request.get("/api/auth/totp/setup");
    expect(setupRes.ok()).toBe(true);
    const setupBody = (await setupRes.json()) as {
      secret: string;
      qrDataUrl: string;
      alreadyEnabled: boolean;
    };
    expect(setupBody.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(setupBody.alreadyEnabled).toBe(false);

    // Step 2: compute the current 6-digit code, at the top of a fresh step.
    await awaitFreshTotpStep();
    const code = generateSync({ secret: setupBody.secret });
    expect(code).toMatch(/^\d{6}$/);

    // Step 3: POST verify.
    const verifyRes = await request.post("/api/auth/totp/setup", {
      data: { code },
      headers: { Origin: BASE },
    });
    expect(
      verifyRes.status(),
      `verify failed: ${verifyRes.status()} body=${(await verifyRes.text()).slice(0, 200)}`,
    ).toBe(200);

    // Step 4: assert Set-Cookie uses v5 name. The header may be a single
    // string or a string[] depending on Node/undici version.
    const headers = verifyRes.headers();
    const rawSetCookie = (headers["set-cookie"] ?? "") as string;
    expect(
      rawSetCookie,
      `no Set-Cookie header on verify response. Headers: ${Object.keys(headers).join(", ")}`,
    ).not.toBe("");

    // Must contain v5 name.
    expect(rawSetCookie).toMatch(/(__Secure-)?authjs\.session-token=/);
    // Must NOT contain v4 name.
    expect(rawSetCookie).not.toContain("__Secure-next-auth.session-token=");
    expect(rawSetCookie).not.toMatch(/(?<![\w.-])next-auth\.session-token=/);

    // Step 5: a follow-up /api/auth/session call must reflect the new
    // session state — requireTotpSetup is now false on the JWT.
    const sessionRes = await request.get("/api/auth/session");
    expect(sessionRes.ok()).toBe(true);
    const session = await sessionRes.json();
    expect(session?.user?.email).toBe(STAFF_EMAIL);
    // Either requireTotpSetup is undefined (no longer present) or false.
    if (typeof session?.user?.requireTotpSetup !== "undefined") {
      expect(session.user.requireTotpSetup).toBe(false);
    }
  });
});
