// Journey: class lifecycle and class eligibility at every door (release QA, 23 Oct 2026).
// The owner creates a class with a category, a membership list (ClassMembershipTier) and a squad list (ClassRoster)
// in the timetable form, edits it, then eligible and ineligible members are tried at the desk register (real UI), the
// kiosk (public API with real kiosk tokens), the coach tick (API) and member booking (member sessions). A guardian
// checks in their child. A member is made ineligible after booking (roster removal; plan change), the roster is
// changed while a check-in is in flight (twice: single-member DELETE, whole-roster PATCH), and the class is paused,
// resumed, archived and restored through the timetable UI. Every check reads the stored rows and audit rows.
// Needs `fixture.mjs create` and `server.mjs start`. Start before about 22:35 club time: the sessions start 20-50 min after
// the run begins, so the kiosk and guardian doors (which enforce the check-in window) are open for them.
//   node journeys/classes-lifecycle.mjs
//
// ── Notes: exact strings and routes this journey asserts (source: worktree batch-d, head cfd725e3) ──────────────
//  Sentences
//   tier, named plan     lib/class-tier-gate.ts:50  `${className} isn't included in your ${tierName} membership. Ask staff about a membership that includes it.`
//   tier, no plan        lib/class-tier-gate.ts:51  `${className} is only open to certain memberships, and you don't have a membership plan set yet. Ask staff.`
//   roster               lib/class-tier-gate.ts:58  "You're not on the roster for this class."
//   paused / archived    lib/class-live.ts:80-81    `${n} is paused at the moment, so check-in and booking are closed. Ask staff when it's back.` /
//                                                   `${n} is no longer on the timetable, so check-in and booking are closed.`
//  Engine: classEligibility lib/checkin.ts:426-456 (roster judged first, then the tier list; no override at any door);
//   lockedClassEligibility (coach tick) lib/checkin.ts:464-482; class state gate only for self/kiosk lib/checkin.ts:773.
//  Doors
//   desk     POST /api/checkin {classInstanceId, memberId, checkInMethod:"admin"} app/api/checkin/route.ts:84-120,163-204;
//            refusal body from lib/checkin-refusal.ts:132-133,162-168 (403); audit attendance.mark route.ts:218 (entityId `${inst}:${member}`)
//            register UI: components/dashboard/RegisterPanel.tsx:651-676 (Search members, Enter marks), :446-453 (role=alert)
//   undo     DELETE /api/checkin?classInstanceId&memberId app/api/checkin/route.ts:285-330, audit attendance.override :320
//   guardian POST /api/checkin {classInstanceId, onBehalfOfMemberId} route.ts:121-143 (self profile), audit attendance.self_checkin :245
//   kiosk    POST /api/kiosk/[token]/checkin {kioskMemberToken, classInstanceId} app/api/kiosk/[token]/checkin/route.ts:29-32,88-120;
//            sentences :192-203 (roster), :234-238 (tier), :151-156 (class_paused 409); audit attendance.kiosk_checkin :131
//            member list GET /api/kiosk/[token]/members?q&classInstanceId hides members off a roster (members/route.ts:89-125)
//            kiosk member token = lib/kiosk-token.ts (HMAC key "matflow.kiosk.v1"); Tenant.kioskTokenHash = lib/token-hash.ts HMAC(secret, raw)
//   coach    POST /api/coach/instances/[id]/attendance {memberId, attended:true} app/api/coach/instances/[id]/attendance/route.ts
//   booking  POST /api/member/class-subscriptions/[classId] app/api/member/class-subscriptions/[classId]/route.ts:31-160
//            (lifecycle 409 first, then roster 403, then tier 403); books ONLY the signed-in member (resolveMember :24-29)
//  Class routes
//   create   POST /api/classes app/api/classes/route.ts:56-220 (category, allowedTierIds, roster in one tx); audit class.created :204
//   edit     PATCH /api/classes/[id] app/api/classes/[id]/route.ts:362-771; audit class.updated :705 (fields, before/after, lifecycle)
//   archive  DELETE /api/classes/[id] :791-900, audit class.deleted :881 (archived, attendanceCount, rosterCount, bookingCount)
//   roster   DELETE /api/classes/[id]/roster/[memberId] app/api/classes/[id]/roster/[memberId]/route.ts, audit class.roster.remove :47
//   UI       components/dashboard/TimetableManager.tsx: "Add class", Class Name, #class-category, "Who can attend" checkboxes
//            (aria-label = tier name) :1185-1223, "+ Select specific people (comp class)" :1287, "Create class"/"Save changes" :1470,
//            `Pause ${name}` :378 -> "Pause class" :1715, `Archive ${name}` :388 -> "Archive class" :1768,
//            `Resume ${name}` / `Restore ${name}` :555, toast `Class created · N sessions added to the timetable` :1697
//  KNOWN CONFLICT WITH THE BRIEF: removing a member from the roster DELETES their booking in both roster paths —
//   app/api/classes/[id]/roster/[memberId]/route.ts:128-130 (cascadeCancelledSubscription: true) and
//   app/api/classes/[id]/route.ts:489-495 + 596-603 (cascadeCancelledMemberIds). J30 asserts the brief ("booking
//   preserved") and is expected to FAIL against this source; J33-J35 prove the preserved-booking case via a plan change.
//  NO ROUTE: a guardian cannot book for a child (the booking route books only the session's own member). The child's
//   booking is seeded with SQL and recorded as a NOTE.
import { randomUUID, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, bcrypt, sleep, BASE } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("classes-lifecycle");
const tenantId = club.tenantId;
const errors = [];
const ORIGIN = new URL(BASE).origin;
const TAG = randomUUID().replace(/[^a-z]/g, "").slice(0, 4).toUpperCase().padEnd(4, "Q");

