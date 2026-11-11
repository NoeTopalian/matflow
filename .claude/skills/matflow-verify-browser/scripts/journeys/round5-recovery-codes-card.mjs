// Round 5 remediation (11 Nov 2026): the owner's Settings → Account "Recovery Codes" card posted with no
// authenticator code, and the route (step-up since L1-I2-S-01) always refused it. The card now asks for the code.
// R1 a wrong code: the server's refusal is shown beside the field, the field is cleared, the stored codes are unchanged.
// R2 a forced server error and R3 a network failure: a message, nothing changed.
// R4 a fresh code: eight new codes are shown and the stored set is replaced (eight hashes, different from before).
// M1 phone 390 px: the code field and buttons fit, no sideways scroll.
// K1 keyboard only: Tab reaches "Generate new", Enter opens the field, typing a fresh code and Enter submits.
import { chromium, state, q, ledger, shot, context, ownerSignIn, freshCode } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round5-recovery-codes-card");
const errors = [];
const codes = async () => (await q(`select "totpRecoveryCodes"::text as c from "User" where "tenantId" = $1 and role = 'owner' order by "createdAt" limit 1`, [club.tenantId]))[0].c;
const card = (page) => page.locator("div.rounded-2xl", { has: page.getByRole("heading", { name: "Recovery Codes" }) });

async function openAccount(page) {
  await page.goto("/dashboard/settings?tab=account");
  await page.getByRole("heading", { name: "Recovery Codes" }).waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
}
async function ask(page) {
  await card(page).getByRole("button", { name: "Generate new", exact: true }).click();
  await card(page).getByLabel("Authenticator code").waitFor();
}
async function submit(page, code) {
  await card(page).getByLabel("Authenticator code").fill(code);
  await card(page).getByRole("button", { name: "Generate new codes" }).click();
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "198.18.56.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(page, club);
  await openAccount(page);
  const before = await codes();

  // ── R1 ──
  const current = await freshCode(club.owner.secret);
  const wrong = current === "000000" ? "111111" : "000000";
  await ask(page);
  await submit(page, wrong);
  const alert = card(page).getByRole("alert");
  await alert.waitFor({ timeout: 30000 });
  L.check("refusal", "R1 a wrong code: the server's refusal shows beside the field, the field is cleared, the codes are unchanged",
    /code/i.test(await alert.innerText()) && (await card(page).getByLabel("Authenticator code").inputValue()) === "" && (await codes()) === before,
    { alert: await alert.innerText(), field: await card(page).getByLabel("Authenticator code").inputValue() });
  await shot(page, "round5-recovery-card-refused");

  // ── R2 / R3 ──
  await page.route("**/api/auth/totp/recovery-codes", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to generate recovery codes" }) }));
  await submit(page, "123456");
  await card(page).getByRole("alert").filter({ hasText: "Failed to generate" }).waitFor({ timeout: 30000 });
  L.check("failure", "R2 server error: the message shows, nothing changed", (await codes()) === before, await card(page).getByRole("alert").innerText());
  await page.unroute("**/api/auth/totp/recovery-codes");
  await page.route("**/api/auth/totp/recovery-codes", (r) => r.abort("failed"));
  await submit(page, "123456");
  await card(page).getByRole("alert").filter({ hasText: "connection" }).waitFor({ timeout: 30000 });
  L.check("failure", "R3 network failure: says so (old codes still work), nothing changed", (await codes()) === before, await card(page).getByRole("alert").innerText());
  await page.unroute("**/api/auth/totp/recovery-codes");

  // ── R4 ──
  await submit(page, await freshCode(club.owner.secret));
  const shown = page.getByText("Save these 8 single-use codes");
  await shown.waitFor({ timeout: 30000 });
  const after = await codes();
  L.check("success", "R4 a fresh code: eight new codes are shown, and the stored set is replaced by eight hashes",
    after !== before && JSON.parse(after).length === 8, { stored: JSON.parse(after).length });
  await shot(page, "round5-recovery-card-codes");

  // ── M1 + K1 (phone, keyboard) ──
  const ph = await context(browser, "198.18.56.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  pp.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pp, club);
  await openAccount(pp);
  const gen = card(pp).getByRole("button", { name: "Generate new", exact: true });
  let reached = false;
  for (let i = 0; i < 200 && !reached; i++) {
    await pp.keyboard.press("Tab");
    reached = await gen.evaluate((el) => el === document.activeElement).catch(() => false);
  }
  if (reached) await pp.keyboard.press("Enter");
  else { L.note("keyboard", "K0 Tab did not reach 'Generate new' in 200 presses; activated by click", {}); await gen.click(); }
  const field = card(pp).getByLabel("Authenticator code");
  await field.waitFor();
  const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 phone 390 px: the code field and buttons show, no sideways scroll", m.scroll <= m.width + 1, m);
  await shot(pp, "round5-recovery-card-phone");
  const focused = await field.evaluate((el) => el === document.activeElement);
  const before2 = await codes();
  await pp.keyboard.type(await freshCode(club.owner.secret));
  await pp.keyboard.press("Enter");
  await pp.getByText("Save these 8 single-use codes").waitFor({ timeout: 30000 }).catch(() => {});
  L.check("keyboard", "K1 keyboard: Tab reaches 'Generate new', Enter opens the focused field, typing a fresh code and Enter replaces the codes",
    reached && focused && (await codes()) !== before2, { reached, focused });

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
