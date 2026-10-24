// Journey: accounts and members (release QA, 23 Oct 2026).
// Owner signs in (password + authenticator); adds a member by keyboard through two failed saves and a retry that sends
// exactly one request with the SAME idempotency key; the invite is suppressed (EMAIL_DELIVERY=off) and the EmailLog row
// says so; duplicate creates/PATCHes leave one row; status active→inactive→cancelled→active writes one MemberStatusEvent
// per real transition; the member edit form keeps typed values through a network failure and a 500; a guardian and a
// child are linked (and the kids constraint refuses an orphan, in the API and in Postgres); the pages at 390 px; then the
// forgot-password flow with delivery SIMULATED (see notes) ending in a sign-in with the new password and the original
// password restored. Needs `fixture.mjs create` and `server.mjs start` (server env: EMAIL_DELIVERY=off).
//   node journeys/accounts-and-members.mjs
//
// ── Source notes (every string and rule below is read from the source; batch-c unless marked batch-d) ──────────────
// Mail switch
//   .claude/skills/matflow-verify-local/scripts/env.mjs:99      appEnv sets EMAIL_DELIVERY = "off" for the test server.
//   lib/email-delivery.ts:41                                    unset/""/"on" = on; anything else = off.
//   lib/email-delivery.ts:56   EMAIL_OFF_MESSAGE "Email is turned off for this club, so nothing was sent."
//   lib/email.ts:438-451       sendEmail with delivery off writes ONE EmailLog row: status "suppressed",
//                              errorMessage "suppressed_delivery_off: EMAIL_DELIVERY=off — nothing was sent" (:446-447).
// Forgot / reset password
//   app/api/auth/forgot-password/route.ts:113  delivery off → 200 {ok:true}, NO PasswordResetToken minted, NO sendEmail
//                              (so NO EmailLog row — the brief expected one; the source says none, and that is asserted).
//   app/api/auth/forgot-password/route.ts:117  code lives 2 minutes; :133 stored as hashSubjectBoundResetCode(code,…).
//   lib/auth-token-binding.ts:55,64,117        hash = hashToken([ "auth-token-subject.reset.v1", tenantId, kind, id,
//                              code ].join("\n")); lib/token-hash.ts:30 HMAC-SHA256 keyed by AUTH_SECRET_VALUE;
//                              lib/auth-secret.ts:15 NEXTAUTH_SECRET (non-blank) else AUTH_SECRET. The journey computes the
//                              same hash from .env.test (never printed) to SIMULATE the delivered code — the raw code is
//                              never stored, so it cannot be "read from the DB".
//   app/api/tenant/[slug]/route.ts:101          lookup returns emailDelivery: emailDeliveryMode().
//   app/login/page.tsx:450,895-909             emailOff → sentence "Forgot your password? Email is turned off for this
//                              club, so we can't send a reset code or sign-in link. Ask your club to reset your access —
//                              club owners, contact MatFlow." and NO "Forgot password?" button. The simulation overrides
//                              only the CLIENT's view of emailDelivery (route on /api/tenant/<slug>) to reach the reset
//                              screen; the server stays mail-dark.
//   app/login/page.tsx:1336-1359 handleForgot (POST forgot-password, then the reset step); :1117 "Check your email";
//                              :1127 "Six-digit authentication code"; :1164 "New password (min. 10 characters)";
//                              :1192 "Confirm new password"; :1234 "Set new password"; :1090 "Password updated".
//   app/api/auth/reset-password/route.ts       wrong code → 400 "Code is invalid or has expired (codes are valid for 2
//                              minutes). Please request a new one."; :238 reuse → 400 "You cannot reuse your current
//                              password or any of your last 8 passwords."; :193/247 token used=true; :269 sessionVersion+1;
//                              :285 old hash into PasswordHistory.
//   lib/api-authz.ts:70        stale session → 401 "Your session has expired. Please sign in again."
// Member create (POST /api/members)
//   app/api/members/route.ts:263 owner/manager/admin may add; :310 "Only the owner or a manager can add a child";
//   :317 "Kid sub-accounts require a parent member" (400); :325 "Parent member not found in this tenant" (404);
//   :327 "Cannot nest sub-accounts: parent must be top-level" (400); :414 desk member starts paymentStatus "pending";
//   :420-438 requestId replay → 200 {…, replayed: true}; :511-518 status event null→status, reason "staff_edit",
//   changedById = signed-in user; :561-588 invite: MagicLinkToken purpose "first_time_signup" + sendEmail
//   templateId "invite_member"; :590 note = suppressedMessage; :612 409 "That email address is already in use at this club."
//   lib/kids-policy.ts:28 under 13 → "kids"; :483 CONFIRMED_BY("staff") sets guardianConfirmedAt;
//   lib/synthesise-kid-email.ts kids get an @no-login.matflow.local address.
//   prisma/migrations/20260515000001_member_kids_check_constraint/migration.sql:26-27
//                              CONSTRAINT "Member_kids_must_have_parent" CHECK ("accountType" <> 'kids' OR "parentMemberId" IS NOT NULL).
// Member PATCH (/api/members/[id])
//   app/api/members/[id]/route.ts:202 owner/manager/admin; :412 cancelledAt stamped on →cancelled; :413 cleared on rejoin;
//   :496-503 recordStatusEvent reason "staff_edit", changedById; lib/member-status.ts:192 no row when from === to;
//   :549 stale updatedAt → 409 "This member was updated by someone else. Reload and try again."
// Add Member dialog (components/dashboard/MembersList.tsx)
//   :802 header button "Add member"; :1394 dialog title "Add Member"; :1423/1441/1469 aria-labels "Full Name", "Email",
//   "Phone"; :1412 <form onSubmit> (Enter submits); :1306 one requestId held across retries of the same form;
//   :1406 "Adding…" / "Add Member"; components/ui/button.tsx:67-68 loading → disabled + aria-busy;
//   lib/save-failure.ts idempotent texts: network "Couldn't reach MatFlow, so we don't know whether it went through. Press
//   Add Member again — the same one is never recorded twice."; server "MatFlow couldn't complete this. Press Add Member
//   again — the same one is never recorded twice. If it keeps failing, note it down and tell the owner.";
//   :1185 invite dialog "<name> was added. <note> Hand them this link instead — it sets up their login, works once and
//   expires in 7 days."; :878 "Search members".
// Member edit (components/dashboard/MemberProfile.tsx)
//   :1198-1200 "Edit"; :1535 "Phone"; :1606 "Status"; :1655 "Save"/"Saving…"; :848/860 describeSaveFailure(…, "Save")
//   non-idempotent: network "Couldn't reach MatFlow. Nothing was saved — check the connection and press Save again.";
//   server "MatFlow couldn't complete this and nothing was saved. Try Save again; if it keeps failing, tell the owner.";
//   :886 toast "Profile updated"; lib/schemas/member.ts:24 "07…" → "+447…".
// Family card (components/dashboard/OwnerFamilyManagement.tsx): :154 "Family"; :186 "Parent"; :198 "sub-account".
// Restore: the reset route refuses the original password (history), so the original is written back with bcrypt via
// q() — the only path; sessions from before the reset stay revoked (sessionVersion is not rolled back).
import { randomUUID, randomBytes, randomInt, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, bcrypt, sleep } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("accounts-and-members");
// Two runs on 23 Oct hung after P2 (24 min, then 5 h) with no timeout firing. Step markers locate the next hang;
// the watchdog fails the run after 30 min instead of blocking the chain; body reads get their own timeout.
let STEP = "start";
const step = (s) => { STEP = s; console.log(`step: ${s} @ ${new Date().toISOString()}`); };
setTimeout(() => {
  console.error(`WATCHDOG: no finish after 30 min, last step "${STEP}"`);
  try { L.check("watchdog", "W1 the journey finished within 30 minutes", false, { lastStep: STEP }); } catch {}
  process.exit(3);
}, 30 * 60 * 1000).unref();
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms: ${what}`)), ms))]);
const tenantId = club.tenantId;
const ownerId = club.owner.id;
const errors = [];
const tag = Date.now().toString(36).slice(-6);
const mail = (k) => `${club.slug}-am-${tag}-${k}@example.test`;

const EMAIL_OFF = "Email is turned off for this club, so nothing was sent.";
const SUPPRESSED_NOTE = "suppressed_delivery_off: EMAIL_DELIVERY=off — nothing was sent";
const ADD_NET = "Couldn't reach MatFlow, so we don't know whether it went through. Press Add Member again — the same one is never recorded twice.";
const ADD_SRV = "MatFlow couldn't complete this. Press Add Member again — the same one is never recorded twice. If it keeps failing, note it down and tell the owner.";
const SAVE_NET = "Couldn't reach MatFlow. Nothing was saved — check the connection and press Save again.";
const SAVE_SRV = "MatFlow couldn't complete this and nothing was saved. Try Save again; if it keeps failing, tell the owner.";
const BAD_CODE = "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one.";
const REUSE = "You cannot reuse your current password or any of your last 8 passwords.";

// ── DB read-backs ────────────────────────────────────────────────────────────
const memberByEmail = async (email) => (await q(
  `select id, name, email, phone, status, "paymentStatus", "accountType", "parentMemberId", "guardianConfirmedAt", "passwordHash",
          "createRequestId", "cancelledAt", "updatedAt"
     from "Member" where "tenantId" = $1 and email = $2`, [tenantId, email]))[0] ?? null;
const memberById = async (id) => (await q(
  `select id, name, email, phone, status, "accountType", "parentMemberId", "guardianConfirmedAt", "passwordHash", "cancelledAt", "updatedAt", "membershipTierId"
     from "Member" where "tenantId" = $1 and id = $2`, [tenantId, id]))[0] ?? null;
const countMembers = async (where, params) => Number((await q(`select count(*)::int as n from "Member" where "tenantId" = $1 and ${where}`, [tenantId, ...params]))[0].n);
const events = async (memberId) => q(
  `select "fromStatus", "toStatus", reason, "changedById" from "MemberStatusEvent" where "tenantId" = $1 and "memberId" = $2
    order by "occurredAt", "createdAt", id`, [tenantId, memberId]);
const emailLogs = async (recipient, templateId) => q(
  `select "templateId", recipient, status, "errorMessage" from "EmailLog" where "tenantId" = $1 and recipient = $2 and "templateId" = $3`,
  [tenantId, recipient, templateId]);

/** fetch from inside the signed-in page (same origin, so the CSRF guard sees a real Origin). */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const init = { method, redirect: "manual", headers: {} };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  try {
    const r = await fetch(path, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 300) };
  } catch (e) { return { status: -1, json: null, text: String(e).slice(0, 200) }; }
}, { method, path, body });
const activeLabel = (page) => page.evaluate(() => {
  const e = document.activeElement;
  return e ? (e.getAttribute("aria-label") || e.textContent?.trim().slice(0, 40) || e.tagName) : null;
});
const noScroll = async (p) => p.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const memberPosts = [];
  page.on("request", (r) => {
    if (r.method() !== "POST" || new URL(r.url()).pathname !== "/api/members") return;
    let b = null; try { b = JSON.parse(r.postData() ?? "null"); } catch {}
    memberPosts.push(b);
  });

  // ── A. Owner sign-in ───────────────────────────────────────────────────────
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in (password + authenticator) lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // ── B. Add member by keyboard; failed saves; one retry ─────────────────────
  const NAME = `AM Desk ${tag}`;
  const EMAIL = mail("desk");
  await page.goto("/dashboard/members");
  await page.getByRole("button", { name: "Add member", exact: true }).first().click();
  const dlg = page.getByRole("dialog").filter({ hasText: "Add Member" });
  const fullName = dlg.getByLabel("Full Name", { exact: true });
  await fullName.waitFor();
  await page.waitForTimeout(300);
  L.note("keyboard", "N1 element focused when the Add Member dialog opens", await activeLabel(page));
  let tabs = 0;
  while ((await activeLabel(page)) !== "Full Name" && tabs < 4) { await page.keyboard.press("Tab"); tabs++; }
  L.check("keyboard", "K1 Full Name is focused on open or within 4 Tab presses", (await activeLabel(page)) === "Full Name", { tabs });
  await page.keyboard.type(NAME);
  await page.keyboard.press("Tab");
  const afterName = await activeLabel(page);
  await page.keyboard.type(EMAIL);
  await page.keyboard.press("Tab");
  const afterEmail = await activeLabel(page);
  L.check("keyboard", "K2 Tab order Full Name → Email → Phone", afterName === "Email" && afterEmail === "Phone", { afterName, afterEmail });
  const styleOf = (label) => page.evaluate((l) => {
    const e = document.querySelector(`[role="dialog"] [aria-label="${l}"]`);
    const s = getComputedStyle(e);
    return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, shadow: s.boxShadow, border: s.borderColor };
  }, label);
  const focusedStyle = await styleOf("Phone");
  await page.keyboard.press("Shift+Tab");
  const blurredStyle = await styleOf("Phone");
  await page.keyboard.press("Tab");
  L.check("keyboard", "K3 the focused field is visibly different from the same field unfocused", JSON.stringify(focusedStyle) !== JSON.stringify(blurredStyle), { focusedStyle, blurredStyle });

  // F1: network failure, submitted with Enter from the Phone field.
  await page.route("**/api/members", (r) => (r.request().method() === "POST" ? r.abort("failed") : r.fallback()));
  const p0 = memberPosts.length;
  await page.keyboard.press("Enter");
  const netAlert = dlg.getByRole("alert").filter({ hasText: ADD_NET });
  const sawNet = await netAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("keyboard", "K4 Enter in the form submits it (one POST attempted)", memberPosts.length - p0 === 1, { attempts: memberPosts.length - p0 });
  L.check("failed-save", "F1 network failure: the idempotent message in the dialog, typed name and email kept, no row",
    sawNet && (await fullName.inputValue()) === NAME && (await dlg.getByLabel("Email", { exact: true }).inputValue()) === EMAIL && (await countMembers(`email = $2`, [EMAIL])) === 0,
    { alert: sawNet });
  await page.waitForTimeout(5000);
  L.check("failed-save", "F1b the error is persistent (still shown 5 s later, not a passing toast)", await netAlert.isVisible().catch(() => false), "visible after 5 s");
  await shot(page, "accounts-add-failed-network");

  // F2: server error.
  await page.unroute("**/api/members");
  await page.route("**/api/members", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.fallback()));
  await dlg.getByRole("button", { name: "Add Member", exact: true }).click();
  const srvAlert = dlg.getByRole("alert").filter({ hasText: ADD_SRV });
  const sawSrv = await srvAlert.waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F2 server error: the server message, values kept, no row",
    sawSrv && (await fullName.inputValue()) === NAME && (await countMembers(`email = $2`, [EMAIL])) === 0, { alert: sawSrv });

  // R1: retry through the real server (held 1.5 s so the loading state can be observed).
  await page.unroute("**/api/members");
  await page.route("**/api/members", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    await sleep(1500);
    return r.continue();
  });
  const p1 = memberPosts.length;
  await dlg.getByRole("button", { name: "Add Member", exact: true }).click();
  await page.waitForTimeout(400);
  const busyBtn = dlg.locator('button[aria-busy="true"]');
  const loading = { count: await busyBtn.count(), text: (await busyBtn.first().textContent().catch(() => null))?.trim() ?? null, disabled: await busyBtn.first().isDisabled().catch(() => null) };
  L.check("loading", "L1 while saving the button reads 'Adding…', is disabled and aria-busy", loading.count === 1 && loading.text === "Adding…" && loading.disabled === true, loading);
  const invite = page.getByRole("dialog").filter({ hasText: "Invite link" });
  const added = await invite.waitFor({ timeout: 30000 }).then(() => true, () => false);
  await page.unroute("**/api/members");
  await page.waitForTimeout(800);
  const keys = memberPosts.slice(p0).map((b) => b?.requestId ?? null);
  const row = await memberByEmail(EMAIL);
  L.check("retry", "R1 the retry sent exactly one request and all three attempts carried the same requestId",
    memberPosts.length - p1 === 1 && keys.length === 3 && new Set(keys).size === 1 && !!keys[0], { retryRequests: memberPosts.length - p1, distinctKeys: new Set(keys).size });
  L.check("retry", "R2 one row: active, adult, 'pending' (No payment yet), createRequestId = the held key",
    added && !!row && row.status === "active" && row.accountType === "adult" && row.paymentStatus === "pending" && row.createRequestId === keys[0] && (await countMembers(`email = $2`, [EMAIL])) === 1,
    { added, row: row && { status: row.status, accountType: row.accountType, paymentStatus: row.paymentStatus, keyMatches: row.createRequestId === keys[0] } });
  const ev0 = row ? await events(row.id) : [];
  L.check("retry", "R3 one MemberStatusEvent null → active, reason staff_edit, changedById = the owner",
    ev0.length === 1 && ev0[0].fromStatus === null && ev0[0].toStatus === "active" && ev0[0].reason === "staff_edit" && ev0[0].changedById === ownerId, ev0);
  const inviteLogs = await emailLogs(EMAIL, "invite_member");
  L.check("email", "E1 the invite was suppressed, not sent: one EmailLog row invite_member, status suppressed, the delivery-off reason",
    inviteLogs.length === 1 && inviteLogs[0].status === "suppressed" && inviteLogs[0].errorMessage === SUPPRESSED_NOTE, inviteLogs.map((r) => ({ status: r.status, errorMessage: r.errorMessage })));
  const links = await q(`select purpose, used from "MagicLinkToken" where "tenantId" = $1 and email = $2`, [tenantId, EMAIL]);
  L.check("email", "E2 one unused first_time_signup invite token was minted for the hand-over link", links.length === 1 && links[0].purpose === "first_time_signup" && links[0].used === false, links);
  const inviteText = (await invite.textContent().catch(() => "")) ?? "";
  const codeText = (await invite.locator("code").textContent().catch(() => "")) ?? "";
  L.check("email", "E3 the dialog says email is off and offers the link instead (no claim that an email went out)",
    inviteText.includes(`${NAME} was added. ${EMAIL_OFF} Hand them this link instead — it sets up their login, works once and expires in 7 days.`) && /\/login\/accept-invite\?token=/.test(codeText) && !inviteText.includes("an invite email was sent"),
    { hasLink: /\/login\/accept-invite\?token=/.test(codeText) });
  await page.evaluate(() => document.querySelectorAll("code").forEach((c) => { c.textContent = c.textContent.replace(/token=[^&\s]+/, "token=[masked]"); }));
  await shot(page, "accounts-invite-link-email-off");
  await page.keyboard.press("Escape");
  await page.reload();
  const search = page.getByLabel("Search members");
  await search.waitFor();
  await search.fill(NAME);
  const listed = await page.getByText(NAME, { exact: true }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  L.check("retry", "R4 after reload the members list finds the new member by name", listed, { listed });

  // ── C. Duplicate actions (API, owner session) ──────────────────────────────
  const dupEmail = mail("dup");
  const keyX = randomUUID();
  const bodyX = { name: `AM Dup ${tag}`, email: dupEmail, status: "active", requestId: keyX };
  const d1a = await api(page, "POST", "/api/members", bodyX);
  const d1b = await api(page, "POST", "/api/members", bodyX);
  const dupRow = await memberByEmail(dupEmail);
  L.check("duplicate", "D1 the same create sent twice (same requestId): 201 then 200 replayed with the same id, one row",
    d1a.status === 201 && d1b.status === 200 && d1b.json?.replayed === true && d1a.json?.id === d1b.json?.id && (await countMembers(`"createRequestId" = $2`, [keyX])) === 1,
    { first: d1a.status, second: d1b.status, replayed: d1b.json?.replayed, sameId: d1a.json?.id === d1b.json?.id });
  const d2 = await api(page, "POST", "/api/members", { name: `AM Dup ${tag}`, email: dupEmail });
  L.check("duplicate", "D2 the same address again without the key: 409 'That email address is already in use at this club.', still one row",
    d2.status === 409 && d2.json?.error === "That email address is already in use at this club." && (await countMembers(`email = $2`, [dupEmail])) === 1, { status: d2.status, error: d2.json?.error });
  const raceEmail = mail("race");
  const bodyY = { name: `AM Race ${tag}`, email: raceEmail, requestId: randomUUID() };
  const race = await page.evaluate(async (body) => {
    const one = () => fetch("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    return Promise.all([one(), one()]);
  }, bodyY);
  L.check("duplicate", "D3 two identical creates in flight at once: both succeed with the same id, one row",
    race.every((r) => r.status === 200 || r.status === 201) && race[0].json?.id === race[1].json?.id && (await countMembers(`email = $2`, [raceEmail])) === 1,
    race.map((r) => ({ status: r.status, replayed: r.json?.replayed ?? false })));

  // ── D. Status transitions with their events (API) ──────────────────────────
  const sid = dupRow?.id;
  const t1a = await api(page, "PATCH", `/api/members/${sid}`, { status: "inactive" });
  const t1b = await api(page, "PATCH", `/api/members/${sid}`, { status: "inactive" });
  let ev = await events(sid);
  L.check("duplicate", "D4 the same PATCH (status inactive) twice: both 200, exactly one active→inactive event",
    t1a.status === 200 && t1b.status === 200 && ev.filter((e) => e.fromStatus === "active" && e.toStatus === "inactive").length === 1, { statuses: [t1a.status, t1b.status], events: ev.length });
  const beforeStale = await memberById(sid);
  const stale = await api(page, "PATCH", `/api/members/${sid}`, { name: "AM Overwritten", updatedAt: "2020-01-01T00:00:00.000Z" });
  L.check("duplicate", "D5 a PATCH carrying a stale updatedAt: 409 with the reload sentence, row unchanged",
    stale.status === 409 && stale.json?.error === "This member was updated by someone else. Reload and try again." && typeof stale.json?.currentUpdatedAt === "string" && (await memberById(sid))?.name === beforeStale?.name,
    { status: stale.status, error: stale.json?.error });
  const t2 = await api(page, "PATCH", `/api/members/${sid}`, { status: "cancelled" });
  const afterCancel = await memberById(sid);
  L.check("status", "S1 inactive → cancelled: 200, status cancelled, cancelledAt stamped", t2.status === 200 && afterCancel?.status === "cancelled" && afterCancel?.cancelledAt !== null, { status: t2.status, row: afterCancel?.status, cancelledAt: !!afterCancel?.cancelledAt });
  const t3 = await api(page, "PATCH", `/api/members/${sid}`, { status: "active" });
  const afterRejoin = await memberById(sid);
  L.check("status", "S2 cancelled → active: 200, status active, cancelledAt cleared", t3.status === 200 && afterRejoin?.status === "active" && afterRejoin?.cancelledAt === null, { status: t3.status, row: afterRejoin?.status, cancelledAt: afterRejoin?.cancelledAt });
  ev = await events(sid);
  const chain = ev.map((e) => `${e.fromStatus ?? "∅"}→${e.toStatus}`);
  L.check("status", "S3 the event history is exactly ∅→active, active→inactive, inactive→cancelled, cancelled→active — all staff_edit by the owner",
    JSON.stringify(chain) === JSON.stringify(["∅→active", "active→inactive", "inactive→cancelled", "cancelled→active"]) && ev.every((e) => e.reason === "staff_edit" && e.changedById === ownerId),
    { chain, reasons: [...new Set(ev.map((e) => e.reason))], byOwner: ev.every((e) => e.changedById === ownerId) });
  const audit = (await q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'member.update' and "entityId" = $2 order by "createdAt" desc limit 1`, [tenantId, sid]))[0]?.metadata ?? null;
  L.check("status", "S4 the last member.update audit row carries status from cancelled to active", audit?.changes?.status?.from === "cancelled" && audit?.changes?.status?.to === "active", audit?.changes?.status ?? null);

  // ── E. Member edit form: failed saves keep typed values; one retry; reload ──
  const uid = row?.id;
  let patches = 0;
  page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/members/${uid}`) patches++; });
  await page.goto(`/dashboard/members/${uid}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const phone = page.getByLabel("Phone", { exact: true });
  const status = page.getByLabel("Status", { exact: true });
  await phone.waitFor();
  await phone.fill("07700 900123");
  await status.selectOption("inactive");
  await page.route(`**/api/members/${uid}`, (r) => (r.request().method() === "PATCH" ? r.abort("failed") : r.fallback()));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const eNet = await page.getByRole("alert").filter({ hasText: SAVE_NET }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  let db = await memberById(uid);
  L.check("failed-save", "F3 edit, network failure: message beside Save, typed phone and status kept, row unchanged",
    eNet && (await phone.inputValue()) === "07700 900123" && (await status.inputValue()) === "inactive" && db?.phone === null && db?.status === "active", { alert: eNet, db: { phone: db?.phone, status: db?.status } });
  await page.unroute(`**/api/members/${uid}`);
  await page.route(`**/api/members/${uid}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : r.fallback()));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const eSrv = await page.getByRole("alert").filter({ hasText: SAVE_SRV }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  db = await memberById(uid);
  L.check("failed-save", "F4 edit, server error: message shown, values kept, row unchanged",
    eSrv && (await phone.inputValue()) === "07700 900123" && db?.phone === null && db?.status === "active", { alert: eSrv });
  await shot(page, "accounts-edit-failed-server");
  await page.unroute(`**/api/members/${uid}`);
  const pb = patches;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const updated = await page.getByText("Profile updated").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  db = await memberById(uid);
  const evU = await events(uid);
  L.check("retry", "R5 retry sends one PATCH: phone stored as +447700900123, status inactive, one active→inactive event by the owner",
    updated && patches - pb === 1 && db?.phone === "+447700900123" && db?.status === "inactive" &&
      evU.filter((e) => e.fromStatus === "active" && e.toStatus === "inactive" && e.changedById === ownerId && e.reason === "staff_edit").length === 1,
    { updated, requests: patches - pb, phone: db?.phone, status: db?.status, events: evU.length });
  await page.reload();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await phone.waitFor();
  L.check("retry", "R6 after reload the edit form shows the saved phone and status", (await phone.inputValue()) === "+447700900123" && (await status.inputValue()) === "inactive",
    { phone: await phone.inputValue(), status: await status.inputValue() });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // ── F. Guardian and child ──────────────────────────────────────────────────
  const parentEmail = mail("parent");
  const g1 = await api(page, "POST", "/api/members", { name: `AM Parent ${tag}`, email: parentEmail, accountType: "parent" });
  const parent = await memberByEmail(parentEmail);
  L.check("guardian", "G1 a parent (guardian) account is created: 201, accountType parent, top-level", g1.status === 201 && parent?.accountType === "parent" && parent?.parentMemberId === null, { status: g1.status, accountType: parent?.accountType });
  const y = new Date().getUTCFullYear() - 8;
  const KID = `AM Kid ${tag}`;
  const g2 = await api(page, "POST", "/api/members", { name: KID, parentMemberId: parent?.id, dateOfBirth: `${y}-06-15` });
  const kid = g2.json?.id ? await memberById(g2.json.id) : null;
  L.check("guardian", "G2 a child linked by parentMemberId: 201, accountType kids (age 8), confirmed link, no password, no-login address",
    g2.status === 201 && kid?.accountType === "kids" && kid?.parentMemberId === parent?.id && kid?.guardianConfirmedAt !== null && kid?.passwordHash === null && /@no-login\.matflow\.local$/.test(kid?.email ?? ""),
    { status: g2.status, accountType: kid?.accountType, linked: kid?.parentMemberId === parent?.id, confirmed: !!kid?.guardianConfirmedAt, noLogin: /@no-login\.matflow\.local$/.test(kid?.email ?? "") });
  L.check("guardian", "G3 no invite email was attempted for the child (no EmailLog row for its address)", kid ? (await q(`select 1 from "EmailLog" where "tenantId" = $1 and recipient = $2`, [tenantId, kid.email])).length === 0 : false, "none");
  const orphanName = `AM Orphan ${tag}`;
  const g4 = await api(page, "POST", "/api/members", { name: orphanName, accountType: "kids" });
  L.check("guardian", "G4 a kids account without a parent is refused: 400 'Kid sub-accounts require a parent member', no row",
    g4.status === 400 && g4.json?.error === "Kid sub-accounts require a parent member" && (await countMembers(`name = $2`, [orphanName])) === 0, { status: g4.status, error: g4.json?.error });
  const g5 = await api(page, "POST", "/api/members", { name: `AM Nested ${tag}`, parentMemberId: kid?.id, dateOfBirth: `${y}-06-15` });
  L.check("guardian", "G5 a child of a child is refused: 400 'Cannot nest sub-accounts: parent must be top-level'",
    g5.status === 400 && g5.json?.error === "Cannot nest sub-accounts: parent must be top-level" && (await countMembers(`name = $2`, [`AM Nested ${tag}`])) === 0, { status: g5.status, error: g5.json?.error });
  let pgErr = null;
  try { await q(`update "Member" set "parentMemberId" = null where id = $1 and "tenantId" = $2`, [kid?.id, tenantId]); } catch (e) { pgErr = { code: e.code, constraint: e.constraint }; }
  L.check("guardian", "G6 Postgres refuses unlinking a kids row: 23514 Member_kids_must_have_parent, link intact",
    pgErr?.code === "23514" && pgErr?.constraint === "Member_kids_must_have_parent" && (await memberById(kid?.id))?.parentMemberId === parent?.id, pgErr);
  await page.goto(`/dashboard/members/${kid?.id}`);
  const famParent = await page.getByText("sub-account", { exact: true }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  L.check("guardian", "G7 the child's page shows the Family card with Parent → the parent's name (sub-account)",
    famParent && (await page.getByText("Parent", { exact: true }).count()) > 0 && (await page.getByRole("link", { name: `AM Parent ${tag}` }).count()) > 0, { famParent });
  await shot(page, "accounts-family-child");
  await page.goto(`/dashboard/members/${parent?.id}`);
  const famChild = await page.getByRole("link", { name: new RegExp(KID) }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  L.check("guardian", "G8 the parent's page lists the child under Family with the kids label", famChild && (await page.getByRole("link", { name: new RegExp(`${KID}.*kids`) }).count()) > 0, { famChild });

  // ── G. Phone width (session from before the password reset) ────────────────
  const phoneCtx = await context(browser, "10.94.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phoneCtx.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/members", `/dashboard/members/${uid}`, `/dashboard/members/${kid?.id}`]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    const m = await noScroll(p2);
    L.check("mobile", `M1 ${path.replace(/[a-z0-9]{20,}/, "<id>")} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
  }
  await p2.goto("/dashboard/members");
  await p2.getByRole("button", { name: "Add member", exact: true }).first().click();
  await p2.getByRole("dialog").getByLabel("Full Name", { exact: true }).waitFor();
  const md = await noScroll(p2);
  L.check("mobile", "M2 the Add Member dialog at 390 px has no horizontal page scroll", md.scroll <= md.width + 1, md);
  const box = await p2.getByRole("dialog").getByRole("button", { name: "Add Member", exact: true }).boundingBox();
  L.note("mobile", "M3 Add Member tap target at 390 px (44 px is the target)", box ? `${Math.round(box.width)}×${Math.round(box.height)} px` : "not visible");
  await shot(p2, "accounts-mobile-add-member");
  await phoneCtx.close();

  // ── H. Forgot password: real mail-dark state, then SIMULATED delivery ──────
  const ownerEmail = club.owner.email;
  const tokenCount = async () => Number((await q(`select count(*)::int as n from "PasswordResetToken" where "tenantId" = $1 and email = $2`, [tenantId, ownerEmail]))[0].n);
  const resetLogCount = async () => (await emailLogs(ownerEmail, "password_reset")).length;
  const anon = await context(browser, "10.94.0.3");
  const ap = await anon.newPage();
  ap.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  const lookup = await anon.request.get(`/api/tenant/${club.slug}`);
  const lookupJson = await lookup.json().catch(() => null);
  L.check("reset", "P1 the club lookup reports emailDelivery 'off' on this server", lookup.status() === 200 && lookupJson?.emailDelivery === "off", { status: lookup.status(), emailDelivery: lookupJson?.emailDelivery });
  await ap.goto("/login");
  await ap.getByLabel("Club code").fill(club.slug);
  await ap.keyboard.press("Enter");
  await ap.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await ap.getByLabel("Email address").first().fill(ownerEmail);
  const offSentence = await ap.getByText("Email is turned off for this club, so we can't send a reset code or sign-in link.").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("reset", "P2 the sign-in screen says email is off and offers no 'Forgot password?' button",
    offSentence && (await ap.getByRole("button", { name: "Forgot password?" }).count()) === 0, { offSentence });
  await shot(ap, "accounts-login-email-off");

  // Simulation: only the browser is told delivery is on, so the reset screen is reachable. The server stays mail-dark.
  step("P3 counts before");
  const tokensBefore = await tokenCount();
  const logsBefore = await resetLogCount();
  step("P3 sim context");
  const sim = await context(browser, "10.94.0.4");
  const sp = await sim.newPage();
  sp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  // The club lookup is read once up front and served from memory with emailDelivery "on": a route handler that
  // calls r.fetch() for the same URL hung the first run (23 Oct, 24 min with no timeout firing).
  step("P3 tenant pre-read");
  const tenantJson = await within((async () => (await sp.request.get(`/api/tenant/${club.slug}`)).json())(), 60000, "tenant pre-read").catch(() => ({}));
  await sp.route(`**/api/tenant/${club.slug}`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...tenantJson, emailDelivery: "on" }) }),
  );
  step("P3 login page");
  await sp.goto("/login");
  await sp.getByLabel("Club code").fill(club.slug);
  await sp.keyboard.press("Enter");
  await sp.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await sp.getByLabel("Email address").first().fill(ownerEmail);
  step("P3 forgot-password click");
  const [fp] = await Promise.all([
    sp.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/forgot-password", { timeout: 30000 }),
    sp.getByRole("button", { name: "Forgot password?" }).click(),
  ]);
  // Playwright never delivers this response's body to fp.json() (23 Oct: the read stalled; with no timeout it hung the
  // journey 24 min and then 5 h; with a 30 s timeout it returned nothing). So P3 asserts what the click shows (status and
  // the code screen), and P3b sends the click's own request body again from inside the page with fetch, which reads the
  // body normally. Two requests stay inside the route's limit of 3 per 15 minutes per club and address.
  const sentBody = fp.request().postDataJSON();
  const checkEmail = await sp.getByText("Check your email").first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("reset", "P3 'Forgot password?' posts forgot-password: 200 and the code screen opens",
    fp.status() === 200 && checkEmail, { status: fp.status(), checkEmail });
  step("P3b forgot-password body via in-page fetch");
  const fp2 = await within(sp.evaluate(async (b) => {
    const r = await fetch("/api/auth/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, sentBody), 30000, "forgot-password in-page fetch").catch((e) => ({ status: null, json: null, error: String(e) }));
  L.check("reset", "P3b the same request answers 200 {ok:true} (the body every 200 path of the route returns, so no address is revealed)",
    fp2.status === 200 && fp2.json?.ok === true && Object.keys(fp2.json ?? {}).length === 1, fp2);
  if (fp.status() === 429 || fp2.status === 429) L.note("reset", "N2 forgot-password is limited to 3 per 15 minutes per club+address; re-run after the window", { click: fp.status(), replay: fp2.status });
  L.check("reset", "P4 with delivery off the server minted no reset code and wrote no password_reset EmailLog row",
    (await tokenCount()) === tokensBefore && (await resetLogCount()) === logsBefore, { tokens: (await tokenCount()) - tokensBefore, emailLogs: (await resetLogCount()) - logsBefore });

  // Simulated delivery: mint the code the route WOULD have sent, stored exactly as it stores one.
  const env = testEnv();
  const usable = (v) => (v !== undefined && v.trim() !== "" ? v : undefined);
  const SECRET = usable(env.NEXTAUTH_SECRET) ?? usable(env.AUTH_SECRET) ?? "";
  const resetHash = (code) => createHmac("sha256", SECRET).update(["auth-token-subject.reset.v1", tenantId, "user", ownerId, code].join("\n")).digest("hex");
  const seedCode = async () => {
    const code = String(randomInt(100000, 999999));
    const id = randomUUID();
    await q(`insert into "PasswordResetToken" (id, email, "tenantId", "tokenHash", "expiresAt") values ($1, $2, $3, $4, $5)`,
      [id, ownerEmail, tenantId, resetHash(code), new Date(Date.now() + 110_000).toISOString()]);
    return { code, id };
  };
  const tokenRow = async (id) => (await q(`select used from "PasswordResetToken" where id = $1`, [id]))[0] ?? null;
  const userRow = async () => (await q(`select "passwordHash", "sessionVersion", "lockedUntil" from "User" where id = $1`, [ownerId]))[0];
  const historyCount = async () => Number((await q(`select count(*)::int as n from "PasswordHistory" where "userId" = $1`, [ownerId]))[0].n);
  const ORIGINAL = club.owner.password;
  const NEW = `Mf${randomBytes(9).toString("base64url")}9aZ`;
  const u0 = await userRow();
  const h0 = await historyCount();
  // Control for P7 (review 23 Oct): the same page reads the route successfully just before the reset, so a 401 after it
  // can only mean the reset revoked this session, not that the page had none.
  const preReset = await api(page, "GET", "/api/payments/outstanding");
  L.check("reset", "P6a control: before the reset, the owner's existing session reads /api/payments/outstanding (200)", preReset.status === 200, { status: preReset.status });
  const t1 = await seedCode();
  const wrong = t1.code === "123456" ? "654321" : "123456";
  const codeBox = sp.getByLabel("Six-digit authentication code");
  await codeBox.fill(wrong);
  await sp.getByLabel("New password (min. 10 characters)").fill(NEW);
  await sp.getByLabel("Confirm new password").fill(NEW);
  await sp.getByRole("button", { name: "Set new password" }).click();
  const badSeen = await sp.getByRole("alert").filter({ hasText: BAD_CODE }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("reset", "P5 a wrong code: the alert says invalid or expired, typed password kept, nothing changed, the real code unused",
    badSeen && (await sp.getByLabel("New password (min. 10 characters)").inputValue()) === NEW && (await userRow()).passwordHash === u0.passwordHash && (await tokenRow(t1.id))?.used === false, { badSeen });
  await codeBox.fill(t1.code);
  await sp.getByRole("button", { name: "Set new password" }).click();
  const done = await sp.getByText("Password updated").first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  const u1 = await userRow();
  L.check("reset", "P6 the right code: 'Password updated'; code used; new hash matches; sessionVersion +1; old hash kept in history; lock cleared",
    done && (await tokenRow(t1.id))?.used === true && (await bcrypt.compare(NEW, u1.passwordHash)) && u1.sessionVersion === u0.sessionVersion + 1 && (await historyCount()) === h0 + 1 && u1.lockedUntil === null,
    { done, used: (await tokenRow(t1.id))?.used, sessionVersion: [u0.sessionVersion, u1.sessionVersion], history: [h0, await historyCount()] });
  await shot(sp, "accounts-reset-done");
  const stale401 = await api(page, "GET", "/api/payments/outstanding");
  // The reset bumps sessionVersion, so the old token no longer yields a session and proxy.ts:185-187 answers every /api/*
  // call first with 401 {ok:false, error:"Unauthorized"}; the route's own gate (lib/api-authz.ts:70, the "expired"
  // sentence) is never reached. Corrected 23 Oct: the earlier expectation named the route's sentence, not the proxy's.
  L.check("reset", "P7 the session signed in before the reset is refused by the proxy: 401 {ok:false, error:'Unauthorized'}, no data",
    stale401.status === 401 && stale401.json?.ok === false && stale401.json?.error === "Unauthorized" && Object.keys(stale401.json ?? {}).length === 2, { status: stale401.status, body: stale401.json });
  const fresh = await context(browser, "10.94.0.5");
  const fpage = await fresh.newPage();
  fpage.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(fpage, { ...club, owner: { ...club.owner, password: NEW } });
  L.check("reset", "P8 sign-in with the new password + authenticator lands on the dashboard", /\/dashboard/.test(fpage.url()), new URL(fpage.url()).pathname);
  // The fixture password is random base64url: if it happens to miss a digit or a case, the staff policy answers before
  // the reuse rule (reset-password route: validatePassword runs first), so P9 can only be asserted when it passes policy.
  if (/[A-Z]/.test(ORIGINAL) && /[a-z]/.test(ORIGINAL) && /[0-9]/.test(ORIGINAL) && ORIGINAL.length >= 10) {
    const t2r = await seedCode();
    const reuse = await api(fpage, "POST", "/api/auth/reset-password", { token: t2r.code, email: ownerEmail, tenantSlug: club.slug, password: ORIGINAL });
    L.check("reset", "P9 resetting back to the original password is refused (history): 400 with the reuse sentence, password unchanged",
      reuse.status === 400 && reuse.json?.error === REUSE && (await bcrypt.compare(NEW, (await userRow()).passwordHash)), { status: reuse.status, error: reuse.json?.error });
    await q(`delete from "PasswordResetToken" where id = $1`, [t2r.id]);
  } else {
    L.note("reset", "P9 not asserted: this fixture's random owner password does not meet the staff password policy, so the policy answers first", "re-create the fixture to exercise it");
  }
  // Restore so later journeys keep working: the product refuses it (P9), so the original hash is written directly.
  await q(`update "User" set "passwordHash" = $1, "failedLoginCount" = 0, "lockedUntil" = null where id = $2 and "tenantId" = $3`, [await bcrypt.hash(ORIGINAL, 10), ownerId, tenantId]);
  L.check("reset", "P10 original owner password restored (bcrypt matches the fixture password)", await bcrypt.compare(ORIGINAL, (await userRow()).passwordHash), "restored via q(); sessions from before the reset stay revoked");
  L.note("reset", "N3 delivery was SIMULATED: the server is mail-dark (no code minted, no EmailLog); the browser was told delivery is on and the code was seeded with the route's own subject-bound hash", "see source notes");

  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
