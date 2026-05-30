#!/usr/bin/env node
/**
 * Pure-API admin login for matflow.studio (no browser, no session polls).
 *
 * Avoids the bug where /api/auth/session polls re-mint the JWT and clear
 * totpPending between the proxy redirect (which set totpPending=true) and
 * the verify endpoint reading the cookie. We do everything in one tight
 * sequence with the same fetch context, so no auto-refresh fires.
 *
 * Steps:
 *   1. GET /api/auth/csrf
 *   2. POST /api/auth/callback/credentials — gets us the v5 cookie with
 *      totpPending=true
 *   3. Compute the current 6-digit TOTP code from the secret we read
 *      from the prod DB (passed via --secret=...)
 *   4. POST /api/auth/totp/verify with the code — gets us the
 *      totpPending=false cookie
 *   5. GET /dashboard — assert 200 (or follow redirect to confirm
 *      authenticated access)
 *
 * Usage:
 *   node scripts/prod-admin-login-direct.mjs --secret="UUDKOA..."
 */
import { chromium } from "@playwright/test";
import { generateSync } from "otplib";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://matflow.studio";
const TENANT_SLUG = "totalbjj";
const EMAIL = "owner@totalbjj.com";
const PASSWORD = process.env.MATFLOW_PROD_PASSWORD;
if (!PASSWORD) {
  console.error("MATFLOW_PROD_PASSWORD env var required (audit C-1: the previous hardcoded value targeted production).");
  process.exit(1);
}

const arg = (name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
};

const secret = arg("secret");
if (!secret) { console.error("missing --secret=<base32>"); process.exit(2); }

function log(line) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`); }

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const request = context.request;

try {
  log("step 1: GET /api/auth/csrf");
  const csrfRes = await request.get(`${BASE_URL}/api/auth/csrf`);
  if (!csrfRes.ok()) throw new Error(`csrf: ${csrfRes.status()}`);
  const { csrfToken } = await csrfRes.json();
  log(`  ↳ csrfToken acquired`);

  log("step 2: POST /api/auth/callback/credentials");
  const loginRes = await request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    form: {
      csrfToken,
      email: EMAIL,
      password: PASSWORD,
      tenantSlug: TENANT_SLUG,
      json: "true",
    },
    maxRedirects: 0,
  });
  log(`  ↳ ${loginRes.status()}`);
  if (loginRes.status() >= 400) {
    const body = await loginRes.text();
    throw new Error(`login failed: ${loginRes.status()} ${body.slice(0, 200)}`);
  }
  const cookiesAfterLogin = await context.cookies();
  const sessionCookie = cookiesAfterLogin.find((c) => c.name.includes("session-token"));
  log(`  ↳ session cookie set: ${sessionCookie?.name ?? "(none)"}`);

  log("step 3: compute current TOTP code");
  const code = generateSync({ secret });
  log(`  ↳ code: ${code} (rotates every 30s)`);

  log("step 4: POST /api/auth/totp/verify (immediately, no session polls)");
  const verifyRes = await request.post(`${BASE_URL}/api/auth/totp/verify`, {
    data: { code },
    headers: { "Content-Type": "application/json" },
  });
  log(`  ↳ ${verifyRes.status()}`);
  const verifyBody = await verifyRes.text();
  if (verifyRes.status() >= 400) {
    throw new Error(`verify failed: ${verifyRes.status()} ${verifyBody}`);
  }
  log(`  ↳ body: ${verifyBody.slice(0, 100)}`);

  const cookiesAfterVerify = await context.cookies();
  const newSession = cookiesAfterVerify.find((c) => c.name.includes("session-token"));
  log(`  ↳ session cookie now: ${newSession?.name}`);

  log("step 5: GET /dashboard to confirm access");
  const dashRes = await request.get(`${BASE_URL}/dashboard`, { maxRedirects: 0 });
  log(`  ↳ ${dashRes.status()} (200 = success, 3xx redirect = follow up)`);
  if (dashRes.status() === 200) {
    log("✓ DASHBOARD REACHABLE — login fully works");
  } else if (dashRes.status() >= 300 && dashRes.status() < 400) {
    log(`  ↳ redirect to ${dashRes.headers()["location"]}`);
    if ((dashRes.headers()["location"] ?? "").includes("/login")) {
      throw new Error(`dashboard redirected back to /login — verify cookie didn't take effect`);
    }
    log("  (redirect within app — likely OK)");
  } else {
    throw new Error(`dashboard returned ${dashRes.status()}`);
  }

  log("");
  log("=== DIRECT LOGIN SUCCEEDED ===");
  log(`Session cookie shape: ${newSession?.name} (v5 ✓)`);

  // Also: print the cookie value so the user can paste it into their
  // own browser if they want to skip the manual login entirely.
  if (newSession) {
    console.log("");
    console.log("To get into the dashboard in your own browser:");
    console.log(`1. Open https://matflow.studio (any page)`);
    console.log(`2. DevTools → Application → Cookies → matflow.studio`);
    console.log(`3. Set:`);
    console.log(`     Name:    ${newSession.name}`);
    console.log(`     Value:   ${newSession.value}`);
    console.log(`     Domain:  ${newSession.domain}`);
    console.log(`     Path:    ${newSession.path}`);
    console.log(`     Secure:  ${newSession.secure}`);
    console.log(`     HttpOnly: ${newSession.httpOnly}`);
    console.log(`     SameSite: ${newSession.sameSite}`);
    console.log(`4. Reload — you'll be on /dashboard.`);
  }
} finally {
  await browser.close();
}
