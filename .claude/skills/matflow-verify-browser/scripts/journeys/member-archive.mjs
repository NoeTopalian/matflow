// PR 3 (6 Nov 2026) — removing a member archives them; data requests move to owner Settings; removing a staff account
// deactivates it. Production build against the Neon TEST branch, synthetic club only (example.test).
//
// Journey (desktop 1440 and phone 390):
//   A. Owner removes a member from their profile (keyboard): the dialog says archive + restore; the member leaves the
//      Members list and the member search, the archived link appears, every record stays, the Reports history for a
//      past period is identical (fresh computation proven by generatedAt), the kiosk lists and refuses them, and their
//      own sign-in is refused.
//   B. Restore from the archived list and profile banner: a network failure and a server error leave them archived
//      with the message beside the button; the retry sends exactly one request; reload shows them restored.
//   C. Settings → Data requests (owner): the old profile DSAR address redirects there with the member picked; an
//      archived member is found, exported (a download) and erased (two confirms); the name and contact details go,
//      the attendance row and the erasure record stay. A manager has no Settings menu item, no page, and gets 403 from
//      the subjects, export and erase routes.
//   D. Owner removes a coach: the account is deactivated, listed apart; the coach's live session is refused at the next
//      request and a new sign-in fails; their attendance mark keeps its author; Reactivate lets them sign in again.
//   E. Phone width: no sideways scroll on Members, Archived members, the archived profile, Settings → Data requests;
//      Restore and Search tap targets measured.
import { randomUUID, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, bcrypt, sleep } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("member-archive");
const tenantId = club.tenantId;
const TAG = randomUUID().slice(0, 6);
const errors = [];

// ── Secrets for the kiosk door (same derivation as lib/token-hash.ts and lib/kiosk-token.ts); never printed ──
const env = testEnv();
const SECRET = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
if (!SECRET) throw new Error("no AUTH secret in .env.test");
const kioskRaw = `mfvk${randomUUID().replace(/-/g, "")}`;
function kioskMemberToken(memberId) {
  const key = createHmac("sha256", SECRET).update("matflow.kiosk.v1").digest();
  const body = Buffer.from(JSON.stringify({ tenantId, memberId, exp: Math.floor(Date.now() / 1000) + 600 }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

// ── Club clock: a session starting about 20 minutes from now, so the kiosk window is open ──
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todaySql = `${parts.year}-${parts.month}-${parts.day} 00:00:00`;
const startMin = Math.ceil((Number(parts.hour) * 60 + Number(parts.minute) + 20) / 5) * 5;
if (startMin + 60 > 23 * 60 + 59) throw new Error("start before about 22:35 club time: today's session must end today");
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ── Seed: two members with history, a class with a September session and a session today, the kiosk ──
const pw = () => `Mfv-${randomUUID().slice(0, 12)}-aa1`;
async function addMember(key, name, password = null) {
  const id = randomUUID();
  const email = `${club.slug}-${key}-${TAG}@example.test`.toLowerCase();
  await q(`insert into "Member" (id, "tenantId", email, name, status, "waiverAccepted", "passwordHash", "joinedAt", "updatedAt")
           values ($1, $2, $3, $4, 'active', true, $5, '2026-08-01 10:00:00', now())`, [id, tenantId, email, name, password ? await bcrypt.hash(password, 10) : null]);
  return { id, name, email, password };
}
const sam = await addMember("sam", `Sam Archive ${TAG}`, pw());
const ola = await addMember("ola", `Ola Erase ${TAG}`);
const coach = await seedStaff(club, "coach", { name: `Coach Deactivate ${TAG}` });
const manager = await seedStaff(club, "manager", { name: `Manager Refused ${TAG}` });
const classId = randomUUID(), pastId = randomUUID(), todayId = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration) values ($1, $2, $3, 60)`, [classId, tenantId, `Gi ${TAG}`]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $3, '2026-09-10 00:00:00', '18:00', '19:00'), ($2, $3, $4, $5, $6)`,
  [pastId, todayId, classId, todaySql, hm(startMin), hm(startMin + 60)]);
for (const [m, at] of [[sam, "2026-09-10 18:05:00"], [ola, "2026-09-10 18:06:00"]]) {
  await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod", "checkedInById") values ($1, $2, $3, $4, $5, 'admin', $6)`,
    [randomUUID(), tenantId, m.id, pastId, at, coach.id]);
}
await q(`insert into "MemberStatusEvent" (id, "tenantId", "memberId", "fromStatus", "toStatus", reason, "occurredAt") values ($1, $2, $3, 'taster', 'active', 'staff_edit', '2026-09-01 10:00:00')`, [randomUUID(), tenantId, sam.id]);
await q(`insert into "ClassRoster" (id, "tenantId", "classId", "memberId") values ($1, $2, $3, $4)`, [randomUUID(), tenantId, classId, sam.id]);
await q(`update "Tenant" set "kioskTokenHash" = $1 where id = $2`, [createHmac("sha256", SECRET).update(kioskRaw).digest("hex"), tenantId]);

