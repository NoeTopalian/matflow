// Round 4 (10 Nov 2026), CONCURRENCY-1 in two real browsers on a synthetic club.
// Two owner tabs (separate browser contexts) edit Settings → Branding → Gym Name.
// C1 the tab opened earlier saves the same field: refused, its draft kept, the newer value stays.
// C2 "Save mine instead" (keyboard) knowingly overwrites.
// C3 "Use the latest" puts the other tab's value in the field and sends nothing.
// C4 a save that commits but whose reply is lost (the browser gets a network
//    failure after the server answered), then retried: one change, one audit row.
// C5 Noe's scenario: A's save commits with its reply lost, B changes the same
//    field, A retries: refused, B's value kept.
// M1 the conflict notice at phone width, no sideways scroll.
import { chromium, state, q, ledger, shot, context, ownerSignIn, sleep } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round4-settings-conflict");
const tenantId = club.tenantId;
const errors = [];
const [{ name: base }] = await q(`select name from "Tenant" where id = $1`, [tenantId]);
const dbName = async () => (await q(`select name from "Tenant" where id = $1`, [tenantId]))[0].name;
const auditCount = async (since, name) => Number((await q(
  `select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = 'tenant.settings.update' and "createdAt" >= $2 and metadata->'after'->>'name' = $3`,
  [tenantId, since, name],
))[0].n);

async function openBranding(page) {
  await page.goto("/dashboard/settings?tab=branding");
  await page.getByLabel("Gym Name").waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
}
async function setName(page, v) {
  await page.getByLabel("Gym Name").fill(v);
}
async function save(page) {
  await page.getByRole("button", { name: /Save Branding/ }).click();
}
const patches = (page) => {
  const seen = [];
  page.on("request", (r) => { if (r.url().includes("/api/settings") && r.method() === "PATCH") seen.push(r.postDataJSON()); });
  return seen;
};

const browser = await chromium.launch();
try {
  const ctxA = await context(browser, "198.18.54.1");
  const ctxB = await context(browser, "198.18.54.2");
  const pA = await ctxA.newPage();
  const pB = await ctxB.newPage();
  for (const p of [pA, pB]) p.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pA, club);
  await ownerSignIn(pB, club);
  await openBranding(pA);
  await openBranding(pB); // B has the page open from now on, with the old name

  // ── C1 ──
  await setName(pA, `${base} A`);
  await save(pA);
  await pA.getByText("Branding saved").first().waitFor({ timeout: 30000 });
  await setName(pB, `${base} B`);
  await save(pB);
  const noticeB = pB.getByTestId("settings-conflict");
  await noticeB.waitFor({ timeout: 30000 });
  L.check("conflict", "C1 the older tab's save of the same field is refused, says so, keeps its draft; the newer value stays",
    (await noticeB.innerText()).includes("Gym name was changed by someone else") && (await pB.getByLabel("Gym Name").inputValue()) === `${base} B` && (await dbName()) === `${base} A`,
    { notice: await noticeB.innerText(), draft: await pB.getByLabel("Gym Name").inputValue(), stored: await dbName() });
  await shot(pB, "round4-settings-conflict-desktop");

  // ── C2 (keyboard) ──
  await noticeB.getByRole("button", { name: "Save mine instead" }).focus();
  await pB.keyboard.press("Enter");
  await pB.getByText("Branding saved").first().waitFor({ timeout: 30000 });
  L.check("conflict", "C2 'Save mine instead' (keyboard) knowingly saves the draft; the notice goes",
    (await dbName()) === `${base} B` && (await pB.getByTestId("settings-conflict").count()) === 0, { stored: await dbName() });

  // ── C3 ──
  const sentA = patches(pA);
  await setName(pA, `${base} A2`);
  await save(pA);
  const noticeA = pA.getByTestId("settings-conflict");
  await noticeA.waitFor({ timeout: 30000 });
  const before = sentA.length;
  await noticeA.getByRole("button", { name: "Use the latest" }).click();
  await sleep(500);
  L.check("conflict", "C3 'Use the latest' shows the other tab's value and sends nothing",
    (await pA.getByLabel("Gym Name").inputValue()) === `${base} B` && sentA.length === before && (await dbName()) === `${base} B`,
    { field: await pA.getByLabel("Gym Name").inputValue(), sentAfter: sentA.length - before });

  // ── C4: reply lost, then retried, nobody else in between ──
  await openBranding(pA);
  const t4 = new Date(Date.now() - 60_000); // margin for clock skew; no other row names this value
  let dropped = 0;
  await pA.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH" && dropped === 0) {
      dropped++;
      await route.fetch(); // the server receives and commits the save
      return route.abort("failed"); // the browser never sees the reply
    }
    return route.continue();
  });
  await setName(pA, `${base} L`);
  await save(pA);
  await pA.getByText(/No reply from MatFlow/).first().waitFor({ timeout: 30000 });
  const afterLost = await dbName();
  await save(pA); // the owner retries
  await pA.getByText("Branding saved").first().waitFor({ timeout: 30000 });
  L.check("lost-reply", "C4 a save whose reply was lost is said as unknown; the retry succeeds with no conflict; one change, one audit row",
    afterLost === `${base} L` && (await dbName()) === `${base} L` && (await pA.getByTestId("settings-conflict").count()) === 0 && (await auditCount(t4, `${base} L`)) === 1,
    { afterLost, stored: await dbName(), auditRows: await auditCount(t4, `${base} L`) });
  await pA.unroute("**/api/settings");

  // ── C5: Noe's scenario ──
  await openBranding(pA);
  await openBranding(pB);
  dropped = 0;
  await pA.route("**/api/settings", async (route) => {
    if (route.request().method() === "PATCH" && dropped === 0) {
      dropped++;
      await route.fetch();
      return route.abort("failed");
    }
    return route.continue();
  });
  await setName(pA, `${base} M`);
  await save(pA); // commits; A's reply is lost
  await pA.getByText(/No reply from MatFlow/).first().waitFor({ timeout: 30000 });
  await openBranding(pB);
  await setName(pB, `${base} N`);
  await save(pB); // B changes the same field
  await pB.getByText("Branding saved").first().waitFor({ timeout: 30000 });
  await save(pA); // A retries
  await pA.getByTestId("settings-conflict").waitFor({ timeout: 30000 });
  L.check("lost-reply", "C5 A's save commits (reply lost), B changes it, A retries: A is refused and told, B's value stays, A's draft kept",
    (await dbName()) === `${base} N` && (await pA.getByLabel("Gym Name").inputValue()) === `${base} M`,
    { stored: await dbName(), draftA: await pA.getByLabel("Gym Name").inputValue() });
  await pA.unroute("**/api/settings");

  // ── M1 ──
  const ph = await context(browser, "198.18.54.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  pp.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pp, club);
  await openBranding(pp);
  await q(`update "Tenant" set name = $2 where id = $1`, [tenantId, `${base} P`]); // someone else, meanwhile
  await setName(pp, `${base} Q`);
  await save(pp);
  await pp.getByTestId("settings-conflict").waitFor({ timeout: 30000 });
  await pp.getByTestId("settings-conflict").scrollIntoViewIfNeeded();
  const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 phone 390 px: the conflict notice shows with both choices, no sideways scroll",
    (await pp.getByRole("button", { name: "Use the latest" }).count()) === 1 && (await pp.getByRole("button", { name: "Save mine instead" }).count()) === 1 && m.scroll <= m.width + 1, m);
  await shot(pp, "round4-settings-conflict-phone");

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await q(`update "Tenant" set name = $2 where id = $1`, [tenantId, base]).catch(() => {});
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
