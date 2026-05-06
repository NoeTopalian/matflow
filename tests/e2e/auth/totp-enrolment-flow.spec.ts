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
const OWNER_EMAIL = "owner@totalbjj.com";
const OWNER_PASSWORD = "password123";

async function resetOwnerTotp() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.user.updateMany({
      where: { email: OWNER_EMAIL },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: [],
        sessionVersion: { increment: 1 },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function signIn(request: APIRequestContext) {
  const csrfRes = await request.get("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const loginRes = await request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken,
      email: OWNER_EMAIL,
      password: OWNER_PASSWORD,
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

test.describe("TOTP enrolment full-flow regression", () => {
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

    // Step 2: compute the current 6-digit code.
    const code = generateSync({ secret: setupBody.secret });
    expect(code).toMatch(/^\d{6}$/);

    // Step 3: POST verify.
    const verifyRes = await request.post("/api/auth/totp/setup", {
      data: { code },
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
    expect(session?.user?.email).toBe(OWNER_EMAIL);
    // Either requireTotpSetup is undefined (no longer present) or false.
    if (typeof session?.user?.requireTotpSetup !== "undefined") {
      expect(session.user.requireTotpSetup).toBe(false);
    }
  });
});