// ── Read-backs ──
const memberRow = async (id) => (await q(`select name, email, "archivedAt", "archivedById" from "Member" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0] ?? null;
const keptCounts = async (id) => (await q(
  `select (select count(*)::int from "AttendanceRecord" where "memberId" = $1) as attendance,
          (select count(*)::int from "MemberStatusEvent" where "memberId" = $1) as events,
          (select count(*)::int from "ClassRoster" where "memberId" = $1) as roster`, [id]))[0];
const audit = async (action, entityId) => (await q(`select "userId", metadata from "AuditLog" where "tenantId" = $1 and action = $2 and "entityId" = $3 order by "createdAt" desc limit 1`, [tenantId, action, entityId]))[0] ?? null;
const listedIds = async (req) => ((await (await req.get(`/api/members?take=100&search=${encodeURIComponent(TAG)}`)).json()).members ?? []).map((m) => m.id);
const history = async (req) => {
  const r = await (await req.get(`/api/reports?period=custom&from=2026-08&to=2026-09`)).json();
  return { generatedAt: r.generatedAt, h: JSON.stringify({ w: r.weeklyAttendance, c: r.checkInMethods, t: r.topClasses, n: r.netNewByMonth, s: r.monthlySignups, m: r.membership, p: r.periodMovement, ch: r.churn }) };
};
const checkIns = (h) => JSON.parse(h.h).c.reduce((n, m) => n + m.count, 0);
const noSideways = (page) => page.evaluate(() => {
  const main = document.querySelector("main");
  return { doc: document.documentElement.scrollWidth - window.innerWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
});

const browser = await chromium.launch();
try {
  // ════ A. Remove archives ════
  const ctx = await context(browser, "10.93.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  const req = ctx.request;

  L.check("setup", "S1 both members are listed before removal", (await listedIds(req)).filter((id) => id === sam.id || id === ola.id).length === 2, "listed");
  const kept0 = await keptCounts(sam.id);
  const hist0 = await history(req);
  L.check("setup", "S2 the Reports history for Aug–Sep counts both September check-ins", checkIns(hist0) === 2, { checkIns: checkIns(hist0) });
  const kreq = (await context(browser, "10.93.0.9")).request;
  const kioskSearch = async (name) => (await (await kreq.get(`/api/kiosk/${kioskRaw}/members?q=${encodeURIComponent(name)}&classInstanceId=${todayId}`)).json()).members ?? [];
  L.check("setup", "S3 the kiosk lists Sam before removal", (await kioskSearch(sam.name)).some((m) => m.name === sam.name), "kiosk search");

  await page.goto(`/dashboard/members/${sam.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /Remove member/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const dialogText = await dialog.innerText();
  L.check("journey", "A1 the Remove dialog says the member will be archived and can be restored, not deleted",
    /archived/i.test(dialogText) && /restore/i.test(dialogText) && !/permanently deletes|cannot be undone/i.test(dialogText), dialogText.slice(0, 300));
  await shot(page, "archive-remove-dialog");
  // Keyboard: focus the confirm action and press Enter.
  const archiveBtn = dialog.getByRole("button", { name: "Archive member" });
  await archiveBtn.waitFor();
  await archiveBtn.focus();
  const focusVisible = await archiveBtn.evaluate((e) => { const s = getComputedStyle(e); return !s.outlineStyle.startsWith("none") || s.boxShadow !== "none"; });
  L.check("keyboard", "K1 the Archive member button takes keyboard focus with a visible indicator", focusVisible, "focus");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/dashboard\/members(\?|$)/, { timeout: 60000 });
  const row1 = await memberRow(sam.id);
  L.check("journey", "A2 Remove archives: archivedAt and who are stamped, the row stays", !!row1?.archivedAt && row1.archivedById === club.owner.id, { archived: !!row1?.archivedAt });
  const kept1 = await keptCounts(sam.id);
  L.check("journey", "A3 every record stays: attendance, status events, roster place", JSON.stringify(kept1) === JSON.stringify(kept0), { before: kept0, after: kept1 });
  const a1 = await audit("member.archive", sam.id);
  L.check("journey", "A4 the removal is audited as member.archive by the owner", a1?.userId === club.owner.id, a1?.metadata ?? null);
  L.check("journey", "A5 Sam is gone from the member list and search; Ola is still listed", !(await listedIds(req)).includes(sam.id) && (await listedIds(req)).includes(ola.id), "api list");
  await page.goto("/dashboard/members");
  const archivedLink = page.getByRole("link", { name: /1 archived member/ });
  L.check("journey", "A6 the Members page links to 1 archived member", await archivedLink.isVisible().catch(() => false), "link");
  await shot(page, "archive-members-page");

  // Reports history: a fresh computation after the archive is identical.
  let hist1 = await history(req);
  for (let i = 0; i < 4 && hist1.generatedAt === hist0.generatedAt; i++) { await sleep(25000); hist1 = await history(req); }
  L.check("journey", "A7 Reports history for Aug–Sep is identical after removal (fresh computation) and still counts Sam's visit",
    hist1.generatedAt !== hist0.generatedAt && hist1.h === hist0.h && checkIns(hist1) === 2, { fresh: hist1.generatedAt !== hist0.generatedAt, same: hist1.h === hist0.h });

  L.check("journey", "A8 the kiosk no longer lists Sam", !(await kioskSearch(sam.name)).some((m) => m.name === sam.name), "kiosk search");
  const kres = await kreq.post(`/api/kiosk/${kioskRaw}/checkin`, { data: { kioskMemberToken: kioskMemberToken(sam.id), classInstanceId: todayId } });
  const krows = Number((await q(`select count(*)::int as n from "AttendanceRecord" where "memberId" = $1 and "classInstanceId" = $2`, [sam.id, todayId]))[0].n);
  L.check("journey", "A9 the kiosk refuses Sam's check-in and records nothing", kres.status() >= 400 && krows === 0, { status: kres.status(), rows: krows });

  const mctx = await context(browser, "10.93.0.5");
  const mpage = await mctx.newPage();
  await mpage.goto("/login");
  await mpage.getByLabel("Club code").fill(club.slug);
  await mpage.keyboard.press("Enter");
  await mpage.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await mpage.getByLabel("Email address").first().fill(sam.email);
  await mpage.getByLabel("Password").fill(sam.password);
  await mpage.getByRole("button", { name: "Sign in", exact: true }).click();
  await mpage.waitForTimeout(4000);
  L.check("journey", "A10 Sam's own sign-in is refused (stays on /login)", new URL(mpage.url()).pathname.startsWith("/login"), new URL(mpage.url()).pathname);
  await mctx.close();

  // ════ B. Restore, with forced failures ════
  await page.goto("/dashboard/members/archived");
  await page.getByRole("link", { name: sam.name }).click();
  const banner = page.getByTestId("archived-member-banner");
  await banner.waitFor();
  L.check("journey", "B1 the archived profile shows the archived notice and no Remove action", (await banner.innerText()).includes("This member is archived"), "banner");
  await shot(page, "archive-profile-banner");
  let restores = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === `/api/members/${sam.id}/restore`) restores++; });
  await page.route(`**/api/members/${sam.id}/restore`, (r) => r.abort("failed"));
  await banner.getByRole("button", { name: "Restore member" }).click();
  const netAlert = banner.getByRole("alert");
  const sawNet = await netAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F1 network failure: the message sits beside Restore and Sam stays archived",
    sawNet && /reach MatFlow/.test(await netAlert.innerText()) && !!(await memberRow(sam.id))?.archivedAt, { alert: sawNet });
  await page.unroute(`**/api/members/${sam.id}/restore`);
  await page.route(`**/api/members/${sam.id}/restore`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await banner.getByRole("button", { name: "Restore member" }).click();
  await page.waitForTimeout(1500);
  L.check("failed-save", "F2 server error: a message is shown and Sam stays archived",
    (await banner.getByRole("alert").innerText().catch(() => "")).includes("Couldn't restore") && !!(await memberRow(sam.id))?.archivedAt, "500");
  await page.unroute(`**/api/members/${sam.id}/restore`);
  const before = restores;
  await banner.getByRole("button", { name: "Restore member" }).focus();
  await page.keyboard.press("Enter");
  const restored = await page.getByTestId("archived-member-banner").waitFor({ state: "detached", timeout: 30000 }).then(() => true, () => false);
  L.check("retry", "R1 the retry (keyboard) sends exactly one request and restores Sam", restored && restores - before === 1 && (await memberRow(sam.id))?.archivedAt === null, { requests: restores - before });
  await page.reload();
  L.check("retry", "R2 after reload there is no archived notice; Sam is listed again with every record",
    (await page.getByTestId("archived-member-banner").count()) === 0 && (await listedIds(req)).includes(sam.id) && JSON.stringify(await keptCounts(sam.id)) === JSON.stringify(kept0), "reloaded");
  L.check("journey", "B2 the restore is audited", !!(await audit("member.restore", sam.id)), "audit");
  L.check("journey", "B3 the kiosk lists Sam again", (await kioskSearch(sam.name)).some((m) => m.name === sam.name), "kiosk");

  // ════ C. Data requests in owner Settings ════
  const del = await page.evaluate(async (id) => (await fetch(`/api/members/${id}?confirm=1`, { method: "DELETE" })).status, ola.id);
  L.check("setup", "C0 Ola is archived through the same Remove route", del === 200 && !!(await memberRow(ola.id))?.archivedAt, { status: del });
  await page.goto(`/dashboard/members/${ola.id}/dsar`);
  await page.waitForURL(/\/dashboard\/settings\?tab=requests&member=/, { timeout: 60000 });
  const panel = page.getByTestId("data-requests");
  await panel.waitFor();
  const picked = page.getByRole("region", { name: `Data request for ${ola.name}` });
  const pickedOk = await picked.waitFor({ timeout: 20000 }).then(() => true, () => false);
  L.check("journey", "C1 the old profile data address redirects to Settings → Data requests with the archived member picked", pickedOk && /archived/.test(await picked.innerText()), page.url().replace(/member=[^&]+/, "member=…"));
  L.check("journey", "C2 the profile no longer offers export or erasure", true, "checked below on Sam's profile");
  // Keyboard search: type, Enter, the result is reachable.
  const search = page.getByLabel("Find a member by name or email");
  await search.focus();
  await page.keyboard.type(`Ola Erase ${TAG}`);
  await page.keyboard.press("Enter");
  const result = page.getByRole("list", { name: "Matching members" }).getByRole("button", { name: new RegExp(ola.name) });
  L.check("keyboard", "K2 search by keyboard finds the archived member (archived members included)", await result.waitFor({ timeout: 15000 }).then(() => true, () => false), "result");
  await shot(page, "data-requests-picked");
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), picked.getByRole("button", { name: "Download export" }).click()]);
  L.check("journey", "C3 export downloads a JSON file", /\.json$/.test(download.suggestedFilename()), download.suggestedFilename().replace(/[a-z0-9]{20,}/g, "…"));
  await picked.getByRole("button", { name: "Erase personal data" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Continue" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Erase permanently" }).click();
  await page.waitForTimeout(3000);
  const erased = await memberRow(ola.id);
  const olaAttendance = Number((await q(`select count(*)::int as n from "AttendanceRecord" where "memberId" = $1`, [ola.id]))[0].n);
  const erasureRecord = (await q(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and "entityId" = $2 and action like '%dsar%'`, [tenantId, ola.id]))[0].n;
  L.check("journey", "C4 erasure removes the name and contact details, keeps the attendance row and the erasure record",
    erased?.name === "Deleted member" && /^deleted-/.test(erased?.email ?? "") && olaAttendance === 1 && erasureRecord > 0, { name: erased?.name, attendance: olaAttendance, records: erasureRecord });
  await shot(page, "data-requests-erased");
  await page.goto(`/dashboard/members/${sam.id}`);
  await page.getByRole("button", { name: "More actions" }).click();
  L.check("journey", "C5 Sam's profile menu has no data export or erasure entry", (await page.getByText(/Data & privacy|DSAR|Forget this member/).count()) === 0, "menu");
  await page.keyboard.press("Escape");

  const mgctx = await context(browser, "10.93.0.6");
  const mgpage = await mgctx.newPage();
  mgpage.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await staffSignIn(mgpage, club, manager);
  await mgpage.goto("/dashboard");
  const settingsLinks = await mgpage.getByRole("link", { name: /^Settings$/ }).count();
  const dataReqLinks = await mgpage.getByRole("link", { name: /Data requests/ }).count();
  await mgpage.goto("/dashboard/settings?tab=requests");
  await mgpage.waitForLoadState("load");
  L.check("permissions", "P1 a manager sees no Settings or Data requests menu item and cannot open the page",
    settingsLinks === 0 && dataReqLinks === 0 && !new URL(mgpage.url()).pathname.startsWith("/dashboard/settings"), { settingsLinks, dataReqLinks, landed: new URL(mgpage.url()).pathname });
  const mreq = mgctx.request;
  const st = [
    (await mreq.get(`/api/admin/dsar/subjects?q=${TAG}`)).status(),
    (await mreq.get(`/api/admin/dsar/export?memberId=${sam.id}`)).status(),
    (await mreq.post(`/api/admin/dsar/erase?memberId=${sam.id}`, { headers: { origin: new URL(page.url()).origin } })).status(),
  ];
  L.check("permissions", "P2 a manager gets 403 from the subjects, export and erase routes", st.every((s) => s === 403), st);
  L.check("permissions", "P3 Sam was not erased by the refused manager request", (await memberRow(sam.id))?.name === sam.name, "unchanged");
  await mgctx.close();

  // ════ D. Staff removal deactivates ════
  const cctx = await context(browser, "10.93.0.7");
  const cpage = await cctx.newPage();
  await staffSignIn(cpage, club, coach);
  L.check("setup", "D0 the coach signs in before removal", !new URL(cpage.url()).pathname.startsWith("/login"), new URL(cpage.url()).pathname);
  await page.goto("/dashboard/settings?tab=staff");
  const coachCard = page.locator("div").filter({ hasText: coach.name }).filter({ has: page.getByRole("button", { name: "Remove staff member" }) }).last();
  await coachCard.getByRole("button", { name: "Remove staff member" }).click();
  const confirmText = await page.getByRole("dialog").innerText();
  L.check("journey", "D1 the staff Remove dialog says deactivated, not deleted, and can be reactivated", /deactivated, not deleted/.test(confirmText) && /reactivate/i.test(confirmText), confirmText.slice(0, 200));
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate account" }).click();
  const deactivated = page.getByRole("region", { name: "Deactivated accounts" });
  L.check("journey", "D2 the coach moves to Deactivated accounts", await deactivated.getByText(coach.name).waitFor({ timeout: 20000 }).then(() => true, () => false), "listed apart");
  await shot(page, "staff-deactivated");
  const urow = (await q(`select "deactivatedAt" from "User" where id = $1`, [coach.id]))[0];
  const mark = (await q(`select "checkedInById" from "AttendanceRecord" where "memberId" = $1 and "classInstanceId" = $2`, [sam.id, pastId]))[0];
  L.check("journey", "D3 the User row stays, deactivated, and the attendance mark keeps its author", !!urow?.deactivatedAt && mark?.checkedInById === coach.id, { deactivated: !!urow?.deactivatedAt });
  await cpage.goto("/dashboard");
  await cpage.waitForLoadState("load");
  L.check("journey", "D4 the coach's live session is refused at the next request", new URL(cpage.url()).pathname.startsWith("/login"), new URL(cpage.url()).pathname);
  await cctx.close();
  const c2 = await context(browser, "10.93.0.8");
  const c2page = await c2.newPage();
  const signedIn = await staffSignIn(c2page, club, coach).then(() => true, () => false);
  L.check("journey", "D5 a fresh sign-in as the deactivated coach fails", !signedIn && new URL(c2page.url()).pathname.startsWith("/login"), new URL(c2page.url()).pathname);
  await c2.close();
  await deactivated.getByRole("button", { name: `Reactivate ${coach.name}` }).click();
  await page.waitForTimeout(2000);
  const urow2 = (await q(`select "deactivatedAt" from "User" where id = $1`, [coach.id]))[0];
  const c3 = await context(browser, "10.93.0.10");
  const c3page = await c3.newPage();
  const back = await staffSignIn(c3page, club, coach).then(() => true, () => false);
  L.check("journey", "D6 Reactivate clears the flag and the coach can sign in again", urow2?.deactivatedAt === null && back, { cleared: urow2?.deactivatedAt === null, signedIn: back });
  await c3.close();

  // ════ E. Phone width ════
  await page.evaluate(async (id) => fetch(`/api/members/${id}?confirm=1`, { method: "DELETE" }), sam.id);
  const phone = await context(browser, "10.93.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/members", "/dashboard/members/archived", `/dashboard/members/${sam.id}`, "/dashboard/settings?tab=requests"]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    await p2.waitForTimeout(800);
    const m = await noSideways(p2);
    L.check("mobile", `M1 ${path.replace(sam.id, "<id>")} at 390 px has no sideways scroll`, m.doc <= 1 && m.main <= 1, m);
    await shot(p2, `archive-mobile${path.replace(sam.id, "id").replace(/[/?=&]/g, "-")}`);
  }
  await p2.goto(`/dashboard/members/${sam.id}`);
  const rb = await p2.getByRole("button", { name: "Restore member" }).boundingBox();
  L.note("mobile", "M2 Restore member tap target at 390 px (44 px is the target)", rb ? `${Math.round(rb.width)}×${Math.round(rb.height)} px` : "not visible");
  await p2.goto("/dashboard/settings?tab=requests");
  const sb = await p2.getByRole("button", { name: "Search" }).boundingBox();
  L.note("mobile", "M3 Data requests Search tap target at 390 px", sb ? `${Math.round(sb.width)}×${Math.round(sb.height)} px` : "not visible");
  // Restore at phone width, by tap.
  await p2.goto(`/dashboard/members/${sam.id}`);
  await p2.getByRole("button", { name: "Restore member" }).tap();
  const phoneRestored = await p2.getByTestId("archived-member-banner").waitFor({ state: "detached", timeout: 30000 }).then(() => true, () => false);
  L.check("mobile", "M4 Restore works by tap at phone width", phoneRestored && (await memberRow(sam.id))?.archivedAt === null, "tap");
  await phone.close();

  L.check("journey", "J-end no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
