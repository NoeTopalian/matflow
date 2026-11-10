// Round 2 (10 Nov 2026): Settings → Branding starts from the club's saved
// background and font in any browser and saves only what changed; a failed
// save says so and keeps the draft; Settings → Revenue says when plans could
// not be loaded. Owner, desktop 1440 and phone 390, by keyboard.
// The fixture club's branding is set to non-default values first and put back.
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round2-settings-truth");
const tenantId = club.tenantId;
const errors = [];
const SAVED = { bgColor: "#223344", fontFamily: "'Montserrat', sans-serif" };
const noHScroll = (p) => p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
const tenantRow = async () => (await q(`select name, "bgColor", "fontFamily", "primaryColor" from "Tenant" where id = $1`, [tenantId]))[0];

const before = await tenantRow();
await q(`update "Tenant" set "bgColor" = $2, "fontFamily" = $3 where id = $1`, [tenantId, SAVED.bgColor, SAVED.fontFamily]);

const browser = await chromium.launch();
try {
  // ── Browser 1: carries a stale cache from another session ──
  const ctx1 = await context(browser, "198.18.42.1");
  const p1 = await ctx1.newPage();
  p1.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(p1, club);
  await p1.evaluate((slug) => localStorage.setItem("gym-settings", JSON.stringify({ slug, bgColor: "#000000", fontFamily: "'Bebas Neue', sans-serif", primaryColor: "#ff0000" })), club.slug);
  await p1.goto("/dashboard/settings?tab=branding");
  const bgHex = p1.getByLabel("App Background — hex value");
  await bgHex.waitFor({ timeout: 60000 });
  L.check("branding", "A1 a browser with a stale cache shows the club's saved background, not the cache", (await bgHex.inputValue()).toLowerCase() === SAVED.bgColor, await bgHex.inputValue());

  // A2: change only the name, save by keyboard; background and font are untouched in the database.
  const name = p1.getByLabel("Gym Name");
  const newName = `${before.name} R2`;
  await name.fill(newName);
  const save = p1.getByRole("button", { name: /Save Branding/ });
  const patch = p1.waitForRequest((r) => r.url().includes("/api/settings") && r.method() === "PATCH", { timeout: 30000 });
  await save.focus();
  await p1.keyboard.press("Enter");
  const body = JSON.parse((await patch).postData() ?? "{}");
  L.check("branding", "A2 Save sent only the changed name", JSON.stringify(Object.keys(body)) === JSON.stringify(["name"]), body);
  await p1.getByText("Branding saved — member app updated").waitFor({ timeout: 30000 });
  const after = await tenantRow();
  L.check("branding", "A3 the database kept the saved background and font; the name changed", after.bgColor === SAVED.bgColor && after.fontFamily === SAVED.fontFamily && after.name === newName && after.primaryColor === before.primaryColor, after);
  await shot(p1, "round2-branding-desktop");

  // ── Browser 2: fresh, no cache ──
  const ctx2 = await context(browser, "198.18.42.2");
  const p2 = await ctx2.newPage();
  p2.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(p2, club);
  await p2.goto("/dashboard/settings?tab=branding");
  const bg2 = p2.getByLabel("App Background — hex value");
  await bg2.waitFor({ timeout: 60000 });
  L.check("branding", "A4 a fresh browser shows the same saved background and the new name", (await bg2.inputValue()).toLowerCase() === SAVED.bgColor && (await p2.getByLabel("Gym Name").inputValue()) === newName, { bg: await bg2.inputValue() });

  // A5: a refused save keeps the draft and says so; the database is unchanged.
  await p2.getByLabel("Gym Name").fill(`${newName} X`);
  await p2.route("**/api/settings", (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to update settings" }) }) : r.continue());
  await p2.getByRole("button", { name: /Save Branding/ }).click();
  await p2.getByText("Failed to update settings").waitFor({ timeout: 30000 });
  L.check("branding", "A5 a refused save shows the server's sentence, keeps the typed name, and changes nothing", (await p2.getByLabel("Gym Name").inputValue()) === `${newName} X` && (await tenantRow()).name === newName && (await p2.getByText("Branding saved").count()) === 0, {});
  // A6: a lost response says the outcome is unknown.
  await p2.unroute("**/api/settings");
  await p2.route("**/api/settings", (r) => r.request().method() === "PATCH" ? r.abort("connectionfailed") : r.continue());
  await p2.getByRole("button", { name: /Save Branding/ }).click();
  const unknown = p2.getByText(/isn't known whether your branding was saved/);
  await unknown.waitFor({ timeout: 30000 });
  L.check("branding", "A6 no reply: says it isn't known whether it saved; the draft stays", (await p2.getByLabel("Gym Name").inputValue()) === `${newName} X`, {});
  await p2.unroute("**/api/settings");

  // ── Revenue plans: failure, Retry, empty (the plan route is answered in the browser; no Stripe call) ──
  await q(`update "Tenant" set "stripeConnected" = true, "stripeAccountId" = 'acct_round2_synthetic' where id = $1`, [tenantId]);
  let plansCall = 0;
  await p2.route("**/api/stripe/subscription-plans", (r) => {
    plansCall++;
    return plansCall === 1
      ? r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "upstream" }) })
      : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plans: [] }) });
  });
  await p2.goto("/dashboard/settings?tab=revenue");
  const plansErr = p2.getByTestId("plans-load-error");
  await plansErr.waitFor({ timeout: 60000 });
  L.check("revenue", "C1 a failed plan read says it couldn't load; 'No plans yet' is absent", (await plansErr.innerText()).includes("Couldn't load your plans") && (await p2.getByText(/No plans yet/).count()) === 0, {});
  await plansErr.getByRole("button", { name: "Retry" }).focus();
  await p2.keyboard.press("Enter");
  await p2.getByText(/No plans yet/).waitFor({ timeout: 30000 });
  L.check("revenue", "C2 Retry by keyboard re-reads; an empty list reads 'No plans yet'", plansCall === 2, { plansCall });
  await shot(p2, "round2-revenue-desktop");

  // ── Phone ──
  const ph = await context(browser, "198.18.42.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  pp.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pp, club);
  await pp.goto("/dashboard/settings?tab=branding");
  const bg3 = pp.getByLabel("App Background — hex value");
  await bg3.waitFor({ timeout: 60000 });
  const m = await noHScroll(pp);
  L.check("mobile", "M1 Branding at 390 px shows the saved background; no horizontal scroll", (await bg3.inputValue()).toLowerCase() === SAVED.bgColor && m.scroll <= m.width + 1, m);
  await shot(pp, "round2-branding-phone");

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await q(`update "Tenant" set name = $2, "bgColor" = $3, "fontFamily" = $4, "stripeConnected" = false, "stripeAccountId" = null where id = $1`, [tenantId, before.name, before.bgColor, before.fontFamily])
    .catch((e) => L.check("teardown", "T1 the club's branding is put back", false, String(e).slice(0, 200)));
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
