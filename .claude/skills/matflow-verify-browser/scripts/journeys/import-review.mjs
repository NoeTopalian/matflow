// Close-out task 6 (25 Oct 2026): later uploads never overwrite MatFlow; the owner reviews who differs.
// Owner signs in → imports a synthetic TeamUp file (Add people, real preview + commit routes) → edits one member's
// status by hand through the normal member edit → the same file as a Status refresh changes nobody → the review list
// from the import history (keyboard), forced failure + retry, follows a person's link → the plan-less person is listed
// → a deleted member shows no data → phone width.
//   node journeys/import-review.mjs        (needs fixture.mjs create + server.mjs start)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("import-review");
const T = club.tenantId;
const errors = [];
const E = (who) => `${club.slug}-${who}@example.test`;

// A synthetic TeamUp memberships export (26 columns). "Mfv Adults" is a MatFlow plan's exact name; "Mfv Open Mat" is no
// plan's name. Owner rule 27 Oct 2026: a plan is set only when name, billing period, price and currency agree, and a
// TeamUp export states no money, so NOBODY gets a plan from it: all three are imported without one and listed.
const HEADER = "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const row = (name, email, plan, dob) => [name, email, "", plan, "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", dob, "", "", ""].join(",");
const PEOPLE = [
  ["Ada Field", E("ada"), "Mfv Adults", "1990-01-01"],
  ["Ben Gale", E("ben"), "Mfv Adults", "1991-02-02"],
  ["Cy Holt", E("cy"), "Mfv Open Mat", "1992-03-03"],
];
const csv = [HEADER, ...PEOPLE.map((p) => row(...p))].join("\n");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mfv-import-"));

const memberByEmail = async (email) => (await q(`select id, status, "membershipTierId", "membershipType", "billingStatusSource" from "Member" where "tenantId" = $1 and email = $2`, [T, email]))[0] ?? null;

