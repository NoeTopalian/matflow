// Club-managed class categories, Release A, on screen (synthetic data only).
//   node run-journeys.mjs class-categories-a
// Release A has no screen for managing categories, but it must show what Release B will leave behind. So the journey
// first makes, directly in the test branch's database, what B would: Fundamentals renamed to Beginners, a category
// the club made (Intermediate), and an archived one (Private). Then, through the real app:
//   the class form offers the club's active categories by name (Private absent) and is driven by keyboard;
//   a refused save (409, the archived sentence) and a network failure keep the choice and say why beside the buttons;
//   the retry sends exactly one request and stores the reference (the old key column follows: empty for Intermediate);
//   the timetable card and week chip (desktop) and the phone timetable show the name, with no sideways scroll;
//   the member's schedule (phone) and the kiosk show the name;
//   an older page's old key is translated by the server; choosing the archived category is refused.
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { launchWithScrollbars, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, phoneNoSidewaysScroll } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("class-categories-a");
const TAG = randomUUID().slice(0, 6);
const CLASS = `Fundamentals Gi ${TAG}`;

async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    L.check(id, desc, false, String(e.message ?? e).split("\n").slice(0, 3).join(" | "));
  }
}
const cat = async (key) => (await q(`select id, name from "ClassCategory" where "tenantId" = $1 and "legacyKey" = $2`, [tenantId, key]))[0];
const classRow = async (id) => (await q(`select category, "categoryId", "categoryKeyWrittenAt" from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0];

// ── What Release B would leave behind (directly; there is no route for it in this release) ──
const fundamentals = await cat("fundamentals");
if (!fundamentals) throw new Error("the fixture club has no starting categories: is the class_categories migration applied to the test branch?");
await q(`update "ClassCategory" set name = 'Beginners', "nameKey" = 'beginners', version = version + 1, "updatedAt" = now() where id = $1`, [fundamentals.id]);
const privateCat = await cat("private");
await q(`update "ClassCategory" set "archivedAt" = now(), version = version + 1, "updatedAt" = now() where id = $1`, [privateCat.id]);
const intermediateId = `mfv_cat_${TAG}`;
await q(`insert into "ClassCategory" (id, "tenantId", name, "nameKey", "sortOrder", "updatedAt") values ($1, $2, 'Intermediate', 'intermediate', 50, now())`, [intermediateId, tenantId]);

// A kiosk for the club (same derivation as lib/token-hash.ts); the raw token is never printed.
const env = testEnv();
const SECRET = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
const kioskRaw = `mfvk${randomUUID().replace(/-/g, "")}`;
await q(`update "Tenant" set "kioskTokenHash" = $1 where id = $2`, [createHmac("sha256", SECRET).update(kioskRaw).digest("hex"), tenantId]);

const browser = await launchWithScrollbars();
const errors = [];
try {
  const ctx = await context(browser, "10.95.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(page, club);

  // ── 1. A class on Beginners (the renamed Fundamentals), through the app's create API from the signed-in page ──
  const today = new Date().getDay();
  let classId = "";
  await section("C1", "create with the club's Beginners: 201, the response names it, the old key column follows (fundamentals)", async () => {
    const res = await page.evaluate(async ([name, day, catId]) => {
      const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, duration: 60, categoryId: catId, schedules: [{ dayOfWeek: day, startTime: "23:00", endTime: "23:30" }] }) });
      return { status: r.status, body: await r.json() };
    }, [CLASS, today, fundamentals.id]);
    expect(res.status).toBe(201);
    expect(res.body.categoryName).toBe("Beginners");
    classId = res.body.id;
    expect(await classRow(classId)).toMatchObject({ categoryId: fundamentals.id, category: "fundamentals" });
    return { categoryName: res.body.categoryName };
  });

  await page.goto("/dashboard/timetable");
  await section("C2", "the class card and its week chip say Beginners", async () => {
    const card = page.getByTestId("class-card-category").filter({ hasText: "Beginners" });
    await expect(card.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("class-chip-category").filter({ hasText: "Beginners" }).first()).toBeAttached();
    await shot(page, "class-categories-a-desktop-card");
    return "Beginners on card and chip";
  });

  // ── 2. The form: the club's names, archived Private absent; driven by keyboard ──
  await page.getByLabel(`Edit ${CLASS}`).first().click();
  const select = page.getByRole("combobox", { name: "Category" });
  await section("C3", "the Category select offers Uncategorised and the club's active categories by name, starting on the class's own", async () => {
    await expect(select).toBeVisible();
    const options = await select.locator("option").allTextContents();
    expect(options).toEqual(["Uncategorised", "Beginners", "Gi", "No-Gi", "Kids", "Competition", "Open mat", "Other", "Intermediate"]);
    expect(await select.inputValue()).toBe(`id:${fundamentals.id}`);
    return options;
  });
  await section("C4", "keyboard only: focus the select and type to choose Intermediate", async () => {
    await select.focus();
    await page.keyboard.type("Intermediate");
    expect(await select.inputValue()).toBe(`id:${intermediateId}`);
    const ring = await select.evaluate((el) => getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none");
    return { focusVisible: ring };
  });

  // ── 3. Refused and failed saves keep the choice; the retry sends one request ──
  const archivedSentence = "That category has been archived. Choose another, or leave the class uncategorised.";
  await section("C5", "a 409 refusal says the archived sentence beside the buttons and keeps the choice", async () => {
    await page.route(`**/api/classes/${classId}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: archivedSentence, reason: "category" }) }) : r.continue()));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("class-form-save-error")).toHaveText(archivedSentence);
    expect(await select.inputValue()).toBe(`id:${intermediateId}`);
    await page.unroute(`**/api/classes/${classId}`);
    return "kept";
  });
  await section("C6", "a network failure is said and keeps the choice; nothing is stored", async () => {
    await page.route(`**/api/classes/${classId}`, (r) => (r.request().method() === "PATCH" ? r.abort("failed") : r.continue()));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("class-form-save-error")).toBeVisible();
    expect(await select.inputValue()).toBe(`id:${intermediateId}`);
    expect((await classRow(classId)).categoryId).toBe(fundamentals.id);
    await page.unroute(`**/api/classes/${classId}`);
    return "kept, not stored";
  });
  await section("C7", "the retry sends exactly one PATCH carrying categoryId only; the class is on Intermediate and its old key is empty", async () => {
    const bodies = [];
    page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${classId}`) bodies.push(r.postDataJSON()); });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(async () => (await classRow(classId)).categoryId, { timeout: 15_000 }).toBe(intermediateId);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].categoryId).toBe(intermediateId);
    expect(bodies[0]).not.toHaveProperty("category");
    expect(await classRow(classId)).toMatchObject({ category: null, categoryKeyWrittenAt: null });
    await expect(page.getByTestId("class-card-category").filter({ hasText: "Intermediate" }).first()).toBeVisible();
    return bodies[0];
  });

  // ── 4. An older page's old key, and choosing the archived category, through the API ──
  await section("C8", "an old key from an older page is translated: the class is on the club's Competition, and not stamped as an old build's write", async () => {
    const r = await page.evaluate(async (id) => (await fetch(`/api/classes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "competition" }) })).status, classId);
    expect(r).toBe(200);
    const comp = await cat("competition");
    expect(await classRow(classId)).toMatchObject({ categoryId: comp.id, category: "competition", categoryKeyWrittenAt: null });
    return "translated";
  });
  await section("C9", "choosing the archived Private is refused with the sentence, and nothing changes", async () => {
    const r = await page.evaluate(async ([id, catId]) => { const res = await fetch(`/api/classes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryId: catId }) }); return { status: res.status, body: await res.json() }; }, [classId, privateCat.id]);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(archivedSentence);
    expect((await classRow(classId)).category).toBe("competition");
    // Back onto Intermediate for the member and kiosk checks.
    const back = await page.evaluate(async ([id, catId]) => (await fetch(`/api/classes/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ categoryId: catId }) })).status, [classId, intermediateId]);
    expect(back).toBe(200);
    return r.body.error;
  });

  // ── 5. Phone: the owner's timetable, the member's schedule ──
  const phoneCtx = await context(browser, "10.95.1.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(phone, club);
  await phone.goto("/dashboard/timetable");
  await section("C10", "phone timetable: the class says Intermediate and nothing scrolls sideways", async () => {
    await expect(phone.getByText(CLASS).first()).toBeAttached({ timeout: 30_000 });
    await expect(phone.getByText("Intermediate").first()).toBeAttached();
    const sideways = await phoneNoSidewaysScroll(phone);
    expect(sideways.mainScrolls).toBe(false);
    expect(sideways.documentScrolls).toBe(false);
    expect(sideways.chipsOutsideGrid).toBe(0);
    await shot(phone, "class-categories-a-phone-timetable");
    return sideways;
  });
  const member = await memberLogin(club);
  const mctx = await context(browser, "10.95.1.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const mpage = await mctx.newPage();
  mpage.on("pageerror", (e) => errors.push(e.message));
  await memberSignIn(mpage, club, member);
  await mpage.goto("/member/schedule");
  await section("C11", "the member's schedule (phone) names the category in the class sheet", async () => {
    await mpage.getByText(CLASS).first().click({ timeout: 30_000 });
    await expect(mpage.getByTestId("schedule-sheet-category")).toHaveText("Intermediate");
    await shot(mpage, "class-categories-a-member-sheet");
    return "Intermediate";
  });

  // ── 6. The kiosk ──
  const kctx = await context(browser, "10.95.1.4", { viewport: { width: 1024, height: 768 }, timezoneId: "Europe/London" });
  const kpage = await kctx.newPage();
  kpage.on("pageerror", (e) => errors.push(e.message));
  await kpage.goto(`/kiosk/${kioskRaw}`);
  await section("C12", "the kiosk labels the class with the club's name for its category", async () => {
    const button = kpage.getByRole("button").filter({ hasText: CLASS });
    await expect(button.first()).toBeVisible({ timeout: 30_000 });
    await expect(button.first().getByTestId("kiosk-class-category")).toHaveText("Intermediate");
    await shot(kpage, "class-categories-a-kiosk");
    return "Intermediate";
  });

  L.check("errors", "no uncaught page errors", errors.length === 0, errors.slice(0, 3));
} catch (e) {
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await q(`update "Tenant" set "kioskTokenHash" = null where id = $1`, [tenantId]).catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
