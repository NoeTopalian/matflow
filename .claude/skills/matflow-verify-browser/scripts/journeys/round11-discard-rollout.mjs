// Journey: Round 11 (baseline 6.1) rollout — the other overlay forms ask before a stray click or Escape discards input.
// Owner, desktop 1440 (mouse + keyboard) and phone 390 (touch), on three of the forms the rollout guards: Add tier
// (memberships), Add rank (ranks) and Add member (members). Each: untouched, a click outside closes at once; with a
// name typed, it asks "Discard your changes?"; Keep editing keeps the text; Discard closes and nothing is saved.
// No request is involved in these closes, so there is no forced network failure here (each form's own save failures
// are covered by allowances-periods, accounts-and-members and the unit suites).
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/round11-discard-rollout.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-discard-rollout");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 8);
const errors = [];

const question = (page) => page.getByRole("dialog", { name: "Discard your changes?" });
const asked = (page) => question(page).waitFor({ timeout: 10000 }).then(() => true, () => false);
const gone = (loc) => loc.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);

const FORMS = [
  { key: "tier", path: "/dashboard/memberships", open: "Add tier", dialog: "Add tier", field: "Name *",
    saved: (v) => q(`select count(*)::int as n from "MembershipTier" where "tenantId" = $1 and name = $2`, [tenantId, v]) },
  { key: "rank", path: "/dashboard/ranks", open: "Add rank", dialog: "Add rank", field: /Rank name/,
    saved: (v) => q(`select count(*)::int as n from "RankSystem" where "tenantId" = $1 and name = $2`, [tenantId, v]) },
  { key: "member", path: "/dashboard/members", open: "Add member", dialog: "Add Member", field: "Full Name",
    saved: (v) => q(`select count(*)::int as n from "Member" where "tenantId" = $1 and name = $2`, [tenantId, v]) },
];

async function walk(page, f, where, outside) {
  await page.goto(f.path);
  const openBtn = page.getByRole("button", { name: f.open, exact: true }).filter({ visible: true }).first();
  await openBtn.waitFor({ timeout: 90000 });
  const dlg = page.getByRole("dialog", { name: f.dialog, exact: true });
  const field = typeof f.field === "string" ? dlg.getByLabel(f.field, { exact: true }) : dlg.getByLabel(f.field);

  await openBtn.click();
  await field.waitFor({ timeout: 15000 });
  await outside();
  const cleanClosed = await gone(dlg);
  L.check(where, `${f.key}: untouched, a click outside closes at once`, cleanClosed && (await question(page).count()) === 0, { cleanClosed });

  const value = `Discard ${f.key} ${where} ${TAG}`;
  await openBtn.click();
  await field.fill(value);
  await outside();
  const a1 = await asked(page);
  if (where === "desktop") await shot(page, `r11-rollout-${f.key}`);
  await question(page).getByRole("button", { name: "Keep editing" }).click();
  const kept = await field.inputValue().catch(() => null);
  L.check(where, `${f.key}: with a name typed, a click outside asks; Keep editing keeps it`, a1 && kept === value, { a1, kept });

  await page.keyboard.press("Escape");
  const a2 = await asked(page);
  await question(page).getByRole("button", { name: "Discard changes" }).click();
  const closed = await gone(dlg);
  const n = (await f.saved(value))[0].n;
  L.check(where, `${f.key}: Escape asks; Discard closes and nothing is saved`, a2 && closed && n === 0, { a2, closed, n });
}

const browser = await chromium.launch();
try {
  {
    const ctx = await context(browser, "10.98.4.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(page, club);
    for (const f of FORMS) await walk(page, f, "desktop", () => page.mouse.click(30, 450));
    await ctx.close();
  }
  {
    const ctx = await context(browser, "10.98.4.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(page, club);
    // Phone: sheets rise from the bottom and dialogs sit in the middle; the very top of the screen is the scrim.
    await walk(page, FORMS[0], "phone", () => page.touchscreen.tap(195, 12));
    await ctx.close();
  }
  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e).slice(0, 300));
} finally {
  await browser.close();
  await q(`delete from "MembershipTier" where "tenantId" = $1 and name like $2`, [tenantId, `Discard % ${TAG}`]).catch(() => {});
  await q(`delete from "RankSystem" where "tenantId" = $1 and name like $2`, [tenantId, `Discard % ${TAG}`]).catch(() => {});
  await q(`delete from "Member" where "tenantId" = $1 and name like $2`, [tenantId, `Discard % ${TAG}`]).catch(() => {});
}
console.log(`
${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
