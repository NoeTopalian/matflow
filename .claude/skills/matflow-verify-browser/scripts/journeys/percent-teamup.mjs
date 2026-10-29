// Journey: counts beside percentages (G1) and the TeamUp label (G2), 27 Oct 2026.
// Seeds 8 trials run by the fixture owner (2 converted and still active, 1 lost, 5 still deciding) and one member billed
// by TeamUp, then checks the Reports funnel, /dashboard/attribution and the member profile at desktop and 390 px.
//   node journeys/percent-teamup.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("percent-teamup");
const errors = [];
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// ── Seed ────────────────────────────────────────────────────────────────────
const owner = (await q(`select id from "User" where "tenantId" = $1 and lower(email) = lower($2)`, [club.tenantId, club.owner.email]))[0];
if (!owner) throw new Error("fixture owner not found");
const mk = async (name, status) => {
  const id = randomUUID();
  await q(`insert into "Member" (id, "tenantId", email, name, status, "trialRunById", "waiverAccepted", "onboardingCompleted", "updatedAt")
           values ($1, $2, $3, $4, $5, $6, true, true, now())`,
    [id, club.tenantId, `pt-${id.slice(0, 8)}@example.test`, name, status, owner.id]);
  return id;
};
const event = (memberId, from, to) => q(`insert into "MemberStatusEvent" (id, "tenantId", "memberId", "fromStatus", "toStatus", reason, "changedById")
  values ($1, $2, $3, $4, $5, 'staff_edit', $6)`, [randomUUID(), club.tenantId, memberId, from, to, owner.id]);
for (let i = 1; i <= 2; i++) await event(await mk(`PT Converted ${i}`, "active"), "taster", "active");
await event(await mk("PT Lost", "cancelled"), "taster", "cancelled");
for (let i = 1; i <= 5; i++) await mk(`PT Deciding ${i}`, "taster");
const teamupId = randomUUID();
const importedAt = new Date("2026-10-03T10:00:00Z");
await q(`insert into "Member" (id, "tenantId", email, name, status, "billedBy", "billingStatusAsOf", "waiverAccepted", "onboardingCompleted", "updatedAt")
         values ($1, $2, $3, 'PT TeamUp Billed', 'active', 'teamup', $4, true, true, now())`,
  [teamupId, club.tenantId, `pt-teamup-${teamupId.slice(0, 8)}@example.test`, importedAt]);
// Expected: trials 8, converted 2 (25%), retained 2 of 2 (100%).
const CONVERSION = "25% (2 of 8)";
// W3 (owner decision, 27 Oct 2026, 23:30): the drop-offs name their base, and
// each coach's lost and no-decision counts carry their share of the trials.
const LOST_SHARE = "13% (1 of 8) of trials"; // 12.5, half-up
const UNDECIDED_SHARE = "63% (5 of 8) of trials"; // 62.5, half-up
const COACH_LOST = /Lost ?13% \(1 of 8\)/;
const COACH_UNDECIDED = /No decision ?63% \(5 of 8\)/;
const ACTIVE_DETAIL = /Includes \d+ on hold · \d+% of \d+ active · \d+% of \d+ current members/;
const TEAMUP = "Billed by TeamUp · imported 3 Oct 2026";
L.note("seed", "N1 seeded 8 trials (2 converted, 1 lost, 5 deciding) and one TeamUp-billed member", { expectedConversion: CONVERSION, teamup: TEAMUP });

