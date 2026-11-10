// Round 1 (9 Nov 2026): labels say what their data is, failures are visible,
// icon controls have names. Owner and member, desktop 1440 and phone 390, by
// keyboard. Seeds 120 check-ins (over the page's 100-row limit), two
// payments, one product, one initiative and one class today, all under the
// fixture club, and deletes them again.
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, focusRing } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round1-truthful-labels");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 6);
const errors = [];
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const noHScroll = (p) => p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
const activeName = (p) => p.evaluate(() => {
  const el = document.activeElement;
  return el ? (el.getAttribute("aria-label") || el.textContent || "").trim() : "";
});

const seeded = { classes: [], schedules: [], instances: [], records: [], payments: [], products: [], initiatives: [] };
const members = await q(`select id, name from "Member" where "tenantId" = $1 order by name`, [tenantId]);
if (members.length < 2) throw new Error("fixture has fewer than 2 members");

async function seed() {
  const classId = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 20)`, [classId, tenantId, `Round1 Class ${TAG}`]);
  seeded.classes.push(classId);
  // A weekly slot every day at 18:00, so the member schedule draws the class whatever today is.
  for (let dow = 0; dow < 7; dow++) {
    const sid = randomUUID();
    await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate") values ($1, $2, $3, '18:00', '19:00', now() - interval '90 days')`, [sid, classId, dow]);
    seeded.schedules.push(sid);
  }
  // One session today (dashboard "checked in" count) and one per past day for the history.
  const today = new Date(); today.setHours(18, 0, 0, 0);
  const todayInst = randomUUID();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '18:00', '19:00')`, [todayInst, classId, today]);
  seeded.instances.push(todayInst);
  for (const m of members) {
    const id = randomUUID();
    await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod") values ($1, $2, $3, $4, $5, 'admin')`, [id, tenantId, m.id, todayInst, new Date(today.getTime() - 3600_000)]);
    seeded.records.push(id);
  }
  // 118 more check-ins spread over the past 60 days: 120 in all, above the 100-row limit.
  for (let i = 0; i < 59; i++) {
    const d = new Date(today); d.setDate(d.getDate() - (i + 1));
    const inst = randomUUID();
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '18:00', '19:00')`, [inst, classId, d]);
    seeded.instances.push(inst);
    for (const m of members.slice(0, 2)) {
      const id = randomUUID();
      await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod") values ($1, $2, $3, $4, $5, 'admin')`, [id, tenantId, m.id, inst, d]);
      seeded.records.push(id);
    }
  }
  for (const [status, name] of [["succeeded", members[0]], ["refunded", members[1]]]) {
    const id = randomUUID();
    await q(`insert into "Payment" (id, "tenantId", "memberId", "amountPence", status, description, "paidAt") values ($1, $2, $3, 4500, $4, $5, now())`, [id, tenantId, name.id, status, `Round1 ${TAG}`]);
    seeded.payments.push(id);
  }
  const prod = randomUUID();
  await q(`insert into "Product" (id, "tenantId", name, "pricePence", category, symbol, "updatedAt") values ($1, $2, $3, 1500, 'clothing', '🥋', now())`, [prod, tenantId, `Rashguard ${TAG}`]);
  seeded.products.push(prod);
  const init = randomUUID();
  await q(`insert into "Initiative" (id, "tenantId", type, "startDate", notes, "createdById") values ($1, $2, 'marketing', now() - interval '10 days', $3, $4)`, [init, tenantId, `Flyers ${TAG}`, club.owner.id]);
  seeded.initiatives.push(init);
}
async function cleanup() {
  await q(`delete from "InitiativeAttachment" where "initiativeId" = any($1::text[])`, [seeded.initiatives]).catch(() => {});
  await q(`delete from "Initiative" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.initiatives]);
  await q(`delete from "Product" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.products]);
  await q(`delete from "Payment" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.payments]);
  await q(`delete from "AttendanceRecord" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.records]);
  await q(`delete from "ClassInstance" where id = any($1::text[])`, [seeded.instances]);
  await q(`delete from "ClassSchedule" where id = any($1::text[])`, [seeded.schedules]);
  await q(`delete from "Class" where "tenantId" = $1 and id = any($2::text[])`, [tenantId, seeded.classes]);
  // Anything the journey itself created through the app (an initiative via the form).
  await q(`delete from "Initiative" where "tenantId" = $1 and notes like $2`, [tenantId, `%${TAG}%`]);
}

