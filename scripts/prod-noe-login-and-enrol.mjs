#!/usr/bin/env node
/**
 * Log into NOETEST tenant as noetopalian@gmail.com, complete TOTP enrolment,
 * land on /dashboard, then open a headed browser already authenticated.
 *
 * Pre-conditions:
 *   - DB: noetopalian@gmail.com has totpEnabled=false, totpSecret=null
 *     (run scripts/reset-totp-noe.mjs if needed)
 *   - Vercel commit be8f599 + 93eb3b5 are live
 */
import { chromium } from "@playwright/test";
import { generateSync } from "otplib";

const BASE_URL = "https://matflow.studio";
const TENANT_SLUG = "noetest";
const EMAIL = "noetopalian@gmail.com";
const PASSWORD = process.env.MATFLOW_PROD_PASSWORD;
if (!PASSWORD) {
  console.error("MATFLOW_PROD_PASSWORD env var required (audit C-1).");
  process.exit(1);
}

const log = (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const request = context.request;

try {
  log("step 1: GET /api/auth/csrf");
  const { csrfToken } = await (await request.get(`${BASE_URL}/api/auth/csrf`)).json();

  log("step 2: POST /api/auth/callback/credentials");
  const loginRes = await request.post(`${BASE_URL}/api/auth/callback/credentials`, {
    form: { csrfToken, email: EMAIL, password: PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
    maxRedirects: 0,
  });
  log(`  ↳ ${loginRes.status()}`);
  if (loginRes.status() >= 400) {
    console.error("login failed:", await loginRes.text());
    await browser.close();
    process.exit(1);
  }

  log("step 3: GET /api/auth/totp/setup (generate secret + QR)");
  const setupRes = await request.get(`${BASE_URL}/api/auth/totp/setup`);
  log(`  ↳ ${setupRes.status()}`);
  if (!setupRes.ok()) {
    console.error("setup GET failed:", await setupRes.text());
    await browser.close();
    process.exit(1);
  }
  const setupBody = await setupRes.json();
  if (setupBody.alreadyEnabled) {
    log("  ↳ TOTP already enabled — skipping enrolment");
  } else {
    log(`  ↳ secret captured (len ${setupBody.secret.length})`);

    log("step 4: compute current TOTP code");
    const code = generateSync({ secret: setupBody.secret });
    log(`  ↳ code: ${code}`);

    log("step 5: POST /api/auth/totp/setup (verify code, set totpEnabled=true, re-encode JWT)");
    const verifyRes = await request.post(`${BASE_URL}/api/auth/totp/setup`, {
      data: { code },
      headers: { "Content-Type": "application/json" },
    });
    log(`  ↳ ${verifyRes.status()}`);
    if (verifyRes.status() >= 400) {
      console.error("setup POST verify failed:", await verifyRes.text());
      await browser.close();
      process.exit(1);
    }

    log("step 6: POST /api/auth/totp/recovery-codes (generate codes)");
    const recovRes = await request.post(`${BASE_URL}/api/auth/totp/recovery-codes`, {
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
    });
    log(`  ↳ ${recovRes.status()}`);
    if (recovRes.ok()) {
      const recov = await recovRes.json();
      log("");
      log("=== RECOVERY CODES — SAVE THESE ===");
      (recov.codes ?? []).forEach((c, i) => log(`  ${i + 1}. ${c}`));
      log("");
    } else {
      log(`  ↳ (could not generate recovery codes: ${await recovRes.text()})`);
    }
  }

  log("step 7: GET /dashboard to confirm access");
  const dashRes = await request.get(`${BASE_URL}/dashboard`, { maxRedirects: 0 });
  log(`  ↳ ${dashRes.status()}`);
  if (dashRes.status() >= 400 || (dashRes.status() >= 300 && (dashRes.headers()["location"] ?? "").includes("/login"))) {
    console.error(`dashboard not reachable. status=${dashRes.status()} location=${dashRes.headers()["location"]}`);
    await browser.close();
    process.exit(1);
  }

  log("✓ DASHBOARD REACHABLE — opening headed browser");
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  log(`✓ landed on ${page.url()}`);
  log("");
  log("Browser open. Close the window when done.");

  await new Promise((resolve) => {
    page.on("close", resolve);
    browser.on("disconnected", resolve);
  });
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(1);
}