const noHScroll = (p) => p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.97.0.1", { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);

  // Reports: the funnel's conversion rate carries its counts.
  await page.goto("/dashboard/reports");
  await page.waitForLoadState("load");
  await page.getByText(/of trials|Trials run/).first().waitFor({ timeout: 60000 }).catch(() => {});
  const reportsText = norm(await page.locator("main").innerText({ timeout: 60000 }));
  L.check("reports", "G1a the Reports conversion funnel shows the rate with its counts, \"25% (2 of 8)\"", reportsText.includes(CONVERSION),
    { found: reportsText.includes(CONVERSION), around: reportsText.slice(Math.max(0, reportsText.indexOf("25%") - 80), reportsText.indexOf("25%") + 80) });
  L.check("reports", "G1b no bare percentage without counts in the funnel (no \"25.0%\" or \"25%\" alone)", !/\b25\.0%/.test(reportsText) && !/25%(?! \(2 of 8\))/.test(reportsText),
    { matches: reportsText.match(/25(\.0)?%.{0,14}/g) });
  L.check("reports", `W3a the funnel drop-offs name their base: "${LOST_SHARE}", "${UNDECIDED_SHARE}"`,
    reportsText.includes(LOST_SHARE) && reportsText.includes(UNDECIDED_SHARE),
    { lost: reportsText.includes(LOST_SHARE), undecided: reportsText.includes(UNDECIDED_SHARE) });
  L.check("reports", "W3b the coach row gives lost and no decision as shares of the coach's trials",
    COACH_LOST.test(reportsText) && COACH_UNDECIDED.test(reportsText),
    { around: reportsText.slice(Math.max(0, reportsText.search(/Lost ?\d/) - 60), reportsText.search(/Lost ?\d/) + 80) });
  L.check("reports", "W3c the Active members tile gives on hold and active as shares of named populations",
    ACTIVE_DETAIL.test(reportsText), { match: reportsText.match(/Includes \d+ on hold.{0,80}/)?.[0] });
  await shot(page, "percent-teamup-reports");

  // The attribution page: the same funnel and the per-coach table.
  await page.goto("/dashboard/attribution");
  await page.waitForLoadState("load");
  // The page streams in behind skeletons: wait for the funnel itself.
  await page.getByText(/of trials|Trials run/).first().waitFor({ timeout: 60000 }).catch(() => {});
  const attrText = norm(await page.locator("main").innerText({ timeout: 60000 }));
  L.check("attribution", "G1c /dashboard/attribution shows the conversion rate with its counts", attrText.includes(CONVERSION),
    { around: attrText.slice(Math.max(0, attrText.indexOf("25%") - 80), attrText.indexOf("25%") + 80) });
  const overflow = await page.evaluate(() => [...document.querySelectorAll("main *")].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "hidden").length);
  L.note("attribution", "N2 elements clipping text horizontally at 1280 px (widened rate column)", overflow);
  await shot(page, "percent-teamup-attribution");

  // CSV: the funnel rows read the same.
  await page.goto("/dashboard/reports");
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Export CSV" }).click()]);
  const fs = await import("node:fs");
  const csv = fs.readFileSync(await dl.path(), "utf8");
  L.check("csv", "G1d the Reports CSV funnel rows carry the same \"25% (2 of 8)\"", csv.includes(CONVERSION), { lines: csv.split("\n").filter((l) => l.startsWith("Conversion funnel")).slice(0, 6) });
  L.check("csv", "W3d the CSV drop-off and coach rows read as the screen does",
    csv.includes(`Lost before joining,1,${LOST_SHARE}`) && csv.includes(`No decision recorded,5,${UNDECIDED_SHARE}`)
      && csv.includes("lost 13% (1 of 8) · no decision 63% (5 of 8)") && ACTIVE_DETAIL.test(csv),
    { lines: csv.split("\n").filter((l) => /^(Conversion|Summary,Active members)/.test(l)).slice(0, 10) });

  // G2: the member profile label.
  await page.goto(`/dashboard/members/${teamupId}`);
  await page.waitForLoadState("load");
  // The profile streams in after "load"; read it once the header has arrived (it read the loading state under load).
  await page.getByTestId("billing-source-label").first().waitFor({ timeout: 60000 }).catch(() => {});
  const profileText = norm(await page.locator("main").innerText({ timeout: 60000 }));
  L.check("teamup", "G2a the member profile reads \"Billed by TeamUp · imported 3 Oct 2026\", no \"status as of\" and no staleness warning",
    profileText.includes(TEAMUP) && !/status as of/i.test(profileText) && !/stale|out of date|may be out of date/i.test(profileText),
    { found: profileText.includes(TEAMUP), statusAsOf: /status as of/i.test(profileText) });
  await shot(page, "percent-teamup-profile");

  // Phone width.
  const phone = await context(browser, "10.97.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/reports", "/dashboard/attribution", `/dashboard/members/${teamupId}`]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    await p2.waitForTimeout(1500);
    const m = await noHScroll(p2);
    L.check("mobile", `M1 ${path.replace(teamupId, "<member>")} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `percent-teamup-mobile${path.replace(teamupId, "member").replace(/\//g, "-")}`);
  }
  const mText = norm(await p2.locator("main").innerText());
  L.check("mobile", "M2 the TeamUp label is shown in full at 390 px", mText.includes(TEAMUP), { found: mText.includes(TEAMUP) });
  await p2.goto("/dashboard/attribution");
  await p2.getByText(/of trials|Trials run/).first().waitFor({ timeout: 60000 }).catch(() => {});
  const aText = norm(await p2.locator("main").innerText({ timeout: 60000 }));
  L.check("mobile", "M3 the attribution funnel's counts are visible at 390 px", aText.includes(CONVERSION), { found: aText.includes(CONVERSION) });
  L.check("mobile", "M4 the drop-off shares and the coach row shares are visible at 390 px",
    aText.includes(LOST_SHARE) && aText.includes(UNDECIDED_SHARE) && COACH_LOST.test(aText) && COACH_UNDECIDED.test(aText),
    { lost: aText.includes(LOST_SHARE), coachLost: COACH_LOST.test(aText) });

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
