// Round 3 (10 Nov 2026): what the owner sees on the synthetic club.
// T1 the dashboard's date is the CLUB's today. The fixture club's zone is set
//    for the run to one whose date differs from UTC's right now (Pago Pago,
//    UTC-11, before 11:00 UTC; Kiritimati, UTC+14, from 10:00 UTC), and
//    restored afterwards.
// R1 Settings → Revenue names each figure plainly: "Collected this month",
//    "This month × 12 · not a forecast", "Per active member"; never "Annual
//    Run Rate" or "projected". Desktop and phone width.
// A1 Analysis says "rules-based", never "MatFlow AI".
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round3-labels-today");
const tenantId = club.tenantId;
const errors = [];

const now = new Date();
const zone = now.getUTCHours() < 10 ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";
const clubDate = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: zone });
const utcDate = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const [{ timezone: originalZone }] = await q(`select timezone from "Tenant" where id = $1`, [tenantId]);
await q(`update "Tenant" set timezone = $2 where id = $1`, [tenantId, zone]);

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "198.18.53.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(page, club);

  await page.goto("/dashboard");
  await page.getByText(/Today at /).first().waitFor({ timeout: 60000 });
  const shown = { clubDate: await page.getByText(clubDate, { exact: true }).count(), utcDate: await page.getByText(utcDate, { exact: true }).count() };
  L.check("today", `T1 dashboard date is the club's today (${zone}: ${clubDate}), not UTC's (${utcDate})`, clubDate !== utcDate && shown.clubDate >= 1 && shown.utcDate === 0, { zone, clubDate, utcDate, ...shown });
  await shot(page, "round3-dashboard-club-today");

  const revenue = async (p) => {
    await p.goto("/dashboard/settings?tab=revenue");
    await p.getByText("Collected this month").first().waitFor({ timeout: 60000 });
    return {
      collected: await p.getByText("Collected this month").count(),
      times12: await p.getByText("This month × 12").count(),
      notForecast: await p.getByText(/not a forecast/).count(),
      perMember: await p.getByText("Per active member").count(),
      arr: await p.getByText(/Annual Run Rate/).count(),
      projected: await p.getByText(/^projected$/).count(),
    };
  };
  const r = await revenue(page);
  L.check("revenue", "R1 revenue cards name each figure; no 'Annual Run Rate' or 'projected'", r.collected >= 1 && r.times12 >= 1 && r.notForecast >= 1 && r.perMember >= 1 && r.arr === 0 && r.projected === 0, r);
  await shot(page, "round3-revenue-labels");

  await page.goto("/dashboard/analysis");
  await page.getByText(/rules-based/).first().waitFor({ timeout: 60000 });
  const a = { rules: await page.getByText(/rules-based/).count(), ai: await page.getByText(/MatFlow AI|The AI will ask/).count() };
  L.check("analysis", "A1 Analysis says rules-based and never 'MatFlow AI'", a.rules >= 1 && a.ai === 0, a);

  const ph = await context(browser, "198.18.53.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  pp.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(pp, club);
  const rp = await revenue(pp);
  const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 phone 390 px: revenue labels shown, no horizontal scroll", rp.collected >= 1 && rp.times12 >= 1 && rp.arr === 0 && m.scroll <= m.width + 1, { ...rp, ...m });
  await shot(pp, "round3-revenue-labels-phone");

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await q(`update "Tenant" set timezone = $2 where id = $1`, [tenantId, originalZone]).catch(() => {});
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
