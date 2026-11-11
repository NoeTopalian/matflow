// Round 5 (11 Nov 2026), R5-3 in a real browser on a synthetic club: "Sign out all devices" signs this device
// out only when the server confirms every session was revoked.
// D1 desktop: the revoke fails with a server error: the toast says the other devices are still signed in, this
//    device stays on the dashboard, nothing is revoked (sessionVersion unchanged).
// D2 desktop: the request never gets an answer (network failure): the same.
// D3 desktop retry: exactly one request, this device lands on /login and the owner's sessionVersion moved by one.
// M1 phone 390 px: a failure shows the toast, the control is usable again, no sideways scroll.
// K0/K1 phone, keyboard: how many Tabs reach the control (measured); Enter activates it; a retry that works signs out.
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round5-sign-out-everywhere");
const errors = [];
const version = async () => Number((await q(`select "sessionVersion" as v from "User" where "tenantId" = $1 and role = 'owner' order by "createdAt" limit 1`, [club.tenantId]))[0].v);
const STILL = /other devices are still signed in/i;

const browser = await chromium.launch();
try {
  // ── Desktop ──
  const ctx = await context(browser, "198.18.55.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(page, club);
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");
  const revokeFromMenu = async () => {
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out all devices" }).click();
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
  };

  const v0 = await version();
  await page.route("**/api/auth/logout-all", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to revoke sessions" }) }));
  await revokeFromMenu();
  const toast1 = page.getByRole("alert").filter({ hasText: STILL });
  await toast1.first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  L.check("desktop", "D1 server error: the toast says the other devices are still signed in; this device stays signed in; nothing revoked",
    /\/dashboard/.test(page.url()) && (await version()) === v0, { url: page.url(), toast: await toast1.first().innerText(), v0, v: await version() });
  await shot(page, "round5-sign-out-failed-desktop");
  await page.unroute("**/api/auth/logout-all");

  await page.route("**/api/auth/logout-all", (r) => r.abort("failed"));
  await revokeFromMenu();
  await page.getByRole("alert").filter({ hasText: STILL }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  L.check("desktop", "D2 network failure: the same; still signed in, nothing revoked", /\/dashboard/.test(page.url()) && (await version()) === v0, { url: page.url() });
  await page.unroute("**/api/auth/logout-all");

  const sent = [];
  page.on("request", (r) => { if (r.url().includes("/api/auth/logout-all")) sent.push(r.method()); });
  await revokeFromMenu();
  await page.waitForURL(/\/login/, { timeout: 60000 });
  L.check("desktop", "D3 retry: one request, this device signs out, and every session is revoked (sessionVersion +1)",
    sent.length === 1 && (await version()) === v0 + 1, { sent, v0, v: await version(), url: page.url() });

  // ── Phone ──
  const ph = await context(browser, "198.18.55.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  pp.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pp, club);
  await pp.goto("/dashboard");
  await pp.waitForLoadState("networkidle");
  const v1 = await version();
  await pp.route("**/api/auth/logout-all", (r) => r.abort("failed"));
  await pp.getByRole("button", { name: "More options" }).click();
  const control = pp.getByRole("button", { name: "Sign out all devices" });
  await control.click();
  await pp.getByRole("alert").filter({ hasText: STILL }).first().waitFor({ timeout: 30000 });
  await pp.waitForTimeout(1000);
  const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 phone: failure shows the toast, still signed in, control usable again, no sideways scroll",
    /\/dashboard/.test(pp.url()) && (await version()) === v1 && (await control.isEnabled()) && m.scroll <= m.width + 1, { url: pp.url(), enabled: await control.isEnabled(), ...m });
  await shot(pp, "round5-sign-out-failed-phone");
  await pp.unroute("**/api/auth/logout-all");

  // ── Keyboard ──
  // The More sheet is open with the control in it. Tab order is the page's (the sheet does not trap focus), so count.
  let tabs = 0;
  let reached = false;
  while (tabs < 200 && !reached) {
    await pp.keyboard.press("Tab");
    tabs += 1;
    reached = await control.evaluate((el) => el === document.activeElement);
  }
  if (!reached) {
    L.note("keyboard", "K0 Tab did not reach 'Sign out all devices' within 200 presses with the More sheet open (pre-existing: the sheet does not move or trap focus); Enter is checked on the focused control below", { tabs, sheetOpen: await control.isVisible() });
    await control.focus();
  } else {
    L.note("keyboard", "K0 Tab presses from the page to 'Sign out all devices' with the More sheet open", { tabs });
  }
  const focusedNow = await control.evaluate((el) => el === document.activeElement);
  await pp.keyboard.press("Enter");
  await pp.waitForURL(/\/login/, { timeout: 60000 }).catch(() => {});
  L.check("keyboard", "K1 Enter on the focused control works by keyboard; the retry signs out and revokes",
    focusedNow && /\/login/.test(pp.url()) && (await version()) === v1 + 1, { tabs, reached, url: pp.url(), v1, v: await version() });

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
