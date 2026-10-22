// Example journey and template: owner signs in, saves the club contact email by keyboard, survives a network failure and
// a server error with the typed value kept and nothing saved, retries successfully, then the same pages at phone width.
// Copy this file and replace the journey for the feature under test. Needs `fixture.mjs create` and `server.mjs start`.
//   node smoke.mjs
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "./lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("smoke");
const addr = `${club.slug}-contact@example.test`;
const dbContact = async () => (await q(`select "contactEmail" from "Tenant" where id = $1`, [club.tenantId]))[0]?.contactEmail ?? null;
const errors = [];
const browser = await chromium.launch();
try {
  // Desktop journey.
  const ctx = await context(browser, "10.91.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let patches = 0;
  page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === "/api/settings") patches++; });
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in (password + authenticator) lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);
  await page.goto("/dashboard/settings");
  // The settings page renders the section twice (one copy hidden), so target the visible field.
  const input = page.locator('input[aria-label="Contact email"]:visible');
  await input.waitFor();
  L.check("journey", "J2 Settings shows the contact email field, empty for a new club", (await input.inputValue()) === "" && (await dbContact()) === null, "field and database empty");

  // Keyboard: type in the field, Tab to Save.
  await input.focus();
  await page.keyboard.type(addr);
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const e = document.activeElement; const s = getComputedStyle(e);
    return { text: e.textContent.trim(), outline: `${s.outlineStyle} ${s.outlineWidth}`, shadow: s.boxShadow };
  });
  L.check("keyboard", "K1 Tab from the field reaches the Save button", focus.text.includes("Save contact email"), focus.text);
  L.check("keyboard", "K2 the focused Save button shows a visible focus indicator", !focus.outline.startsWith("none") || focus.shadow !== "none", focus);

  // Failed save: network failure.
  await page.route("**/api/settings", (r) => (r.request().method() === "PATCH" ? r.abort("failed") : r.fallback()));
  await page.keyboard.press("Enter");
  const netAlert = page.getByRole("alert").filter({ hasText: "Couldn't reach MatFlow" });
  const sawNet = await netAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F1 network failure: message shown beside the action, typed value kept, nothing saved",
    sawNet && (await input.inputValue()) === addr && (await dbContact()) === null, { alert: sawNet, kept: (await input.inputValue()) === addr });
  await shot(page, "smoke-failed-network");

  // Failed save: server error without a reason.
  await page.unroute("**/api/settings");
  await page.route("**/api/settings", (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.fallback()));
  await page.getByRole("button", { name: "Save contact email" }).click();
  const srvAlert = page.getByRole("alert").filter({ hasText: "Couldn't save the contact email" });
  const sawSrv = await srvAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F2 server error: message shown, typed value kept, nothing saved",
    sawSrv && (await input.inputValue()) === addr && (await dbContact()) === null, { alert: sawSrv });

  // Retry with the real server.
  await page.unroute("**/api/settings");
  const before = patches;
  await page.getByRole("button", { name: "Save contact email" }).focus();
  await page.keyboard.press("Enter");
  const saved = await page.getByText("Contact email saved").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  await page.waitForTimeout(1000);
  L.check("retry", "R1 retry sends one request: confirmation shown, error cleared, database holds the value",
    saved && patches - before === 1 && (await page.getByRole("alert").filter({ hasText: "Couldn't" }).count()) === 0 && (await dbContact()) === addr, { saved, requests: patches - before });
  await page.reload();
  await input.waitFor();
  L.check("retry", "R2 value persists after reload", (await input.inputValue()) === addr, "reloaded");
  await shot(page, "smoke-desktop-settings");

  // Phone width, same session.
  const phone = await context(browser, "10.91.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard", "/dashboard/settings"]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", `M1 ${path} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `smoke-mobile${path.replace(/\//g, "-")}`);
  }
  const box = await p2.getByRole("button", { name: "Save contact email" }).boundingBox();
  L.note("mobile", "M2 Save button tap target at 390 px (44 px is the target)", box ? `${Math.round(box.width)}×${Math.round(box.height)} px` : "not visible");
  L.check("journey", "J3 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
