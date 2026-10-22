// Browser-verification helpers. TEST branch only (env.mjs refuses anything else). Playwright, pg, bcrypt and otplib
// are loaded from the worktree under test (MF_APP), so nothing is installed here.
import fs from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { APP, OUT, BASE, testEnv, assertTestUrl } from "../../matflow-verify-local/scripts/env.mjs";
export { APP, OUT, BASE };

const require = createRequire(`${APP}/package.json`);
export const { chromium } = require("@playwright/test");
export const bcrypt = require("bcryptjs");
const pg = require("pg");
const otplib = require("otplib");
export const DB_URL = assertTestUrl(testEnv().DATABASE_URL, "DATABASE_URL");

// Fixture state holds synthetic passwords and authenticator secrets: kept in OUT, never printed or committed.
const STATE = `${OUT}/fixture-state.json`;
export const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
export const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newSecret = () => otplib.generateSecret();

/** One authenticator code per 30 s step, never reused (the server rejects a replayed code). */
export async function freshCode(secret) {
  const last = state.lastStep ?? (state.lastStep = {});
  const key = sha256(secret).slice(0, 12);
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if (step > (last[key] ?? 0) && Date.now() % 30000 < 24000) { last[key] = step; saveState(); return otplib.generateSync({ secret }); }
    await sleep(30000 - (Date.now() % 30000) + 600);
  }
}

/** Raw SQL on the TEST branch with RLS bypassed (fixtures and assertions only). */
export async function q(sql, params = []) {
  const c = new pg.Client({ connectionString: DB_URL, statement_timeout: 30000 });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.bypass_rls','on',true)");
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { await c.end(); }
}

/** PASS / FAIL / NOTE ledger in OUT. Addresses and six-digit codes are scrubbed. */
export function ledger(name) {
  const path = `${OUT}/ledger-${name}.json`;
  const rows = [];
  const scrub = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "[address]").replace(/\b\d{6}\b/g, "[code]").slice(0, 800);
  const add = (result, c, id, saw) => {
    const row = { case: c, id, result, saw: scrub(typeof saw === "string" ? saw : JSON.stringify(saw)), at: new Date().toISOString() };
    rows.push(row); fs.writeFileSync(path, JSON.stringify(rows, null, 2));
    console.log(`${result} [${c}] ${id} — ${row.saw.slice(0, 300)}`);
    return result !== "FAIL";
  };
  return {
    rows, path,
    check: (c, id, ok, saw) => add(ok ? "PASS" : "FAIL", c, id, saw),
    note: (c, id, saw) => add("NOTE", c, id, saw),
    summary: () => ["PASS", "FAIL", "NOTE"].map((r) => `${rows.filter((x) => x.result === r).length} ${r}`).join(" / "),
  };
}

/** Full-page screenshot with addresses masked. */
export async function shot(page, name) {
  try {
    await page.evaluate(() => {
      const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (re.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(re, "[address]");
    });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    return `${OUT}/${name}.png`;
  } catch (e) { console.log(`  (screenshot ${name} failed: ${String(e).slice(0, 120)})`); return null; }
}

/** A browser context through the HTTPS proxy. laneIp separates rate-limit buckets between runs. */
export async function context(browser, laneIp, opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": laneIp }, viewport: { width: 1440, height: 900 }, ...opts });
  ctx.setDefaultTimeout(60000);
  ctx.setDefaultNavigationTimeout(120000);
  return ctx;
}

/** Club owner sign-in through the real /login form (club code, password, authenticator). */
export async function ownerSignIn(page, club) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(club.owner.email);
  await page.getByLabel("Password").fill(club.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/login\/totp/, { timeout: 60000 });
  await page.getByLabel("Six-digit authentication code").fill(await freshCode(club.owner.secret));
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 60000 });
}
