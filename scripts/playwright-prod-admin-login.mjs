#!/usr/bin/env node
/**
 * Drives matflow.studio admin login for the TotalBJJ tenant via Playwright.
 *
 * Two phases — secrets supplied via CLI flags:
 *
 *   PREP    node scripts/playwright-prod-admin-login.mjs prep
 *           - launches headed Chromium against https://matflow.studio
 *           - drives login: TOTALBJJ → owner@totalbjj.com → password123
 *           - waits for /login/totp (TotalBJJ already has TOTP enabled)
 *           - saves storage state + screenshot
 *           - exits, asking user for 6-digit OTP
 *
 *   FINISH  node scripts/playwright-prod-admin-login.mjs finish --otp="123456"
 *           - restores storage state, navigates to /login/totp
 *           - types code, submits
 *           - asserts /dashboard
 *           - cleans up temp files on success
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "https://matflow.studio";
const TENANT_CODE = "TOTALBJJ";
const EMAIL = "owner@totalbjj.com";
const PASSWORD = process.env.MATFLOW_PROD_PASSWORD;
if (!PASSWORD) {
  console.error("MATFLOW_PROD_PASSWORD env var required (audit C-1).");
  process.exit(1);
}

const TMP_DIR = path.join(os.tmpdir(), "matflow-pw");
fs.mkdirSync(TMP_DIR, { recursive: true });
const STATE_PATH = path.join(TMP_DIR, "state.json");

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : undefined;
}

function log(line) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
}

const phase = process.argv[2] ?? "prep";

if (phase === "prep") await runPrep();
else if (phase === "finish") await runFinish();
else { console.error("usage: prep | finish --otp=NNNNNN"); process.exit(2); }

async function runPrep() {
  log(`launching headed Chromium against ${BASE_URL}`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const cookieNames = new Set();
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/api/auth")) return;
    log(`  ↳ ${res.status()} ${res.request().method()} ${u.pathname}`);
    const sc = res.headers()["set-cookie"];
    if (sc && typeof sc === "string") {
      for (const m of sc.matchAll(/(?:^|,\s*)([\w.-]+)=/g)) {
        if (m[1].includes("session-token")) cookieNames.add(m[1]);
      }
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      log(`URL → ${new URL(frame.url()).pathname}`);
    }
  });

  log(`navigating to /login`);
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });

  log(`filling club code "${TENANT_CODE}"`);
  const codeInput = page.locator('input[placeholder*="TOTALBJJ" i], input[placeholder*="club" i]').first();
  await codeInput.waitFor({ state: "visible", timeout: 15_000 });
  await codeInput.fill(TENANT_CODE);
  // Click "Continue" button — more reliable than Enter on this form.
  const codeContinue = page.getByRole("button", { name: /continue/i }).first();
  await codeContinue.click({ timeout: 5_000 }).catch(() => page.keyboard.press("Enter"));

  log(`waiting for email input (after club lookup)`);
  const emailInput = page.locator('input[placeholder*="Email address" i]').first();
  await emailInput.waitFor({ state: "visible", timeout: 30_000 });

  log(`filling email "${EMAIL}"`);
  await emailInput.fill(EMAIL);

  log(`waiting for password input`);
  const pwdInput = page.locator('input[type="password"]').first();
  // Sometimes the email + password are on the same view, sometimes split.
  // If password is already visible, fill both. Otherwise click Continue first.
  let pwdVisible = await pwdInput.isVisible().catch(() => false);
  if (!pwdVisible) {
    const cont = page.getByRole("button", { name: /continue/i }).first();
    await cont.click({ timeout: 5_000 }).catch(() => page.keyboard.press("Enter"));
    await pwdInput.waitFor({ state: "visible", timeout: 15_000 });
  }

  log(`filling password (masked)`);
  await pwdInput.fill(PASSWORD);
  // Submit via Sign-in button (or Enter as fallback).
  const signIn = page.getByRole("button", { name: /sign in|log in|continue/i }).first();
  await signIn.click({ timeout: 5_000 }).catch(() => page.keyboard.press("Enter"));

  log(`waiting for /login/totp or /dashboard`);
  await page.waitForURL((u) =>
    u.pathname === "/login/totp" ||
    u.pathname === "/login/totp/setup" ||
    u.pathname.startsWith("/dashboard"),
    { timeout: 20_000 },
  );

  const url = new URL(page.url());
  log(`landed on ${url.pathname}`);

  if (url.pathname.startsWith("/dashboard")) {
    log(`✓ already at dashboard — TOTP not required`);
    log(`Cookie names observed: ${[...cookieNames].join(", ") || "(none)"}`);
    await context.storageState({ path: STATE_PATH });
    await browser.close();
    return;
  }

  if (url.pathname === "/login/totp/setup") {
    log(`✗ landed on /login/totp/setup — TotalBJJ TOTP got disabled. This script expects /login/totp (challenge). Run reset script or use NOETEST flow.`);
    await page.screenshot({ path: path.join(TMP_DIR, "fail.png"), fullPage: true });
    await browser.close();
    process.exit(3);
  }

  // /login/totp — challenge page. Save state, wait for OTP from chat.
  log(`✓ at /login/totp — TOTP login challenge ready`);
  log(`Cookie names observed: ${[...cookieNames].join(", ") || "(none)"}`);
  await context.storageState({ path: STATE_PATH });
  await page.screenshot({ path: path.join(TMP_DIR, "totp-challenge.png"), fullPage: true });
  await browser.close();

  console.log("");
  console.log("=== PREP DONE ===");
  console.log("Storage state:", STATE_PATH);
  console.log("");
  console.log("NEXT: get the 6-digit code from your authenticator and run:");
  console.log(`  node scripts/playwright-prod-admin-login.mjs finish --otp="123456"`);
}

async function runFinish() {
  const otp = arg("otp");
  const watchMode = !otp;
  if (otp && !/^\d{6}$/.test(otp)) { console.error("malformed --otp=NNNNNN"); process.exit(2); }
  if (!fs.existsSync(STATE_PATH)) { console.error("no storage state — run `prep` first"); process.exit(2); }
  if (watchMode) log(`no --otp provided — entering WATCH MODE (you type code in browser)`);

  log(`launching headed Chromium with restored session`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: STATE_PATH });
  const page = await context.newPage();

  const cookieNames = new Set();
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith("/api/auth")) return;
    log(`  ↳ ${res.status()} ${res.request().method()} ${u.pathname}`);
    const sc = res.headers()["set-cookie"];
    if (sc && typeof sc === "string") {
      for (const m of sc.matchAll(/(?:^|,\s*)([\w.-]+)=/g)) {
        if (m[1].includes("session-token")) cookieNames.add(m[1]);
      }
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) log(`URL → ${new URL(frame.url()).pathname}`);
  });

  log(`navigating to /login/totp`);
  await page.goto(`${BASE_URL}/login/totp`, { waitUntil: "domcontentloaded" });

  if (watchMode) {
    log(`=== TYPE THE 6-DIGIT CODE IN THE VISIBLE BROWSER ===`);
    log(`I'll watch the URL — when you reach /dashboard, the script will exit success.`);
  } else {
    log(`entering OTP code`);
    const codeInput = page.locator('input[type="text"][maxlength="6"], input[inputmode="numeric"], input[placeholder*="6-digit" i]').first();
    await codeInput.waitFor({ state: "visible", timeout: 10_000 });
    await codeInput.fill(otp);
    await page.keyboard.press("Enter");
  }

  log(`waiting for /dashboard${watchMode ? " (5 min timeout — type the code now)" : ""}`);
  try {
    await page.waitForURL((u) => u.pathname.startsWith("/dashboard"), { timeout: watchMode ? 5 * 60 * 1000 : 15_000 });
    log(`✓ DASHBOARD REACHED`);
    log(`Cookie names observed: ${[...cookieNames].join(", ") || "(none)"}`);
    await page.screenshot({ path: path.join(TMP_DIR, "dashboard.png"), fullPage: true });
    log(`screenshot: ${path.join(TMP_DIR, "dashboard.png")}`);
  } catch (e) {
    log(`✗ failed to reach /dashboard. Final URL: ${page.url()}`);
    await page.screenshot({ path: path.join(TMP_DIR, "fail.png"), fullPage: true });
    log(`failure screenshot: ${path.join(TMP_DIR, "fail.png")}`);
    await browser.close();
    process.exit(4);
  }

  await browser.close();
  // cleanup state file on success
  try { fs.unlinkSync(STATE_PATH); } catch {}
  console.log("");
  console.log("=== LOGGED IN — admin dashboard reached ===");
}
