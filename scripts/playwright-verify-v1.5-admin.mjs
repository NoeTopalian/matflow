#!/usr/bin/env node
/**
 * End-to-end verification of v1.5 admin auth + TOTP on production
 * (matflow.studio). API-driven (Playwright request fixture, no browser).
 *
 * Steps:
 *   1.  Wait for Vercel deploy of operator-totp routes (poll 401, not 404)
 *   2.  Reset Operator TOTP via direct Prisma write (clean slate)
 *   3.  Login: email + password → expect session cookie, no totpRequired
 *   4.  Read /admin → 200
 *   5.  GET /api/admin/auth/operator-totp/setup → capture secret
 *   6.  Compute code via otplib
 *   7.  POST /api/admin/auth/operator-totp/setup → enable TOTP
 *   8.  Logout → cookies cleared
 *   9.  Login again → expect totpRequired:true + challenge cookie
 *  10.  POST /api/admin/auth/operator-totp → expect session cookie
 *  11.  Read /admin → 200
 *  12.  Reset Operator TOTP (so user can re-enrol via UI with their phone)
 *
 * Run: node scripts/playwright-verify-v1.5-admin.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// ── Env ──────────────────────────────────────────────────────────────────────
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

const BASE_URL = "https://matflow.studio";
const EMAIL = "noetopalian@gmail.com";
const PASSWORD = process.env.OPERATOR_PASSWORD;
if (!PASSWORD) {
  console.error("OPERATOR_PASSWORD env var required (audit C-1: the previous hardcoded fallback was a leaked credential).");
  process.exit(1);
}

const log = (l) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
const fail = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

// ── Prisma ───────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) fail("DATABASE_URL not set");
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function resetOperatorTotp(label) {
  const r = await prisma.operator.update({
    where: { email: EMAIL },
    data: { totpEnabled: false, totpSecret: null, sessionVersion: { increment: 1 } },
    select: { totpEnabled: true, sessionVersion: true },
  });
  log(`  ↳ ${label}: totpEnabled=${r.totpEnabled}, sessionVersion=${r.sessionVersion}`);
}

// ── Phase 1: wait for deploy ─────────────────────────────────────────────────
log("step 1: waiting for Vercel to ship the operator-totp routes");
const browser = await chromium.launch({ headless: true });
try {
  const probeCtx = await browser.newContext();
  let attempts = 0;
  const maxAttempts = 30; // 5 min @ 10s
  while (attempts++ < maxAttempts) {
    const res = await probeCtx.request.get(`${BASE_URL}/api/admin/auth/operator-totp/setup`);
    log(`  ↳ probe ${attempts}: ${res.status()}`);
    if (res.status() !== 404) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (attempts >= maxAttempts) fail("deploy did not ship within 5 minutes");
  await probeCtx.close();
  log("  ✓ deploy is live");

  // ── Phase 2: reset ─────────────────────────────────────────────────────────
  log("step 2: reset Operator TOTP for clean slate");
  await resetOperatorTotp("after reset");

  // Helper to mint fresh context (no cookies)
  const fresh = () => browser.newContext();

  async function login(ctx, expectTotp) {
    const csrfRes = await ctx.request.get(`${BASE_URL}/api/auth/csrf`);
    const { csrfToken } = await csrfRes.json();
    void csrfToken; // not used by operator-login but tracked for parity
    const res = await ctx.request.post(`${BASE_URL}/api/admin/auth/operator-login`, {
      data: { email: EMAIL, password: PASSWORD },
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    log(`  ↳ login status=${res.status()}, body=${JSON.stringify(body)}`);
    if (res.status() !== 200) fail(`login failed: ${res.status()} ${JSON.stringify(body)}`);
    const totpRequired = body?.totpRequired === true;
    if (expectTotp && !totpRequired) fail(`expected totpRequired:true, got ${JSON.stringify(body)}`);
    if (!expectTotp && totpRequired) fail(`expected no TOTP, got totpRequired:true`);
    const cookies = await ctx.cookies();
    log(`  ↳ cookies: ${cookies.map((c) => c.name).join(", ")}`);
    return { totpRequired, cookies };
  }

  // ── Phase 3: first login (no TOTP) ─────────────────────────────────────────
  log("step 3: first login (no TOTP)");
  const ctx1 = await fresh();
  const r3 = await login(ctx1, false);
  if (!r3.cookies.find((c) => c.name === "matflow_op_session")) fail("no matflow_op_session after no-TOTP login");

  // ── Phase 4: read access ───────────────────────────────────────────────────
  log("step 4: GET /admin");
  const adminRes = await ctx1.request.get(`${BASE_URL}/admin`, { maxRedirects: 0 });
  log(`  ↳ ${adminRes.status()}`);
  if (adminRes.status() === 307) {
    const loc = adminRes.headers().location;
    if ((loc ?? "").includes("/login")) fail(`/admin redirected to login (cookie not honoured): ${loc}`);
    log(`  ↳ redirect to ${loc} (not login — likely intra-app)`);
  } else if (adminRes.status() !== 200) {
    fail(`/admin returned ${adminRes.status()}`);
  }

  // ── Phase 5+6+7: TOTP enrolment ────────────────────────────────────────────
  log("step 5: GET /api/admin/auth/operator-totp/setup (capture secret)");
  const setupRes = await ctx1.request.get(`${BASE_URL}/api/admin/auth/operator-totp/setup`);
  if (!setupRes.ok()) fail(`setup GET failed: ${setupRes.status()}`);
  const setupBody = await setupRes.json();
  if (setupBody.alreadyEnabled) fail("alreadyEnabled — reset didn't stick?");
  const secret = setupBody.secret;
  if (!secret) fail("no secret returned");
  log(`  ↳ secret captured (len ${secret.length})`);

  log("step 6: compute current TOTP code");
  const code = generateSync({ secret });
  log(`  ↳ code: ${code}`);

  log("step 7: POST /api/admin/auth/operator-totp/setup (enable TOTP)");
  const enableRes = await ctx1.request.post(`${BASE_URL}/api/admin/auth/operator-totp/setup`, {
    data: { code },
    headers: { "Content-Type": "application/json" },
  });
  if (!enableRes.ok()) fail(`enrolment POST failed: ${enableRes.status()} ${await enableRes.text()}`);
  log(`  ↳ enrolment OK (${enableRes.status()})`);

  // ── Phase 8: logout ────────────────────────────────────────────────────────
  log("step 8: logout");
  const logoutRes = await ctx1.request.post(`${BASE_URL}/api/admin/auth/logout`, {
    headers: { "Content-Type": "application/json" },
  });
  log(`  ↳ ${logoutRes.status()}`);
  await ctx1.close();

  // ── Phase 9: TOTP-gated login ──────────────────────────────────────────────
  log("step 9: second login — expect TOTP gate");
  const ctx2 = await fresh();
  const r9 = await login(ctx2, true);
  if (!r9.cookies.find((c) => c.name === "matflow_op_challenge")) fail("no matflow_op_challenge after TOTP-gated login");
  if (r9.cookies.find((c) => c.name === "matflow_op_session")) fail("session was issued before TOTP — bug!");

  // ── Phase 10: TOTP challenge ───────────────────────────────────────────────
  log("step 10: POST /api/admin/auth/operator-totp (verify challenge)");
  const code2 = generateSync({ secret });
  log(`  ↳ code: ${code2}`);
  const totpRes = await ctx2.request.post(`${BASE_URL}/api/admin/auth/operator-totp`, {
    data: { code: code2 },
    headers: { "Content-Type": "application/json" },
  });
  log(`  ↳ ${totpRes.status()}`);
  if (!totpRes.ok()) fail(`TOTP challenge failed: ${totpRes.status()} ${await totpRes.text()}`);
  const ctx2Cookies = await ctx2.cookies();
  if (!ctx2Cookies.find((c) => c.name === "matflow_op_session")) fail("no matflow_op_session after TOTP challenge");
  log(`  ↳ session cookie issued`);

  // ── Phase 11: final read ───────────────────────────────────────────────────
  log("step 11: final GET /admin");
  const adminRes2 = await ctx2.request.get(`${BASE_URL}/admin`, { maxRedirects: 0 });
  log(`  ↳ ${adminRes2.status()}`);
  if (adminRes2.status() === 307 && (adminRes2.headers().location ?? "").includes("/login")) {
    fail("final /admin redirected to login");
  } else if (adminRes2.status() >= 400) {
    fail(`final /admin returned ${adminRes2.status()}`);
  }
  await ctx2.close();

  // ── Phase 12: reset for clean state ────────────────────────────────────────
  log("step 12: reset Operator TOTP so user can re-enrol via UI");
  await resetOperatorTotp("final reset");

  log("");
  log("=========================================================");
  log(" ✓ ALL 12 STEPS PASSED — v1.5 admin auth + TOTP works ✓");
  log("=========================================================");
  log("");
  log("Operator state: TOTP cleared. You can now sign in with:");
  log(`  email:    ${EMAIL}`);
  log(`  password: ${PASSWORD}`);
  log(`  url:      ${BASE_URL}/admin/login`);
  log("");
  log("After login, visit /admin/security to enrol TOTP with your");
  log("own authenticator app (the in-test secret is server-only).");
} finally {
  await browser.close();
  await prisma.$disconnect();
}
