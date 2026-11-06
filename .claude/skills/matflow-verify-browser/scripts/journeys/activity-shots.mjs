// Activity page screenshots at 1440, 930 and 390, with rows that carry several changes (synthetic data only).
//   SHOT_TAG=before|after node run-journeys.mjs activity-shots
// Runs against any build that has the Activity page (it only reads it), so the same script makes the "before" set
// on a build of main and the "after" set on a branch. Screenshots are the top of the page, as a person first sees it.
import { chromium, state, q, ledger, context, ownerSignIn, OUT } from "../lib.mjs";
import { seedActivity, ready, visit, id, noSideScroll } from "./activity-seed.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const TAG = (process.env.SHOT_TAG ?? "after").replace(/[^a-z0-9-]/gi, "");
const L = ledger(`activity-shots-${TAG}`);
const errors = [];

const browser = await chromium.launch();
try {
  const desk = await context(browser, "10.94.7.1");
  const main = await desk.newPage();
  await ownerSignIn(main, club);
  const s = await seedActivity(main, club, "Shots Gi");
  const now = Date.now();
  const rows = [
    // A plan edit with three changes, as Noe photographed it.
    ["membership.tier.update", "MembershipTier", s.tierNew, s.owner, { changes: { isKids: { from: false, to: true }, pricePence: { from: 3000, to: 3500 }, maxClassesPerWeek: { from: null, to: 1 } } }, 60_000],
    // A member edit with four changes and a reason.
    ["member.update", "Member", s.mel.id, s.owner, { fields: ["emergencyContactName", "emergencyContactPhone", "emergencyContactRelation", "dateOfBirth"], changes: { emergencyContactName: { from: "Jo Orekoya", to: "Sam Orekoya" }, emergencyContactPhone: { from: "07700 900001", to: "07700 900002" }, emergencyContactRelation: { from: "sister", to: "brother" }, dateOfBirth: { from: "1990-01-02", to: "1990-02-01" } }, reason: "Corrected at the front desk" }, 90_000],
  ];
  await q(
    `insert into "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", metadata, "createdAt") values ${rows.map((_, i) => `($${i * 7 + 1}, $${rows.length * 7 + 1}, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}::jsonb, $${i * 7 + 7})`).join(", ")}`,
    [...rows.flatMap(([action, entityType, entityId, userId, metadata, ago]) => [id(), userId, action, entityType, entityId, JSON.stringify(metadata), new Date(now - ago)]), s.tenantId],
  );

  const shots = {};
  for (const [width, height, opts] of [
    [1440, 1000, {}],
    [930, 1100, {}],
    [390, 844, { isMobile: true, hasTouch: true }],
  ]) {
    const ctx = await context(browser, `10.94.7.${width === 1440 ? 2 : width === 930 ? 3 : 4}`, { viewport: { width, height }, storageState: await desk.storageState(), ...opts });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await visit(page, "/dashboard/activity?types=all");
      await ready(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      const file = `${OUT}/activity-${TAG}-${width}.png`;
      await page.screenshot({ path: file });
      shots[width] = file;
      L.check(`shot-${width}`, `Activity at ${width}px (${TAG}), no sideways scroll`, await noSideScroll(page), file);
    } finally {
      await ctx.close();
    }
  }
  L.note("files", "screenshots", shots);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
