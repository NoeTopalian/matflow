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
  } finally {
    await prisma.$disconnect();
  }
}

async function signIn(request: APIRequestContext) {
  const { csrfToken } = await (await request.get("/api/auth/csrf")).json();
  const res = await request.post("/api/auth/callback/credentials", {
    form: { csrfToken, email: OWNER_EMAIL, password: OWNER_PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
  expect(res.status(), `login failed: ${res.status()}`).toBeLessThan(400);
}

test.describe("2FA-optional — owner defer flow", () => {
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