// ── Club clock (Europe/London), computed here and never from the app's helpers ──
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
// SQL parameter form: node-postgres sends a JS Date in the machine's local zone (01:00 during BST on this laptop),
// which never equals the stored 00:00 marker in a timestamp-without-zone column (23 Oct runs). A plain string is exact.
const todaySql = `${todayIso} 00:00:00`;
const hourNow = Number(parts.hour);
// Session times relative to the start of the run (review 23 Oct): the kiosk and guardian doors enforce the check-in
// window (30 min before to 30 min after, lib/checkin.ts:863-864). S starts 20-25 min ahead, rounded up to 5 min, so
// its window is open from the first step for about 50 min, whatever minute the run begins. S2-S4 (staff doors, no
// window) follow at +10/+20/+30 min. All four must be today, so the run must start before 23:00 club time.
const nowMin = hourNow * 60 + Number(parts.minute);
const baseMin = Math.ceil((nowMin + 20) / 5) * 5;
// S ends 60 min after it starts; the form wraps an end past midnight to 00:xx, which closes the window (review 23 Oct).
if (baseMin + 60 > 23 * 60 + 59) throw new Error("start before about 22:35 club time: session S (and its 60-minute end) must fall within today");
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const T_S = hm(baseMin), T_S2 = hm(baseMin + 10), T_S3 = hm(baseMin + 20), T_S4 = hm(baseMin + 30);
const dowSun0 = todayMarker.getUTCDay(); // ClassSchedule.dayOfWeek: 0 = Sunday (TimetableManager.tsx:94)

