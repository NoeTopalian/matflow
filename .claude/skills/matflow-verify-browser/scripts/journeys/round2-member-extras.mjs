// Round 2 review (10 Nov 2026): the staff member profile's optional extras on a
// synthetic club. A member with no comp class and no 2FA shows neither card and
// no "couldn't be loaded" notice (genuinely absent). A member with both shows
// the roster to every staff role and the Reset 2FA card only to owner and
// manager. The server-read FAILURE state can't be caused from a browser and is
// not exercised here (unit tests cover it).
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round2-member-extras");
const tenantId = club.tenantId;
const errors = [];
const TAG = randomUUID().slice(0, 6);
const members = await q(`select id, name from "Member" where "tenantId" = $1 order by name`, [tenantId]);
const withExtras = members.find((m) => m.name === "Member 1");
const without = members.find((m) => m.name === "Member 2");
if (!withExtras || !without) throw new Error("fixture lacks Member 1 / Member 2");

const classId = randomUUID();
const rosterId = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 20)`, [classId, tenantId, `Comp Squad ${TAG}`]);
await q(`insert into "ClassRoster" (id, "tenantId", "classId", "memberId") values ($1, $2, $3, $4)`, [rosterId, tenantId, classId, withExtras.id]);
await q(`update "Member" set "totpEnabled" = true where id = $1 and "tenantId" = $2`, [withExtras.id, tenantId]);
await q(`update "Member" set "totpEnabled" = false where id = $1 and "tenantId" = $2`, [without.id, tenantId]);

const sections = async (page, id) => {
  await page.goto(`/dashboard/members/${id}`);
  await page.getByText(id === withExtras.id ? "Member 1" : "Member 2").first().waitFor({ timeout: 60000 });
  await page.waitForLoadState("networkidle");
  return {
    roster: await page.getByText("Comp class memberships").count(),
    rosterClass: await page.getByText(`Comp Squad ${TAG}`).count(),
    twoFactor: await page.getByText("Two-factor authentication", { exact: true }).count(),
    unavailable: await page.getByTestId("member-extras-unavailable").count(),
  };
};

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "198.18.43.1");
  const owner = await ctx.newPage();
  owner.on("pageerror", (e) => errors.push(String(e)));
  await ownerSignIn(owner, club);

  const absent = await sections(owner, without.id);
  L.check("absent", "E1 owner, member with no comp class and no 2FA: no roster card, no 2FA card, no 'couldn't be loaded' notice", absent.roster === 0 && absent.twoFactor === 0 && absent.unavailable === 0, absent);
  await shot(owner, "round2-extras-absent-owner");

  const present = await sections(owner, withExtras.id);
  L.check("present", "E2 owner, member with both: roster card names the class, 2FA card shows, no notice", present.roster === 1 && present.rosterClass >= 1 && present.twoFactor === 1 && present.unavailable === 0, present);
  L.check("present", "E2b the owner's 2FA card has the reset control", (await owner.getByRole("button", { name: /reset/i }).count()) >= 1, {});
  await shot(owner, "round2-extras-present-owner");

  for (const role of ["manager", "coach"]) {
    const user = await seedStaff(club, role);
    const c = await context(browser, role === "manager" ? "198.18.43.2" : "198.18.43.3");
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await staffSignIn(p, club, user);
    const s = await sections(p, withExtras.id);
    if (role === "manager") {
      L.check("roles", "E3 manager: roster and 2FA card both shown", s.roster === 1 && s.twoFactor === 1 && s.unavailable === 0, s);
    } else {
      L.check("roles", "E4 coach: roster shown, 2FA card withheld (only owner and manager can reset)", s.roster === 1 && s.twoFactor === 0 && s.unavailable === 0, s);
      await shot(p, "round2-extras-present-coach");
    }
  }

  const ph = await context(browser, "198.18.43.4", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await ph.newPage();
  await ownerSignIn(pp, club);
  const ps = await sections(pp, withExtras.id);
  const m = await pp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 phone 390 px: both cards shown, no horizontal scroll", ps.roster === 1 && ps.twoFactor === 1 && m.scroll <= m.width + 1, { ...ps, ...m });

  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  await q(`delete from "ClassRoster" where id = $1 and "tenantId" = $2`, [rosterId, tenantId]).catch(() => {});
  await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]).catch(() => {});
  await q(`update "Member" set "totpEnabled" = false where id = $1 and "tenantId" = $2`, [withExtras.id, tenantId]).catch(() => {});
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
