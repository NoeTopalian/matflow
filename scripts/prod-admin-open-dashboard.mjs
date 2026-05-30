#!/usr/bin/env node
/**
 * One-shot: log in via API, then open a headed browser already on /dashboard.
 * The browser stays open until you close it.
 */
import { chromium } from "@playwright/test";
import { generateSync } from "otplib";

const BASE_URL = "https://matflow.studio";
const TENANT_SLUG = "totalbjj";
const EMAIL = "owner@totalbjj.com";
const PASSWORD = process.env.MATFLOW_PROD_PASSWORD;
if (!PASSWORD) {
  console.error("MATFLOW_PROD_PASSWORD env var required (audit C-1).");
  process.exit(1);
}

const arg = (n) => {
  const f = process.argv.find((a) => a.startsWith(`--${n}=`));
  return f ? f.slice(n.length + 3) : undefined;
};

const secret = arg("secret");
if (!secret) { console.error("missing --secret=<base32>"); process.exit(2); }

const log = (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();

log("logging in via API…");
const csrfRes = await context.request.get(`${BASE_URL}/api/auth/csrf`);
const { csrfToken } = await csrfRes.json();

const loginRes = await context.request.post(`${BASE_URL}/api/auth/callback/credentials`, {
  form: { csrfToken, email: EMAIL, password: PASSWORD, tenantSlug: TENANT_SLUG, json: "true" },
  maxRedirects: 0,
});
log(`  ↳ login: ${loginRes.status()}`);

const code = generateSync({ secret });
log(`computing TOTP code: ${code}`);

const verifyRes = await context.request.post(`${BASE_URL}/api/auth/totp/verify`, {
  data: { code },
  headers: { "Content-Type": "application/json" },
});
log(`  ↳ verify: ${verifyRes.status()}`);
if (verifyRes.status() >= 400) {
  console.error("verify failed:", await verifyRes.text());
  await browser.close();
  process.exit(1);
}

log("opening /dashboard in headed browser…");
const page = await context.newPage();
await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
log(`✓ landed on ${page.url()}`);
log("");
log("Browser is now open and authenticated. You can drive it manually.");
log("Close the browser window when you're done — the script will exit.");

// Keep alive until browser closes.
await new Promise((resolve) => {
  page.on("close", resolve);
  browser.on("disconnected", resolve);
});
log("browser closed — script exiting");