// ── Secrets for the kiosk door (same derivation as lib/token-hash.ts and lib/kiosk-token.ts); never printed ──
const env = testEnv();
const SECRET = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
if (!SECRET) throw new Error("no AUTH secret in .env.test");
const kioskRaw = `mfvk${randomUUID().replace(/-/g, "")}`;
function signKioskMemberToken(memberId) {
  const key = createHmac("sha256", SECRET).update("matflow.kiosk.v1").digest();
  const body = Buffer.from(JSON.stringify({ tenantId, memberId, exp: Math.floor(Date.now() / 1000) + 600 }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

// ── Names and the sentences each door must give ──
const CLASS = `Squad Comp ${TAG}`;
const TIER_A = `Comp A ${TAG}`, TIER_B = `Comp B ${TAG}`;
const ROSTER_SENTENCE = "You're not on the roster for this class.";
const tierSentence = (tierName) => `${CLASS} isn't included in your ${tierName} membership. Ask staff about a membership that includes it.`;
const NO_PLAN_SENTENCE = `${CLASS} is only open to certain memberships, and you don't have a membership plan set yet. Ask staff.`;
const PAUSED_SENTENCE = `${CLASS} is paused at the moment, so check-in and booking are closed. Ask staff when it's back.`;
const ARCHIVED_SENTENCE = `${CLASS} is no longer on the timetable, so check-in and booking are closed.`;

// ── DB read-backs ──
const rows = async (inst, mid) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0].n);
const record = async (inst, mid) => (await q(`select id, "checkInMethod" from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0] ?? null;
const bookings = async (mid, classId) => Number((await q(`select count(*)::int as n from "ClassSubscription" where "memberId" = $1 and "classId" = $2`, [mid, classId]))[0].n);
const rosterIds = async (classId) => (await q(`select "memberId" from "ClassRoster" where "tenantId" = $1 and "classId" = $2 order by "memberId"`, [tenantId, classId])).map((r) => r.memberId);
const tierIds = async (classId) => (await q(`select "tierId" from "ClassMembershipTier" where "tenantId" = $1 and "classId" = $2 order by "tierId"`, [tenantId, classId])).map((r) => r.tierId);
const classRow = async (classId) => (await q(`select name, category, description, "isActive", "deletedAt", "maxCapacity", duration from "Class" where id = $1 and "tenantId" = $2`, [classId, tenantId]))[0] ?? null;
const audits = async (action, entityId, extra = "", params = []) =>
  q(`select metadata, "createdAt" from "AuditLog" where "tenantId" = $1 and action = $2 and "entityId" = $3 ${extra} order by "createdAt" asc`, [tenantId, action, entityId, ...params]);
/** Audit writes are best-effort and asynchronous (lib/audit-log.ts:255-285): poll for `want` rows; for 0, settle then read. */
async function auditsSettled(action, entityId, want, extra = "", params = []) {
  if (want === 0) { await sleep(1500); return audits(action, entityId, extra, params); }
  for (let i = 0; i < 30; i++) {
    const r = await audits(action, entityId, extra, params);
    if (r.length >= want) return r;
    await sleep(500);
  }
  return audits(action, entityId, extra, params);
}
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); }
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** In-page fetch: same-origin, with the page's session, exactly as the app's own clients call. */
async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const t0 = performance.now();
    const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, ms: Math.round(performance.now() - t0) };
  }, { method, path, body });
}
/** page.request (the context's cookies, no page): used where two requests must be in flight at once. */
async function req(page, method, path, data) {
  const r = await page.request.fetch(path, { method, headers: { Origin: ORIGIN, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { data } : {}) });
  let body = null; try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status(), body };
}

// ── Seed: two plans, the people, the kiosk ──
const pw = () => `Mfv-${randomUUID().slice(0, 12)}-aa1`;
async function addMember({ key, name, tierId = null, tierName = null, accountType = "adult", parentId = null, password = null }) {
  const id = randomUUID();
  const email = `${club.slug}-${key}-${TAG}@example.test`.toLowerCase();
  await q(`insert into "Member" (id, "tenantId", email, name, "membershipTierId", "membershipType", "waiverAccepted", "accountType", "parentMemberId", "guardianConfirmedAt", "passwordHash", "updatedAt")
           values ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, $10, now())`,
    [id, tenantId, email, name, tierId, tierName, accountType, parentId, parentId ? new Date() : null, password ? await bcrypt.hash(password, 10) : null]);
  return { id, name, email, password };
}
const tierA = randomUUID(), tierB = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $3, $4, 0, 'GBP', 'monthly', now()), ($2, $3, $5, 0, 'GBP', 'monthly', now())`,
  [tierA, tierB, tenantId, TIER_A, TIER_B]);
const ella = await addMember({ key: "ella", name: `Ella Eligible ${TAG}`, tierId: tierA, tierName: TIER_A, password: pw() });
const ian = await addMember({ key: "ian", name: `Ian Ineligible ${TAG}`, tierId: tierB, tierName: TIER_B, password: pw() });
const nina = await addMember({ key: "nina", name: `Nina Noplan ${TAG}` });
const rhea = await addMember({ key: "rhea", name: `Rhea Offroster ${TAG}`, tierId: tierA, tierName: TIER_A, password: pw() });
const cora = await addMember({ key: "cora", name: `Cora Concurrent ${TAG}`, tierId: tierA, tierName: TIER_A });
const cole = await addMember({ key: "cole", name: `Cole Concurrent ${TAG}`, tierId: tierA, tierName: TIER_A });
const pat = await addMember({ key: "pat", name: `Pat Parent ${TAG}`, accountType: "parent", password: pw() });
const kit = await addMember({ key: "kit", name: `Kit Kid ${TAG}`, tierId: tierA, tierName: TIER_A, accountType: "kids", parentId: pat.id });
const ROSTER = [ella, ian, nina, cora, cole, kit];
await q(`update "Tenant" set "kioskTokenHash" = $1 where id = $2`, [createHmac("sha256", SECRET).update(kioskRaw).digest("hex"), tenantId]);

async function memberSignIn(page, m) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(m.email);
  await page.getByLabel("Password").fill(m.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/member/, { timeout: 60000 });
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.95.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // ── 1. Create the class in the timetable form: category, membership list, squad list, one day (today) ──
  await page.goto("/dashboard/timetable");
  await page.getByRole("button", { name: "Add class" }).first().click();
  await page.getByLabel("Class Name", { exact: true }).fill(CLASS);
  await page.locator("#class-category").selectOption("competition");
  await page.getByRole("spinbutton", { name: "Duration (mins)" }).first().fill("60");
  await page.getByRole("spinbutton", { name: "Max Capacity" }).fill("40");
  await page.getByRole("checkbox", { name: TIER_A, exact: true }).click();
  // Every member-list request the picker sends is recorded (23 Oct 20:53: the picker showed "Couldn't load the member
  // list" once and nothing in the server log said why). If the first load fails, the journey uses the app's own
  // "Try again" button, as a person would, and the failed status stays in the ledger as a note.
  const listCalls = [];
  const onList = (r) => { const u = new URL(r.url()); if (u.pathname === "/api/members" && r.request().method() === "GET") listCalls.push({ status: r.status(), at: new Date().toISOString() }); };
  const onListFail = (rq) => { const u = new URL(rq.url()); if (u.pathname === "/api/members" && rq.method() === "GET") listCalls.push({ status: "network", error: rq.failure()?.errorText ?? null, at: new Date().toISOString() }); };
  page.on("response", onList);
  page.on("requestfailed", onListFail);
  await page.getByRole("button", { name: "+ Select specific people (comp class)" }).click();
  const loadError = page.getByText("Couldn't load the member list", { exact: false });
  const firstLoadFailed = await loadError.waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (firstLoadFailed) {
    L.note("journey", "N0 the roster picker's first member-list load failed; retried with the app's own 'Try again' button", { listCalls: [...listCalls] });
    await shot(page, "classes-picker-load-failed");
    await page.getByRole("button", { name: "Try again" }).click();
  }
  const missingFromPicker = [];
  for (const m of ROSTER) {
    const box = page.locator("label").filter({ hasText: m.name }).locator('input[type="checkbox"]');
    if (await box.waitFor({ timeout: 20000 }).then(() => true, () => false)) await box.check();
    else missingFromPicker.push(m.name);
  }
  page.off("response", onList);
  page.off("requestfailed", onListFail);
  L.check("journey", "J2a the roster picker's first member-list load succeeds (no 'Couldn't load the member list')", !firstLoadFailed, { listCalls });
  L.check("journey", "J2 after at most one retry, every squad member (adults and the child) is offered in the roster picker", missingFromPicker.length === 0, { missingFromPicker, firstLoadFailed, listCalls });
  await page.getByRole("button", { name: "Add day" }).click();
  await page.getByLabel("Day of the week").last().selectOption(String(dowSun0));
  await page.getByLabel("Start time").last().fill(T_S);
  await shot(page, "classes-create-form");
  let posts = 0;
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/classes") posts++; });
  await page.getByRole("button", { name: "Create class" }).click();
  const createdToast = await page.getByText(/Class created · \d+ sessions? added to the timetable/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
  const cls = await until(async () => (await q(`select id from "Class" where "tenantId" = $1 and name = $2`, [tenantId, CLASS]))[0]);
  if (!cls) throw new Error("class was not created — later steps need it");
  const classId = cls.id;
  if (missingFromPicker.includes(kit.name)) {
    // Seed only (the picker check above already FAILED): the child must be on the squad list for the later doors.
    await api(page, "POST", `/api/classes/${classId}/roster`, { memberId: kit.id });
    L.note("journey", "N1 the child was added through POST /api/classes/[id]/roster because the picker did not list them", "seed");
  }
  const row0 = await classRow(classId);
  L.check("journey", "J3 Create class: one request, the toast, and the stored class has the category, capacity and duration",
    createdToast && posts === 1 && row0.category === "competition" && row0.maxCapacity === 40 && row0.duration === 60 && row0.isActive === true && row0.deletedAt === null,
    { createdToast, posts, row: row0 });
  L.check("journey", "J4 the membership list stored is exactly the ticked plan (ClassMembershipTier)", sameSet(await tierIds(classId), [tierA]), await tierIds(classId));
  L.check("journey", "J5 the squad list stored is exactly the ticked members (ClassRoster)", sameSet(await rosterIds(classId), ROSTER.map((m) => m.id)), { stored: (await rosterIds(classId)).length, want: ROSTER.length });
  const created = (await auditsSettled("class.created", classId, 1))[0]?.metadata ?? null;
  L.check("audit", "A1 class.created audit row carries the name and the membership list before/after",
    created?.name === CLASS && Array.isArray(created?.allowedTierIds?.before) && created.allowedTierIds.before.length === 0 && JSON.stringify(created?.allowedTierIds?.after) === JSON.stringify([tierA]), created);
  // Exact match on the club-day marker (UTC midnight of today's London date, as lib/today-sessions.ts clubDayMarker).
  // A miss records every minted session, so a day-late start (the "afternoon create" bug) is visible, not absorbed.
  const S = (await q(`select id from "ClassInstance" where "classId" = $1 and date = $2 and "startTime" = $3`, [classId, todaySql, T_S]))[0]?.id;
  const minted = S ? null : (await q(`select to_char(date, 'YYYY-MM-DD HH24:MI') as d, "startTime" as t from "ClassInstance" where "classId" = $1 order by date, "startTime"`, [classId])).map((r) => `${r.d} ${r.t}`);
  const sched = S ? null : (await q(`select "dayOfWeek", "startTime", to_char("startDate", 'YYYY-MM-DD HH24:MI') as "startDate" from "ClassSchedule" where "classId" = $1`, [classId]));
  L.check("journey", "J6 creating the class minted today's session at the scheduled time", !!S, { session: T_S, today: todayIso, minted, schedule: sched });
  if (!S) throw new Error("no session minted for today — later steps need it");

  // ── 2. Edit: category and description; the lists stay as they are ──
  await page.reload();
  await page.locator(`button[aria-label="Edit ${CLASS}"]:visible`).first().click();
  await page.locator("#class-category").waitFor();
  await page.locator("#class-category").selectOption("nogi");
  await page.getByLabel("Description", { exact: true }).fill("Edited by the classes journey");
  let patches = 0;
  page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${classId}`) patches++; });
  await page.getByRole("button", { name: "Save changes" }).click();
  const edited = await until(async () => (await classRow(classId))?.category === "nogi");
  const row1 = await classRow(classId);
  L.check("journey", "J7 Save changes stores the new category and description in one request",
    !!edited && patches === 1 && row1.description === "Edited by the classes journey", { patches, row: row1 });
  L.check("journey", "J8 the edit left the membership list and the squad list unchanged",
    sameSet(await tierIds(classId), [tierA]) && sameSet(await rosterIds(classId), ROSTER.map((m) => m.id)), { tiers: await tierIds(classId), roster: (await rosterIds(classId)).length });
  const upd = (await auditsSettled("class.updated", classId, 1)).at(-1)?.metadata ?? null;
  L.check("audit", "A2 class.updated audit row: category competition -> nogi, description recorded, no bookings cascaded",
    upd?.before?.category === "competition" && upd?.after?.category === "nogi" && upd?.after?.description === "Edited by the classes journey" && upd?.cascadeCancelledSubscriptions === 0,
    { fields: upd?.fields, before: upd?.before, after: upd?.after });

  // Three more sessions today for the staff doors (staff doors have no time window).
  const S2 = randomUUID(), S3 = randomUUID(), S4 = randomUUID();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $4, $5, $6, $6), ($2, $4, $5, $7, $7), ($3, $4, $5, $8, $8)`,
    [S2, S3, S4, classId, todaySql, T_S2, T_S3, T_S4]);

  // ── 3. Desk register (real UI): ineligible refused with the member's own sentence, eligible admitted ──
  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${esc(T_S2)} · ${esc(CLASS)}`) }).click();
  const search = page.getByLabel("Search members");
  await search.waitFor();
  const searchEnter = async (name) => {
    await search.fill("");
    await search.fill(name);
    await page.getByRole("button", { name: new RegExp(`^${esc(name)}`) }).first().waitFor({ timeout: 30000 });
    await search.press("Enter");
  };
  for (const [m, sentence, label] of [[ian, tierSentence(TIER_B), "a plan the class does not include"], [nina, NO_PLAN_SENTENCE, "no membership plan"], [rhea, ROSTER_SENTENCE, "not on the squad list"]]) {
    await searchEnter(m.name);
    const saw = await page.getByRole("alert").filter({ hasText: sentence }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!saw) await shot(page, `classes-desk-${m.name.split(" ")[0].toLowerCase()}-unexpected`);
    const audit = await auditsSettled("attendance.mark", `${S2}:${m.id}`, 0);
    L.check("journey", `J9 desk register refuses ${label} with the member's sentence, no dialog, nothing recorded, no audit row (${m.name.split(" ")[0]})`,
      saw && (await page.getByRole("dialog").count()) === 0 && (await rows(S2, m.id)) === 0 && audit.length === 0, { saw, sentence, rows: await rows(S2, m.id), audits: audit.length });
  }
  await shot(page, "classes-desk-refused");
  await searchEnter(ella.name);
  const ellaDesk = await until(async () => (await rows(S2, ella.id)) === 1);
  const ellaDeskAudit = (await auditsSettled("attendance.mark", `${S2}:${ella.id}`, 1))[0]?.metadata ?? null;
  const ellaRec = await record(S2, ella.id);
  L.check("journey", "J10 desk register admits the eligible member (on the squad list and the ticked plan): one admin row and its audit row",
    !!ellaDesk && ellaRec?.checkInMethod === "admin" && ellaDeskAudit?.recordId === ellaRec?.id && ellaDeskAudit?.created === true && !ellaDeskAudit?.overrides,
    { record: ellaRec, audit: ellaDeskAudit });

  // ── 4. Kiosk (public door, real kiosk member tokens) ──
  const kctx = await context(browser, "10.95.0.9");
  const kreq = kctx.request;
  const kioskSearch = async (name) => (await (await kreq.get(`/api/kiosk/${kioskRaw}/members?q=${encodeURIComponent(name)}&classInstanceId=${S}`)).json()).members ?? [];
  const ellaK = (await kioskSearch(ella.name)).find((m) => m.name === ella.name);
  const ianK = (await kioskSearch(ian.name)).find((m) => m.name === ian.name);
  const ninaK = (await kioskSearch(nina.name)).find((m) => m.name === nina.name);
  const rheaListed = (await kioskSearch(rhea.name)).length;
  L.check("journey", "J11 the kiosk member list for a squad session lists squad members and hides the member off the squad list",
    !!ellaK && !!ianK && !!ninaK && rheaListed === 0, { ella: !!ellaK, ian: !!ianK, nina: !!ninaK, rheaListed });
  const kiosk = async (token, inst) => {
    const r = await kreq.post(`/api/kiosk/${kioskRaw}/checkin`, { data: { kioskMemberToken: token, classInstanceId: inst } });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status(), body };
  };
  for (const [m, token, sentence, reason, label] of [
    [ian, ianK?.kioskMemberToken ?? signKioskMemberToken(ian.id), tierSentence(TIER_B), "tier_not_included", "a plan the class does not include"],
    [nina, ninaK?.kioskMemberToken ?? signKioskMemberToken(nina.id), NO_PLAN_SENTENCE, "tier_not_included", "no membership plan"],
    // The list hides her; a token minted for her (an old tablet, a replay) must still be refused by the server.
    [rhea, signKioskMemberToken(rhea.id), ROSTER_SENTENCE, "roster_not_listed", "not on the squad list (token minted outside the list)"],
  ]) {
    const r = await kiosk(token, S);
    await sleep(1500);
    const audit = await q(`select id from "AuditLog" where "tenantId" = $1 and action = 'attendance.kiosk_checkin' and metadata->>'memberId' = $2`, [tenantId, m.id]);
    L.check("journey", `J12 kiosk refuses ${label}: 403, the sentence, nothing recorded (${m.name.split(" ")[0]})`,
      r.status === 403 && r.body?.error === sentence && r.body?.reason === reason && (await rows(S, m.id)) === 0 && audit.length === 0, { ...r, rows: await rows(S, m.id) });
  }
  const ek = await kiosk(ellaK?.kioskMemberToken ?? signKioskMemberToken(ella.id), S);
  const ellaKioskRec = await record(S, ella.id);
  const ellaKioskAudit = ellaKioskRec ? (await auditsSettled("attendance.kiosk_checkin", ellaKioskRec.id, 1))[0]?.metadata ?? null : null;
  L.check("journey", "J13 kiosk admits the eligible member: 201, one kiosk row, attendance.kiosk_checkin audit row",
    ek.status === 201 && ek.body?.success === true && ellaKioskRec?.checkInMethod === "kiosk" && ellaKioskAudit?.memberId === ella.id && ellaKioskAudit?.classInstanceId === S,
    { ...ek, record: ellaKioskRec, audit: ellaKioskAudit });

  // ── 5. Coach tick (staff door that marks without performCheckin) ──
  for (const [m, sentence, reason, label] of [[ian, tierSentence(TIER_B), "tier_not_included", "a plan the class does not include"], [nina, NO_PLAN_SENTENCE, "tier_not_included", "no membership plan"], [rhea, ROSTER_SENTENCE, "roster_not_listed", "not on the squad list"]]) {
    const r = await api(page, "POST", `/api/coach/instances/${S3}/attendance`, { memberId: m.id, attended: true });
    const audit = await auditsSettled("attendance.mark", `${S3}:${m.id}`, 0);
    L.check("journey", `J14 coach tick refuses ${label}: 403, the sentence, nothing recorded, no audit row (${m.name.split(" ")[0]})`,
      r.status === 403 && r.body?.error === sentence && r.body?.reason === reason && (await rows(S3, m.id)) === 0 && audit.length === 0, { status: r.status, body: r.body });
  }
  const ct = await api(page, "POST", `/api/coach/instances/${S3}/attendance`, { memberId: ella.id, attended: true });
  const coachRec = await record(S3, ella.id);
  const coachAudit = (await auditsSettled("attendance.mark", `${S3}:${ella.id}`, 1))[0]?.metadata ?? null;
  L.check("journey", "J15 coach tick admits the eligible member: one admin row, attendance.mark audit with created: true",
    ct.status === 200 && ct.body?.ok === true && coachRec?.checkInMethod === "admin" && coachAudit?.recordId === coachRec?.id && coachAudit?.created === true, { ct, coachRec, coachAudit });

  // ── 6. Booking: by members (their own sessions) and for a child by their guardian ──
  const memberPage = async (m, lane) => {
    const c = await context(browser, lane);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(p, m);
    return { c, p };
  };
  const E = await memberPage(ella, "10.95.0.11");
  const I = await memberPage(ian, "10.95.0.12");
  const R = await memberPage(rhea, "10.95.0.13");
  const P = await memberPage(pat, "10.95.0.14");
  L.check("journey", "J16 four member sign-ins (eligible, wrong plan, off the squad, guardian) land in the member app",
    [E, I, R, P].every((x) => /\/member/.test(x.p.url())), [E, I, R, P].map((x) => new URL(x.p.url()).pathname));
  const bE = await api(E.p, "POST", `/api/member/class-subscriptions/${classId}`);
  L.check("journey", "J17 the eligible member books: 201, no allowance notice (Unlimited plan), one booking row",
    bE.status === 201 && bE.body?.success === true && bE.body?.allowanceNotice === null && (await bookings(ella.id, classId)) === 1, { ...bE, rows: await bookings(ella.id, classId) });
  const bI = await api(I.p, "POST", `/api/member/class-subscriptions/${classId}`);
  L.check("journey", "J18 a member on a plan the class does not include cannot book: 403 with the sentence, no row",
    bI.status === 403 && bI.body?.error === tierSentence(TIER_B) && bI.body?.reason === "tier_not_included" && (await bookings(ian.id, classId)) === 0, bI);
  const bR = await api(R.p, "POST", `/api/member/class-subscriptions/${classId}`);
  L.check("journey", "J19 a member off the squad list cannot book: 403 with the roster sentence, no row",
    bR.status === 403 && bR.body?.error === ROSTER_SENTENCE && bR.body?.reason === "roster_not_listed" && (await bookings(rhea.id, classId)) === 0, bR);
  L.note("journey", "N2 guardian booking for a child: no route exists (app/api/member/class-subscriptions/[classId]/route.ts:24-29 books only the signed-in member; no onBehalfOf). The child's booking is seeded with SQL.", "seed");
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3)`, [randomUUID(), kit.id, classId]);
  const g1 = await api(P.p, "POST", "/api/checkin", { classInstanceId: S, onBehalfOfMemberId: kit.id });
  const kitRec = await record(S, kit.id);
  const kitAudit = kitRec ? (await auditsSettled("attendance.self_checkin", kitRec.id, 1))[0]?.metadata ?? null : null;
  L.check("journey", "J20 the guardian checks their child in (on the squad and the plan): 201, one self row, audit names the child as onBehalfOf",
    g1.status === 201 && kitRec?.checkInMethod === "self" && kitAudit?.onBehalfOf === kit.id && kitAudit?.memberId === kit.id, { g1: { status: g1.status, error: g1.body?.error }, kitRec, kitAudit });
  const undoKit = await api(page, "DELETE", `/api/checkin?classInstanceId=${S}&memberId=${kit.id}`);
  const undoAudit = await auditsSettled("attendance.override", `${S}:${kit.id}`, 1);
  L.check("journey", "J21 staff undo removes the child's check-in and writes attendance.override", undoKit.status === 200 && (await rows(S, kit.id)) === 0 && undoAudit.length === 1, { undo: undoKit.status, rows: await rows(S, kit.id) });

  // ── 7. Made ineligible after booking ──
  // 7a. Off the squad list, through the timetable form (untick and save).
  await page.goto("/dashboard/timetable");
  await page.locator(`button[aria-label="Edit ${CLASS}"]:visible`).first().click();
  const ellaBox = page.locator("label").filter({ hasText: ella.name }).locator('input[type="checkbox"]');
  const inForm = await ellaBox.waitFor({ timeout: 30000 }).then(() => true, () => false);
  if (inForm) await ellaBox.uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  const removed = await until(async () => !(await rosterIds(classId)).includes(ella.id));
  L.check("journey", "J22 unticking the member and saving removes them from the squad list (the rest stay)",
    inForm && !!removed && sameSet(await rosterIds(classId), ROSTER.filter((m) => m !== ella).map((m) => m.id)), { inForm, roster: (await rosterIds(classId)).length });
  const rmAudit = (await auditsSettled("class.updated", classId, 2)).at(-1)?.metadata ?? null;
  L.note("audit", "N3 class.updated row for the roster removal (fields, cascade)", { fields: rmAudit?.fields, cascadeCancelledMemberIds: rmAudit?.cascadeCancelledMemberIds });
  L.check("journey", "J30 BRIEF: the member's booking is preserved after removal from the squad list (source cascades it — expected FAIL, see notes)",
    (await bookings(ella.id, classId)) === 1, { bookings: await bookings(ella.id, classId), cascadeCancelledMemberIds: rmAudit?.cascadeCancelledMemberIds });
  const afterRm = await api(page, "POST", "/api/checkin", { classInstanceId: S4, memberId: ella.id, checkInMethod: "admin" });
  L.check("journey", "J31 after removal the desk refuses her with the roster sentence and records nothing",
    afterRm.status === 403 && afterRm.body?.error === ROSTER_SENTENCE && afterRm.body?.reason === "roster_not_listed" && (await rows(S4, ella.id)) === 0, afterRm);
  // The kiosk enforces the check-in window (30 min before, lib/checkin.ts:863), unlike the desk, so S4 may not be open
  // yet (23 Oct run: 409 outside_window). J32 gets its own session ten minutes from now, inside the window whatever
  // the clock, where the member has no row yet. Same standard as J12: reason, sentence, no row, no new kiosk audit.
  const kp5 = Object.fromEntries(fmt.formatToParts(new Date(Date.now() + 10 * 60_000)).map((p) => [p.type, p.value]));
  let t5 = `${kp5.hour}:${kp5.minute}`;
  if ([T_S, T_S2, T_S3, T_S4].includes(t5)) t5 = `${kp5.hour}:${String(Math.min(59, Number(kp5.minute) + 1)).padStart(2, "0")}`;
  const S5 = randomUUID();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [S5, classId, todaySql, t5]);
  const kioskAudits = async () => (await q(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = 'attendance.kiosk_checkin' and metadata->>'memberId' = $2`, [tenantId, ella.id]))[0].n;
  const kioskAudit0 = await kioskAudits();
  const afterRmKiosk = await kiosk(signKioskMemberToken(ella.id), S5);
  await sleep(1500);
  const kioskAudit1 = await kioskAudits();
  L.check("journey", "J32 ...and the kiosk refuses her the same way (a session of the class inside the kiosk's window)",
    afterRmKiosk.status === 403 && afterRmKiosk.body?.reason === "roster_not_listed" && afterRmKiosk.body?.error === ROSTER_SENTENCE && (await rows(S5, ella.id)) === 0 && kioskAudit1 === kioskAudit0,
    { ...afterRmKiosk, session: t5, newKioskAudits: kioskAudit1 - kioskAudit0 });
  // 7b. The child's plan changed by staff (PATCH /api/members/[id]): the booking stays, the door refuses.
  const pm = await api(page, "PATCH", `/api/members/${kit.id}`, { membershipTierId: tierB });
  const kitTier = (await q(`select "membershipTierId" from "Member" where id = $1`, [kit.id]))[0]?.membershipTierId;
  const pmAudit = await auditsSettled("member.update", kit.id, 1);
  L.check("journey", "J33 staff move the child to a plan the class does not include: stored, audited (member.update)",
    pm.status === 200 && kitTier === tierB && pmAudit.length >= 1, { status: pm.status, error: pm.body?.error, kitTier: kitTier === tierB });
  L.check("journey", "J34 the child's booking is preserved after they become ineligible", (await bookings(kit.id, classId)) === 1, { bookings: await bookings(kit.id, classId) });
  const g2 = await api(P.p, "POST", "/api/checkin", { classInstanceId: S, onBehalfOfMemberId: kit.id });
  L.check("journey", "J35 the guardian's check-in for the child is now refused with the child's plan sentence; nothing recorded",
    g2.status === 403 && g2.body?.error === tierSentence(TIER_B) && g2.body?.reason === "tier_not_included" && (await rows(S, kit.id)) === 0, g2);

  // ── 8. Roster change while a check-in is in flight (the engine serialises on the Class and Member locks) ──
  // R1: single-member DELETE (takes no Class lock: the check-in reads its last commit, lib/checkin.ts:417-419).
  {
    const [c, d] = await Promise.all([
      req(page, "POST", "/api/checkin", { classInstanceId: S4, memberId: cora.id, checkInMethod: "admin" }),
      req(page, "DELETE", `/api/classes/${classId}/roster/${cora.id}`),
    ]);
    const admitted = c.status === 201;
    const n = await rows(S4, cora.id);
    const rm = await auditsSettled("class.roster.remove", `${classId}:${cora.id}`, 1);
    const mk = await auditsSettled("attendance.mark", `${S4}:${cora.id}`, admitted ? 1 : 0);
    L.note("race", "N4 R1 which commit won (check-in vs single-member roster DELETE)", { checkin: c.status, reason: c.body?.reason ?? null, rosterDelete: d.status });
    L.check("race", "R1 exactly one consistent outcome: the roster row is gone; the check-in is either admitted (1 row, 1 attendance.mark) or refused with the roster sentence (0 rows, 0 audit)",
      d.status === 200 && !(await rosterIds(classId)).includes(cora.id) && rm.length === 1
        && ((admitted && n === 1 && mk.length === 1 && mk[0].metadata?.recordId === (await record(S4, cora.id))?.id)
          || (c.status === 403 && c.body?.reason === "roster_not_listed" && c.body?.error === ROSTER_SENTENCE && n === 0 && mk.length === 0)),
      { checkin: c.status, rows: n, markAudits: mk.length, removeAudits: rm.length });
    const again = await req(page, "POST", "/api/checkin", { classInstanceId: S3, memberId: cora.id, checkInMethod: "admin" });
    L.check("race", "R2 after the race the member is off the squad list at every session: refused, nothing recorded",
      again.status === 403 && again.body?.reason === "roster_not_listed" && (await rows(S3, cora.id)) === 0, again);
  }
  // R2: whole-roster PATCH (takes the Class lock the check-in also takes, app/api/classes/[id]/route.ts:530-536).
  {
    const keep = (await rosterIds(classId)).filter((id) => id !== cole.id);
    const before = (await audits("class.updated", classId)).length;
    const [c, p] = await Promise.all([
      req(page, "POST", "/api/checkin", { classInstanceId: S4, memberId: cole.id, checkInMethod: "admin" }),
      req(page, "PATCH", `/api/classes/${classId}`, { roster: keep.map((memberId) => ({ memberId })) }),
    ]);
    const admitted = c.status === 201;
    const n = await rows(S4, cole.id);
    const upd2 = await auditsSettled("class.updated", classId, before + 1);
    const mk = await auditsSettled("attendance.mark", `${S4}:${cole.id}`, admitted ? 1 : 0);
    L.note("race", "N5 R2 which commit won (check-in vs whole-roster PATCH under the Class lock)", { checkin: c.status, reason: c.body?.reason ?? null, patch: p.status });
    L.check("race", "R3 exactly one consistent outcome under the Class lock: roster stored without him, one class.updated row naming roster; admitted with one row + one audit, or refused with none",
      p.status === 200 && sameSet(await rosterIds(classId), keep) && upd2.length === before + 1 && (upd2.at(-1)?.metadata?.fields ?? []).includes("roster")
        && ((admitted && n === 1 && mk.length === 1) || (c.status === 403 && c.body?.reason === "roster_not_listed" && n === 0 && mk.length === 0)),
      { checkin: c.status, patch: p.status, rows: n, markAudits: mk.length });
  }

  // ── 9. Pause, resume, archive, restore — through the timetable UI ──
  const ianToken = () => signKioskMemberToken(ian.id);
  await page.goto("/dashboard/timetable");
  await page.locator(`button[aria-label="Pause ${CLASS}"]:visible`).first().click();
  await page.getByRole("button", { name: "Pause class", exact: true }).click();
  const paused = await until(async () => (await classRow(classId))?.isActive === false);
  const pRow = await classRow(classId);
  const pAudit = (await auditsSettled("class.updated", classId, 1, `and metadata->>'lifecycle' = $4`, ["paused"]))[0]?.metadata ?? null;
  L.check("journey", "J40 Pause: isActive false, not archived, audit lifecycle 'paused' with isActive before/after",
    !!paused && pRow.deletedAt === null && pAudit?.before?.isActive === true && pAudit?.after?.isActive === false, { row: pRow, audit: pAudit && { before: pAudit.before, after: pAudit.after } });
  const kp = await kiosk(ianToken(), S);
  L.check("journey", "J41 a paused class's session is closed at the kiosk: 409 with the paused sentence, nothing recorded",
    kp.status === 409 && kp.body?.error === PAUSED_SENTENCE && kp.body?.reason === "class_paused" && (await rows(S, ian.id)) === 0, kp);
  const bp = await api(I.p, "POST", `/api/member/class-subscriptions/${classId}`);
  L.check("journey", "J42 a paused class cannot be booked: 409 with the paused sentence, no row",
    bp.status === 409 && bp.body?.error === PAUSED_SENTENCE && bp.body?.reason === "class_paused" && (await bookings(ian.id, classId)) === 0, bp);
  await page.reload();
  await page.locator(`button[aria-label="Resume ${CLASS}"]:visible`).first().click();
  const resumed = await until(async () => (await classRow(classId))?.isActive === true);
  const rAudit = (await auditsSettled("class.updated", classId, 1, `and metadata->>'lifecycle' = $4`, ["resumed"]))[0]?.metadata ?? null;
  L.check("journey", "J43 Resume (Paused and archived section): isActive true, audit lifecycle 'resumed'",
    !!resumed && (await classRow(classId)).deletedAt === null && rAudit?.after?.isActive === true, { audit: rAudit && { before: rAudit.before, after: rAudit.after } });
  await page.reload();
  const counts = {
    attendance: Number((await q(`select count(*)::int as n from "AttendanceRecord" a join "ClassInstance" ci on ci.id = a."classInstanceId" where ci."classId" = $1`, [classId]))[0].n),
    roster: (await rosterIds(classId)).length,
    bookings: Number((await q(`select count(*)::int as n from "ClassSubscription" where "classId" = $1`, [classId]))[0].n),
  };
  await page.locator(`button[aria-label="Archive ${CLASS}"]:visible`).first().click();
  const archiveBtn = page.getByRole("button", { name: "Archive class", exact: true });
  await archiveBtn.waitFor();
  const archiveDialog = page.locator('[role="dialog"], [role="alertdialog"]').filter({ has: archiveBtn }).last();
  const dialogText = (await archiveDialog.textContent()) ?? "";
  L.check("journey", "J44 the archive confirmation states the stored counts (check-ins, roster, bookings)",
    (counts.attendance === 0 || new RegExp(`\\b${counts.attendance} check-ins?\\b`).test(dialogText))
      && (counts.roster === 0 || new RegExp(`\\b${counts.roster} members? on its roster`).test(dialogText))
      && (counts.bookings === 0 || new RegExp(`\\b${counts.bookings} bookings?\\b`).test(dialogText)), { counts, dialogText: dialogText.slice(0, 300) });
  await shot(page, "classes-archive-confirm");
  await archiveBtn.click();
  const archived = await until(async () => (await classRow(classId))?.deletedAt !== null);
  const aAudit = (await auditsSettled("class.deleted", classId, 1))[0]?.metadata ?? null;
  L.check("journey", "J45 Archive: isActive false and deletedAt set; class.deleted audit with archived: true and the same counts",
    !!archived && (await classRow(classId)).isActive === false && aAudit?.archived === true && aAudit?.attendanceCount === counts.attendance && aAudit?.rosterCount === counts.roster && aAudit?.bookingCount === counts.bookings,
    { counts, audit: aAudit && { attendanceCount: aAudit.attendanceCount, rosterCount: aAudit.rosterCount, bookingCount: aAudit.bookingCount } });
  const ka = await kiosk(ianToken(), S);
  L.check("journey", "J46 an archived class's session is closed at the kiosk: 409 with the archived sentence, nothing recorded",
    ka.status === 409 && ka.body?.error === ARCHIVED_SENTENCE && ka.body?.reason === "class_paused" && (await rows(S, ian.id)) === 0, ka);
  L.check("journey", "J47 archiving kept the history: rows, roster and bookings unchanged",
    counts.roster === (await rosterIds(classId)).length && counts.attendance === Number((await q(`select count(*)::int as n from "AttendanceRecord" a join "ClassInstance" ci on ci.id = a."classInstanceId" where ci."classId" = $1`, [classId]))[0].n), counts);
  await page.reload();
  await page.locator(`button[aria-label="Restore ${CLASS}"]:visible`).first().click();
  const restored = await until(async () => { const r = await classRow(classId); return r?.isActive === true && r?.deletedAt === null; });
  const resAudit = (await auditsSettled("class.updated", classId, 1, `and metadata->>'lifecycle' = $4`, ["restored"]))[0]?.metadata ?? null;
  L.check("journey", "J48 Restore: isActive true, deletedAt cleared, audit lifecycle 'restored' with deletedAt before/after",
    !!restored && resAudit?.after?.isActive === true && resAudit?.after?.deletedAt === null && typeof resAudit?.before?.deletedAt === "string", { audit: resAudit && { before: resAudit.before, after: resAudit.after } });
  const kr = await kiosk(ianToken(), S);
  L.check("journey", "J49 after Restore the class is live again and eligibility still applies: the kiosk refuses the wrong plan with its sentence",
    kr.status === 403 && kr.body?.error === tierSentence(TIER_B) && (await rows(S, ian.id)) === 0, kr);
  await shot(page, "classes-restored");

  // ── 10. Phone width ──
  const phone = await context(browser, "10.95.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/timetable", "/dashboard/checkin"]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", `M1 ${path} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `classes-mobile${path.replace(/\//g, "-")}`);
  }
  const memberPhone = await context(browser, "10.95.0.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await I.c.storageState() });
  const p3 = await memberPhone.newPage();
  p3.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p3.goto("/member/schedule");
  await p3.waitForLoadState("load");
  const mm = await p3.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M2 /member/schedule at 390 px has no horizontal page scroll", mm.scroll <= mm.width + 1, mm);
  await shot(p3, "classes-mobile-member-schedule");
  L.check("journey", "J50 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