const browser = await chromium.launch();
try {
  await seed();
  const ctx = await context(browser, "198.18.41.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(page, club);

  // ── C1: dashboard "checked in" ──
  await page.goto("/dashboard");
  await page.waitForLoadState("networkidle");
  const dash = norm(await page.locator("body").innerText());
  L.check("labels", "C1 dashboard today's class says 'checked in', never 'booked'", /\d+ checked in/.test(dash) && !/\d+ booked\b/.test(dash), dash.match(/\d+ (checked in|booked)[^·]*/)?.[0] ?? "(no count)");

  // ── B + C2: Attendance footer and the stat card ──
  await page.goto("/dashboard/attendance");
  await page.getByTestId("attendance-footer").waitFor();
  const footer = norm(await page.getByTestId("attendance-footer").innerText());
  L.check("attendance", "B1 120 check-ins exist; the footer says only the latest 100 are loaded", footer === "Latest 100 records. Older records aren't loaded here.", footer);
  L.check("attendance", "C2 the stat card reads 'Busiest session', not 'Top Class'", await page.getByText("Busiest session").count() === 1 && (await page.getByText("Top Class").count()) === 0, {});
  const search = page.getByLabel("Search attendance by member or class");
  await search.fill(`zzz-not-loaded-${TAG}`);
  const none = norm(await page.getByTestId("attendance-footer").innerText());
  L.check("attendance", "B2 a search with no hits says it searched only the loaded rows, not that none exist", none === "No matches among the latest 100 loaded records. Search covers only these loaded records.", none);
  L.check("attendance", "B3 the empty list says 'No matches among the loaded records.'", (await page.getByText("No matches among the loaded records.").count()) >= 1, {});
  await search.fill(members[0].name);
  const some = norm(await page.getByTestId("attendance-footer").innerText());
  L.check("attendance", "B4 a search with hits counts matches among the loaded rows", /^\d+ match(es)? among the latest 100 loaded records\. Search covers only these loaded records\.$/.test(some), some);
  await search.fill("");
  await shot(page, "round1-attendance-desktop");

  // ── C3: Revenue "Recent payments" ──
  const revenueLoaded = page.waitForResponse((r) => r.url().includes("/api/revenue/summary") && r.ok(), { timeout: 60000 });
  await page.goto("/dashboard/settings?tab=revenue");
  await page.getByText("Recent payments").waitFor({ timeout: 30000 });
  await revenueLoaded;
  await page.getByText(/^(Paid|Refunded) · /).first().waitFor({ timeout: 15000 });
  const rev = norm(await page.locator("body").innerText());
  L.check("revenue", "C3a the section is 'Recent payments', not 'Recent Activity'", rev.includes("Recent payments") && !rev.includes("Recent Activity"), {});
  L.check("revenue", "C3b a succeeded payment reads 'Paid' and a refunded one 'Refunded'; no 'Joined' or 'Cancelled'", /Paid ·/.test(rev) && /Refunded ·/.test(rev) && !/\bJoined ·|\bCancelled ·/.test(rev), rev.match(/(Paid|Refunded|Joined|Cancelled) · [^\n]{0,30}/g));
  await shot(page, "round1-revenue-desktop");

  // ── A1/A2: Store controls by keyboard ──
  await page.goto("/dashboard/settings?tab=store");
  const editBtn = page.getByRole("button", { name: `Edit Rashguard ${TAG}` });
  const removeBtn = page.getByRole("button", { name: `Remove Rashguard ${TAG} from the shop` });
  await editBtn.waitFor({ timeout: 30000 });
  L.check("a11y", "A1 the product row's icon buttons are named 'Edit {product}' and 'Remove {product} from the shop'", (await editBtn.count()) === 1 && (await removeBtn.count()) === 1, {});
  await editBtn.focus();
  const ring = await focusRing(editBtn);
  L.check("a11y", "A1k Edit has a visible focus ring when reached by keyboard", !!ring && (ring.contrast ?? 0) >= 1.5, ring);
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Edit Product" }).waitFor({ timeout: 10000 });
  const toggle = page.getByRole("switch", { name: "In stock" });
  L.check("a11y", "A2 the In Stock control is a named switch with aria-checked", (await toggle.count()) === 1 && (await toggle.getAttribute("aria-checked")) === "true", await toggle.getAttribute("aria-checked"));
  await toggle.focus(); await page.keyboard.press("Enter");
  L.check("a11y", "A2k Enter on the switch toggles aria-checked", (await toggle.getAttribute("aria-checked")) === "false", {});
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Edit Product" }).waitFor({ state: "hidden", timeout: 10000 });
  L.check("a11y", "A1f Escape closes the drawer and nothing was saved (the product is still in stock)", (await q(`select "inStock" from "Product" where id = $1`, [seeded.products[0]]))[0].inStock === true, {});
  await shot(page, "round1-store-desktop");

  // ── D: Initiatives on Reports, forced failures ──
  await page.goto("/dashboard/reports");
  await page.getByText(`Flyers ${TAG}`).waitFor({ timeout: 60000 });
  // D1: a failed read is said, not shown as empty.
  await page.route("**/api/initiatives", (r) => r.request().method() === "GET" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) }) : r.continue());
  await page.reload();
  const loadErr = page.getByTestId("initiatives-load-error");
  await loadErr.waitFor({ timeout: 60000 });
  L.check("initiatives", "D1 a failed read shows 'Couldn't load initiatives.' with Retry; 'No initiatives yet' is absent", (await loadErr.innerText()).includes("Couldn't load") && (await page.getByText(/No initiatives yet/).count()) === 0, norm(await loadErr.innerText()));
  await page.unroute("**/api/initiatives");
  await loadErr.getByRole("button", { name: "Retry" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText(`Flyers ${TAG}`).waitFor({ timeout: 30000 });
  L.check("initiatives", "D1k Retry by keyboard re-reads and the list returns", true, {});
  // D2: a refused create keeps the draft and says why.
  await page.getByRole("button", { name: "Add" }).click();
  const dlg = page.getByRole("dialog", { name: "Add initiative" });
  await dlg.waitFor();
  await dlg.getByLabel("Start date").fill("2026-11-01");
  await dlg.getByLabel("Notes").fill(`Open mat ${TAG}`);
  await page.route("**/api/initiatives", (r) => r.request().method() === "POST" ? r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid data", details: { hidden: "x" } }) }) : r.continue());
  await dlg.getByRole("button", { name: "Save initiative" }).click();
  const cErr = page.getByTestId("initiative-create-error");
  await cErr.waitFor({ timeout: 10000 });
  const cText = norm(await cErr.innerText());
  L.check("initiatives", "D2 a refused save shows the route's sentence (not its details) and keeps the draft", cText === "Couldn't save: Invalid data. Your entries are kept." && (await dlg.getByLabel("Notes").inputValue()) === `Open mat ${TAG}` && !cText.includes("hidden"), cText);
  L.check("initiatives", "D2f focus is still inside the dialog (typing is not disrupted)", await dlg.evaluate((d) => d.contains(document.activeElement)), await activeName(page));
  // D3: a lost response says the outcome is unknown.
  await page.unroute("**/api/initiatives");
  await page.route("**/api/initiatives", (r) => r.request().method() === "POST" ? r.abort("connectionfailed") : r.continue());
  await dlg.getByRole("button", { name: "Save initiative" }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="initiative-create-error"]')?.textContent?.includes("isn't known"), null, { timeout: 10000 });
  const lost = norm(await cErr.innerText());
  L.check("initiatives", "D3 no reply: says it isn't known whether it was saved, never 'nothing changed'; draft kept", lost.includes("isn't known whether this was saved") && !/nothing changed/i.test(lost) && (await dlg.getByLabel("Notes").inputValue()) === `Open mat ${TAG}`, lost);
  const dbAfterLost = (await q(`select count(*)::int as n from "Initiative" where "tenantId" = $1 and notes = $2`, [tenantId, `Open mat ${TAG}`]))[0].n;
  L.check("initiatives", "D3b nothing was created by the aborted request and nothing retried on its own", dbAfterLost === 0, { rows: dbAfterLost });
  await page.unroute("**/api/initiatives");
  await page.keyboard.press("Escape");
  // D4: a refused delete keeps the row.
  await page.route(`**/api/initiatives/${seeded.initiatives[0]}`, (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Failed to delete initiative" }) }) : r.continue());
  const delBtn = page.getByRole("button", { name: /^Delete Marketing campaign initiative from \d{1,2} \w{3} \d{4}$/ });
  const delCount = await delBtn.count();
  L.check("a11y", "A6 the initiative delete button is named with its type and date", delCount === 1, delCount === 1 ? await delBtn.getAttribute("aria-label") : { count: delCount });
  await delBtn.click();
  await page.getByRole("button", { name: "Delete initiative" }).click();
  const dErr = page.getByTestId("initiative-delete-error");
  await dErr.waitFor({ timeout: 10000 });
  L.check("initiatives", "D4 a refused delete says 'It is still here.' and the row stays", (await dErr.innerText()).includes("It is still here.") && (await page.getByText(`Flyers ${TAG}`).count()) === 1, norm(await dErr.innerText()));
  await page.unroute(`**/api/initiatives/${seeded.initiatives[0]}`);
  await shot(page, "round1-initiatives-desktop");

  // ── Phone: owner pages ──
  const phone = await context(browser, "198.18.41.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(p2, club);
  await p2.goto("/dashboard/attendance");
  await p2.getByTestId("attendance-footer").waitFor();
  const m1 = await noHScroll(p2);
  L.check("mobile", "M1 Attendance at 390 px: capped footer shown, no horizontal scroll", norm(await p2.getByTestId("attendance-footer").innerText()).startsWith("Latest 100 records") && m1.scroll <= m1.width + 1, m1);
  await shot(p2, "round1-attendance-phone");
  await p2.goto("/dashboard/settings?tab=store");
  const mEdit = p2.getByRole("button", { name: `Edit Rashguard ${TAG}` });
  await mEdit.waitFor({ timeout: 30000 });
  const box = await mEdit.boundingBox();
  L.note("mobile", "M2 Store edit button size at 390 px (44 px is the target)", box);
  await shot(p2, "round1-store-phone");
  await p2.goto("/dashboard/reports");
  await p2.getByText(`Flyers ${TAG}`).waitFor({ timeout: 60000 });
  const m3 = await noHScroll(p2);
  L.check("mobile", "M3 Reports at 390 px shows the initiative; no horizontal scroll", m3.scroll <= m3.width + 1, m3);

  // ── Member: shop and schedule sheet names ──
  const member = await memberLogin(club, members[0].name);
  const mctx = await context(browser, "198.18.41.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  mp.on("pageerror", (e) => errors.push(String(e)));
  await memberSignIn(mp, club, member);
  await mp.goto("/member/shop");
  const addBtn = mp.getByRole("button", { name: `Add Rashguard ${TAG} to cart` });
  await addBtn.waitFor({ timeout: 60000 });
  L.check("a11y", "A3 the shop's add button is named 'Add {product} to cart'", (await addBtn.count()) === 1, {});
  await addBtn.focus(); await mp.keyboard.press("Enter");
  const plus = mp.getByRole("button", { name: `Add one more Rashguard ${TAG}` });
  const minus = mp.getByRole("button", { name: `Remove one Rashguard ${TAG}` });
  await plus.waitFor({ timeout: 10000 });
  L.check("a11y", "A3k Enter adds to the cart; the quantity buttons are named", (await plus.count()) >= 1 && (await minus.count()) >= 1, {});
  await mp.getByRole("button", { name: "Open cart" }).click();
  const closeCart = mp.getByRole("button", { name: "Close cart" });
  await closeCart.waitFor({ timeout: 10000 });
  L.check("a11y", "A3c the cart has 'Close cart' and 'Remove {item} from cart'", (await mp.getByRole("button", { name: `Remove Rashguard ${TAG} from cart` }).count()) === 1, {});
  await closeCart.focus(); await mp.keyboard.press("Enter");
  await closeCart.waitFor({ state: "hidden", timeout: 10000 });
  const mShop = await noHScroll(mp);
  L.check("mobile", "M4 Shop at 390 px: no horizontal scroll", mShop.scroll <= mShop.width + 1, mShop);
  await shot(mp, "round1-shop-phone");
  await mp.goto("/member/schedule");
  const cell = mp.getByRole("button", { name: new RegExp(`Round1 Class ${TAG}`) }).first();
  await cell.waitFor({ timeout: 60000 });
  await cell.click();
  const closeSheet = mp.getByRole("button", { name: "Close class details" });
  await closeSheet.waitFor({ timeout: 10000 });
  L.check("a11y", "A4 the class details sheet's close button is named 'Close class details'", (await closeSheet.count()) === 1, {});
  await closeSheet.focus(); await mp.keyboard.press("Enter");
  await closeSheet.waitFor({ state: "hidden", timeout: 10000 });
  L.check("a11y", "A4k Enter closes the sheet", true, {});

  // ── A5: login show-password toggle ──
  const anon = await context(browser, "198.18.41.4");
  const ap = await anon.newPage();
  await ap.goto("/login");
  await ap.getByLabel("Club code").fill(club.slug);
  await ap.keyboard.press("Enter");
  await ap.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  const show = ap.getByRole("button", { name: "Show password", pressed: false });
  L.check("a11y", "A5 the password toggle is named 'Show password' and reports aria-pressed", (await show.count()) === 1, {});
  await show.focus(); await ap.keyboard.press("Enter");
  L.check("a11y", "A5k Enter flips it to 'Hide password', pressed", (await ap.getByRole("button", { name: "Hide password", pressed: true }).count()) === 1, {});

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await cleanup().catch((e) => L.check("teardown", "T1 the journey's seed is deleted", false, String(e).slice(0, 200)));
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