// One "Mfv Adults" plan: an exact name match, which alone never sets a plan (27 Oct rule).
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "isKids", "isActive", "createdAt", "updatedAt")
         select $1, $2, 'Mfv Adults', 8800, 'GBP', 'monthly', false, true, now(), now()
          where not exists (select 1 from "MembershipTier" where "tenantId" = $2 and lower(trim(name)) = 'mfv adults')`, [`mfvtier${Date.now().toString(36)}`, T]);

// The members CSV upload route needs blob storage or TESTING_MODE, which this harness keeps off on purpose (two-factor
// sign-in stays on). So the file goes through the chunked upload (database storage, the attendance purpose), the job
// row is created as the upload route would, and preview and commit run through the REAL routes from the owner's
// signed-in session — the same calls the panel makes.
async function apiImport(page, mode, exportedAt) {
  const origin = new URL(page.url()).origin;
  const bytes = Buffer.from(csv, "utf8");
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const up = await page.request.post("/api/admin/import/uploads", { data: { purpose: "attendance", fileName: "teamup-memberships.csv", bytes: bytes.length, sha256: sha }, headers: { origin } });
  const u = await up.json();
  if (up.status() !== 201) throw new Error(`upload refused ${up.status()} ${JSON.stringify(u)}`);
  for (let i = 0; i < u.chunkCount; i++) {
    const part = bytes.subarray(i * u.chunkSize, (i + 1) * u.chunkSize);
    const r = await page.request.put(`/api/admin/import/uploads/${u.uploadId}/chunks/${i}`, { data: part, headers: { origin, "x-upload-token": u.token, "content-type": "application/octet-stream" } });
    if (r.status() !== 200) throw new Error(`chunk ${i} refused ${r.status()}`);
  }
  const done = await page.request.post(`/api/admin/import/uploads/${u.uploadId}/complete`, { headers: { origin, "x-upload-token": u.token } });
  if (done.status() !== 200) throw new Error(`complete refused ${done.status()}`);
  const jobId = `mfvjob${Date.now().toString(36)}${mode}`;
  await q(`insert into "ImportJob" (id, "tenantId", "createdById", source, mode, "fileName", "fileBlobUrl", "fileHash", status, "sourceExportedAt", "sourceExportedAtProvenance", "createdAt")
           values ($1, $2, $3, 'teamup', $4, 'teamup-memberships.csv', $5, $6, 'pending', $7, 'owner_stated', now())`,
    [jobId, T, club.owner.id, mode, `db-upload://${u.uploadId}`, `${sha}-${mode}`, exportedAt]);
  const pv = await page.request.post(`/api/admin/import/${jobId}/preview`, { data: {}, headers: { origin } });
  const preview = await pv.json();
  const cm = await page.request.post(`/api/admin/import/${jobId}/commit`, { data: {}, headers: { origin } });
  const commit = await cm.json();
  return { jobId, preview, previewStatus: pv.status(), commit, commitStatus: cm.status() };
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.91.0.11");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner signs in", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // 1. First import: Add people (real preview and commit routes).
  const first = await apiImport(page, "create", "2026-10-20T07:00:00Z");
  L.check("journey", "J2 the preview counts what the import then does: 3 to import, 0 same, 0 to review",
    first.previewStatus === 200 && first.preview.willImport === 3 && first.preview.sameAsMatFlow === 0 && first.commitStatus === 200 && first.commit.imported === 3,
    { preview: { willImport: first.preview.willImport, same: first.preview.sameAsMatFlow, differs: first.preview.toReviewDiffers, uncertain: first.preview.toReviewUncertain }, imported: first.commit.imported });
  const ada = await memberByEmail(E("ada"));
  const cy = await memberByEmail(E("cy"));
  L.check("journey", "J2b the preview says what the commit does with plans: 0 with a plan, 3 without (TeamUp states no price, period or currency)",
    first.preview.willImportWithPlan === 0 && first.preview.willImportWithoutPlan === 3 && first.commit.manifest?.created?.unmatchedPlan === 3
      && (first.preview.planReview ?? []).every((r) => r.reason === "source_has_no_price_facts"),
    { withPlan: first.preview.willImportWithPlan, withoutPlan: first.preview.willImportWithoutPlan, committedWithoutPlan: first.commit.manifest?.created?.unmatchedPlan });
  L.check("journey", "J3 the three people exist with no plan and the file's label kept (an exact name match alone sets none: import and flag)",
    !!ada && ada.membershipTierId === null && ada.membershipType === "Mfv Adults" && !!cy && cy.membershipTierId === null && cy.membershipType === "Mfv Open Mat",
    { adaTier: ada?.membershipTierId, adaLabel: ada?.membershipType, cyTier: cy?.membershipTierId, cyLabel: cy?.membershipType });
  L.check("privacy", "P0 the import's response carries no person's name in its conflict list", !JSON.stringify(first.commit.manifest?.conflicts ?? []).includes("Ada"), first.commit.manifest?.conflicts);

  // 2. Staff edit Ada by hand through the normal member edit (the owner's PATCH route).
  const res = await page.request.patch(`/api/members/${ada.id}`, { data: { status: "inactive" }, headers: { origin: new URL(page.url()).origin } });
  L.check("journey", "J4 the owner sets Ada inactive through the normal member edit", res.status() === 200 && (await memberByEmail(E("ada"))).status === "inactive", res.status());

  // 3. The same file as a Status refresh: lists Ada, changes nobody.
  const refresh = await apiImport(page, "refresh", "2026-10-21T07:00:00Z");
  const adaAfter = await memberByEmail(E("ada"));
  L.check("journey", "J5 the refresh lists Ada as differing and changes nobody: Ada is still inactive, nobody carries the refresh as source",
    refresh.commitStatus === 200 && refresh.commit.toReview >= 1 && adaAfter.status === "inactive" && adaAfter.billingStatusSource !== refresh.jobId,
    { toReview: refresh.commit.toReview, status: adaAfter.status });
  L.note("journey", "N1 not exercised in the browser: the panel's own upload form, preview counts, confirm dialog and 'Check complete' card (members upload needs blob storage or TESTING_MODE; unit-tested only)", "harness limit");

  // 4. The review list from the import history, by keyboard.
  await page.goto("/dashboard/settings?tab=import");
  const reviewBtn = page.getByRole("button", { name: /^Review \d+ (person|people)$/ }).first();
  await reviewBtn.waitFor({ timeout: 30000 });
  await reviewBtn.focus();
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
  // Forced failure first: the list's request fails, an error with a retry appears.
  await page.route("**/api/admin/import/*/conflicts", (r) => r.abort("failed"));
  await page.keyboard.press("Enter");
  const errAlert = page.getByText("Couldn't load the people to review");
  const sawErr = await errAlert.first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-load", "F1 the review list's load fails: an error with a retry, never an empty list", sawErr && (await page.getByTestId("import-review-empty").count()) === 0, { focused });
  await page.unroute("**/api/admin/import/*/conflicts");
  let loads = 0;
  page.on("request", (r) => { if (/\/api\/admin\/import\/[^/]+\/conflicts$/.test(new URL(r.url()).pathname)) loads++; });
  await page.getByRole("button", { name: /try again|retry/i }).first().click();
  const list = page.getByTestId("import-review-list").first();
  await list.waitFor({ timeout: 30000 });
  const listText = await page.getByTestId("import-review").first().textContent();
  L.check("retry", "R1 retry sends one request and shows Ada with the file's value and MatFlow's current one",
    loads === 1 && /Ada Field/.test(listText ?? "") && /file says active; MatFlow now inactive/.test(listText ?? ""), { loads, text: (listText ?? "").slice(0, 200) });
  await shot(page, "import-review-list");

  // 5. Follow Ada's link to her normal page.
  await page.getByRole("link", { name: "Ada Field" }).first().click();
  await page.waitForURL(/\/dashboard\/members\//, { timeout: 30000 });
  L.check("journey", "J8 the person's link opens their normal member page (the authorised edit)", page.url().includes(`/dashboard/members/${ada.id}`), new URL(page.url()).pathname);

  // 6. The first import's list shows everyone it created as imported without a plan, with the file's label and why.
  await page.goto("/dashboard/settings?tab=import");
  const buttons = page.getByRole("button", { name: /^Review \d+ (person|people)$/ });
  await buttons.first().waitFor({ timeout: 30000 });
  const n = await buttons.count();
  await buttons.nth(n - 1).click(); // the oldest job: the first import
  const without = page.getByTestId("import-review-without-plan").first();
  const sawWithout = await without.waitFor({ timeout: 30000 }).then(() => true, () => false);
  const withoutText = (await without.textContent().catch(() => "")) ?? "";
  L.check("journey", "J9 the first import lists Ada, Ben and Cy as imported without a plan, with the file's label, the reason and the plan-restricted sentence",
    sawWithout && /Ada Field/.test(withoutText) && /Ben Gale/.test(withoutText) && /Cy Holt/.test(withoutText) && /file says Mfv Open Mat/.test(withoutText)
      && /no price, billing period or currency/.test(withoutText) && /Plan-restricted classes may refuse them until staff assign a plan\./.test(withoutText),
    { buttons: n, text: withoutText.slice(0, 300) });

  // 7. Ada is deleted: the refresh's review list shows no name or values for her.
  // The member page's delete: a confirmed second call (the first, unconfirmed call is only a probe).
  const t0 = Date.now();
  const del = await page.request.delete(`/api/members/${ada.id}?confirm=1`, { headers: { origin: new URL(page.url()).origin }, timeout: 120000 });
  L.note("privacy", "N2 member delete response", { status: del.status(), ms: Date.now() - t0, body: (await del.text()).slice(0, 160) });
  await page.goto("/dashboard/settings?tab=import");
  await page.getByRole("button", { name: /^Review \d+ (person|people)$/ }).first().click({ timeout: 60000 }).catch(async (e) => { await shot(page, "import-review-after-delete"); throw e; });
  const afterDel = page.getByTestId("import-review").first();
  await afterDel.getByText(/since deleted|Nobody is left/).first().waitFor({ timeout: 30000 }).catch(() => {});
  const afterText = (await afterDel.textContent()) ?? "";
  L.check("privacy", "P1 after Ada is deleted, the review list shows no name or value of hers",
    del.status() < 300 && !/Ada Field/.test(afterText), { del: del.status(), text: afterText.slice(0, 160) });

  // 8. Phone width.
  const phone = await context(browser, "10.91.0.12", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/dashboard/settings?tab=import");
  await p2.waitForLoadState("load");
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 the import tab at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  const rb = p2.getByRole("button", { name: /^Review \d+ (person|people)$/ }).first();
  const box = await rb.boundingBox().catch(() => null);
  L.note("mobile", "M2 Review button size at 390 px", box);
  await shot(p2, "import-review-phone");

  L.check("errors", "E1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`ledger: ${L.summary()}  →  ${L.path}`);
}
