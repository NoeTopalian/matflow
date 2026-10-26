// Journey: permissions matrix and cross-tenant isolation (release QA, 23 Oct 2026).
// Seeds a manager, coach and admin (users), a member and a guardian with a linked child (members) into the fixture club,
// signs each in through the real /login form (password, plus the authenticator for enrolled accounts), then calls the
// APIs DIRECTLY with that role's cookies and asserts the HTTP status, the exact refusal sentence and that the stored row
// did not change. Hidden buttons are not evidence and are not looked at. Then a second synthetic club with the SAME NAME
// (slug "<fixture>-b") is seeded and every id-bearing route is called by the first club's owner (and its guardian/member
// for the family routes) against the second club's ids: expected 404/403/400-as-pinned and no row changed in either club.
// Then the operator door. The second club and the operator row are removed at the end; the club-A seeds stay until
// `fixture.mjs teardown`. Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/permissions-matrix.mjs
//
// ── Source notes (batch-c unless marked batch-d; refusal sentences are asserted verbatim) ─────────────────────────────
// Roles: lib/authz.ts:29 STAFF_ROLES owner, manager, coach, admin; a Member signs in with role "member" (auth.ts:744) —
//   a guardian is a Member with accountType "parent" and the same role; children (accountType kids) cannot sign in.
//   Elevated roles owner/manager/admin must have an authenticator (lib/mfa-policy.ts:15; auth.ts:711) or every API answers
//   403 "Enrol your authenticator to continue." (lib/api-authz.ts:91) — so manager and admin are seeded ENROLLED, or the
//   matrix would record that refusal instead of the role gate. A coach's authenticator is optional (not enrolled here).
//   Member sign-in: password on the same /login form (auth.ts:726-758); staff → /dashboard, member → /member/home (proxy.ts:488).
// Gates and refusal sentences
//   requireApi* → 403 "You do not have permission to do this." (lib/api-authz.ts:78); 401 "Your session has expired. Please sign in again." (:70)
//   POST /api/memberships ................ owner      batch-d app/api/memberships/route.ts:61 (batch-c :51) requireApiOwner
//   PATCH|DELETE /api/memberships/[id] ... owner      batch-d app/api/memberships/[id]/route.ts:42,122 (batch-c :33,93); not found 404 "Not found" (batch-d :94,133)
//   POST /api/classes .................... owner, manager  batch-d app/api/classes/route.ts:63-64 "Forbidden"
//   PATCH|DELETE /api/classes/[id] ....... owner, manager  batch-d app/api/classes/[id]/route.ts:370-371, 799-800 "Forbidden"; not found 404 "Not found" (:501, :824); DELETE = archive (deletedAt)
//   POST /api/classes/[id]/roster ........ owner, manager, admin  app/api/classes/[id]/roster/route.ts:35-37 "Forbidden"; :84 404 "Class or member not found in this tenant"
//   DELETE /api/classes/[id]/roster/[m] .. owner, manager, admin  app/api/classes/[id]/roster/[memberId]/route.ts:13-15 "Forbidden"; :41 404 "Roster entry not found"
//   PATCH /api/members/[id] .............. owner, manager, admin  app/api/members/[id]/route.ts:202-203 "Forbidden"; 404 "Not found" (:546); :264 400 "Membership tier not found"
//   GET /api/members ..................... staff        app/api/members/route.ts:59-60 "Forbidden"
//   GET /api/members/[id] ................ staff        app/api/members/[id]/route.ts:39-40 "Forbidden"; not found 404
//   POST /api/members .................... owner, manager, admin  app/api/members/route.ts:263-264; :325 404 "Parent member not found in this tenant"; :385 400 "Membership tier not found"
//   PATCH /api/settings .................. owner        app/api/settings/route.ts:195-196 403 "Only owners can change gym settings" (batch-d :193-194, same)
//   GET /api/settings .................... owner        app/api/settings/route.ts:142 requireApiOwner
//   GET /api/reports ..................... owner, manager  app/api/reports/route.ts:16-17 "Forbidden"
//   GET /api/payments/outstanding ........ owner, manager  app/api/payments/outstanding/route.ts:29 requireApiOwnerOrManager
//   POST /api/payments/chase ............. owner, manager  app/api/payments/chase/route.ts:40; :73 404 "Member not found"; writes EmailLog payment_failed + AuditLog payment.chase (:117)
//   /api/admin/activity, /api/admin/customers/[id]/suspend ... operator only: isAdminAuthed → 403 "Forbidden"
//                                          (app/api/admin/activity/route.ts:17; app/api/admin/customers/[id]/suspend/route.ts:67)
//   POST /api/admin/impersonate .......... operator only: app/api/admin/impersonate/route.ts:113-116 403 "Forbidden"
//   PATCH /api/member/children/[id] ...... the confirmed guardian only: app/api/member/children/[id]/route.ts:125 staff → 403
//                                          "Not a member account"; :144 family fields → 403 "Family relationships are managed by club staff.";
//                                          :175 where {id, tenantId, parentMemberId, confirmed}; :192 404 "Not found"
//   DELETE /api/member/children/[id] ..... owner/manager only (:247 assertMayMutateFamily) → member 403 "Family relationships are managed by club staff." (:249)
//   GET /api/member/children/[id] ........ :60 404 "Not found" unless the child is the session member's own
// CSRF (lib/csrf.ts:90 "Forbidden: cross-origin request rejected") runs BEFORE the role gate on mutations, so every call
// is a same-origin fetch from the signed-in page, and the exact role-gate sentence is asserted to rule CSRF out.
// Operator / support session: lib/operator-auth.ts:408-412 with OPERATOR_ALLOWED_IDS unset, no operator is allowed in a
// production-like process (NODE_ENV=production — `next start`); .env.test has no OPERATOR_ALLOWED_IDS, so the expected
// answer at app/api/admin/auth/operator-totp/route.ts:153 is 403 "This operator account is not permitted to use the
// operator console." (lib/operator-auth.ts:386). A support session (POST /api/admin/impersonate) also needs an operator
// step-up (lib/operator-step-up.ts) and is NOT automated here; if the door opens, that leg is recorded as a NOTE.
// Wrong club: the club code picks the tenant (auth.ts:441-444); the first club's owner on the second club's code gets the
// generic "Incorrect email or password." (app/login/page.tsx:83).
//
// ── X22–X26 (added 23 Oct 2026 for the combined candidate, HEAD c79b3ee6; lines are that tree's) ─────
// X22 class membership list (allowedTierIds) carrying club B's tier:
//   POST app/api/classes/route.ts:99-106 classRefError pre-check → 400 { error } with CLASS_REF_ERRORS.tier
//   "That membership is not one of this club's memberships" (lib/class-refs.ts:30, check at :56-); the in-transaction
//   re-read :148-152 throws TierRefError → :215-216 the same 400 sentence. PATCH app/api/classes/[id]/route.ts:427-428 →
//   :502 400 { error: pre.error }; in-transaction :558 TierRefError → :766-767 the same sentence. Asserted: 400 + that
//   sentence, no ClassMembershipTier row, no "PM X Class". Control: PATCH club A's class with club A's tier → 200, then [] → 200.
// X23 doors: POST /api/checkin (app/api/checkin/route.ts): staff path :84-118 → 404 "Class not found" (:115) or
//   "Member not found" (:117); guardian path :121-136 → 404 "Member not found" (:136); audit attendance.mark only on
//   success (:215-236). POST /api/checkin/card (app/api/checkin/card/route.ts): :119 requireApiStaff; instance outside
//   the club → :175 404 "Class not found"; per token verifyCardToken(token, tenantId) → :204 result status
//   "wrong_tenant" for another club's card, :230 "member_not_found" for a member outside the club (200 body :345);
//   audit attendance.card_scan only when recorded > 0 (:326-330).
//   Card token = lib/card-token.ts:133-159 (key HMAC(root,"matflow.card.v1") :92, keyId :97-103 HMAC(key,
//   "matflow.card.keyid") first 6 b64url chars, payload {tenantId, memberId, cardVersion, purpose:"card", keyId, exp}).
//   Kiosk POST /api/kiosk/[token]/checkin (app/api/kiosk/[token]/checkin/route.ts): tenant by Tenant.kioskTokenHash =
//   hashToken(raw) (:63-66); member token verified against THAT tenant (:83-85) → 400 "Member token invalid or expired";
//   engine "Class not found" 404 (:148) / "Member not found" 404 (:180). Member token = lib/kiosk-token.ts:83-95
//   (key HMAC(root,"matflow.kiosk.v1") :54, payload {tenantId, memberId, exp}). The journey signs tokens with the
//   .env.test secret (never printed) and proves the format with a control on club A first.
// X24 undo: POST /api/audit-log/[id]/undo (app/api/audit-log/[id]/undo/route.ts:25 requireApiOwner; :37 row looked up
//   {id, tenantId}; :54 404 "That activity row was not found."); POST /api/audit-log/undo-to (undo-to/route.ts:38
//   requireApiOwner; :57 target {id: auditId, tenantId, userId}; :92 404 "That row was not found for that staff member.").
//   UNDO_PREFIX "undo." (lib/audit-labels.ts:261). Club B gets a real member.update row (active→inactive) whose undo
//   would flip its member back to active.
// X25 GET /api/member/me/allowance (app/api/member/me/allowance/route.ts:22-38) takes NO id: it reads
//   session.user.memberId only. Asserted: the same 200 body with or without club B ids in the query, nothing of B in it.
// X26 the allowance "Admit anyway" door: app/api/checkin/route.ts:86-87 every staff role (owner, manager, coach, admin)
//   may mark a member; :199-200 staff get allowanceGate "ask" and are admitted only with acknowledged
//   ["allowance_reached"]; :203 checkedInById = the acting user; :215-233 audit attendance.mark with userId = the acting
//   user, metadata.overrides and overAllowance. Without the acknowledgement: lib/checkin-refusal.ts:184-200 → 403
//   reason "allowance_reached", askable, allowance {used, limit, basis}. lib/authz.ts:29 STAFF_ROLES. So coach AND admin
//   may admit past the allowance; a member on the staff door gets 403 "Forbidden" (:87).
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, bcrypt, newSecret, freshCode, BASE } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
if (!club.slug.startsWith("mfv-")) throw new Error("refusing: not a fixture club");
const L = ledger("permissions-matrix");
const A = club.tenantId;
const S = club.slug;
const SLUG_B = `${S}-b`;
const errors = [];

const NO_PERMISSION = "You do not have permission to do this.";
const OPERATOR_REFUSED = "This operator account is not permitted to use the operator console.";
const FAMILY_STAFF = "Family relationships are managed by club staff.";
const pw = () => `Pm${randomBytes(9).toString("base64url")}7x`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const one = async (sql, params) => (await q(sql, params))[0] ?? null;
const n = async (sql, params) => Number((await q(sql, params))[0].n);

/** fetch from inside the signed-in page (same origin, so the CSRF guard sees a real Origin). */
const api = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const init = { method, redirect: "manual", headers: {} };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  try {
    const r = await fetch(path, init);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: -1, json: null, text: String(e).slice(0, 200) }; }
}, { method, path, body });

/** The real /login form for any account; the authenticator step only when the server asks for it. */
async function signIn(page, slug, email, password, secret) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 60000 });
  if (new URL(page.url()).pathname.startsWith("/login/totp")) {
    if (!secret) throw new Error(`${email} was asked for an authenticator code but has none`);
    await page.getByLabel("Six-digit authentication code").fill(await freshCode(secret));
    await page.keyboard.press("Enter");
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
}

// ── Seed club A (idempotent: re-runs reuse the rows by address / name) ─────────
const upsertUser = async (role, email, password, secret) => (await q(
  `insert into "User" (id, "tenantId", email, "passwordHash", name, role, "totpEnabled", "totpSecret", "updatedAt")
   values ($1, $2, $3, $4, $5, $6, $7, $8, now())
   on conflict ("tenantId", email) do update set "passwordHash" = excluded."passwordHash", role = excluded.role,
     "totpEnabled" = excluded."totpEnabled", "totpSecret" = excluded."totpSecret", "totpLastUsedStep" = null,
     "failedLoginCount" = 0, "lockedUntil" = null, "mustChangePassword" = false, "updatedAt" = now()
   returning id`,
  [randomUUID(), A, email, await bcrypt.hash(password, 10), `PM ${role}`, role, !!secret, secret ?? null]))[0].id;
const upsertMember = async (tenantId, { email, name, accountType, password = null, parentMemberId = null }) => (await q(
  `insert into "Member" (id, "tenantId", email, name, status, "accountType", "passwordHash", "parentMemberId", "guardianConfirmedAt",
                         "onboardingCompleted", "waiverAccepted", "updatedAt")
   values ($1, $2, $3, $4, 'active', $5, $6, $7, case when $7::text is null then null else now() end, true, true, now())
   on conflict ("tenantId", email) do update set name = excluded.name, status = 'active', "accountType" = excluded."accountType",
     "passwordHash" = excluded."passwordHash", "parentMemberId" = excluded."parentMemberId", "guardianConfirmedAt" = excluded."guardianConfirmedAt",
     "failedLoginCount" = 0, "lockedUntil" = null, "updatedAt" = now()
   returning id`,
  [randomUUID(), tenantId, email, name, accountType, password ? await bcrypt.hash(password, 10) : null, parentMemberId]))[0].id;
const ensureTier = async (tenantId, name) => {
  const ex = await one(`select id from "MembershipTier" where "tenantId" = $1 and name = $2`, [tenantId, name]);
  if (ex) { await q(`update "MembershipTier" set "isActive" = true, "pricePence" = 5000 where id = $1`, [ex.id]); return ex.id; }
  const id = randomUUID();
  await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $2, $3, 5000, 'GBP', 'monthly', now())`, [id, tenantId, name]);
  return id;
};
const ensureClass = async (tenantId, name) => {
  const ex = await one(`select id from "Class" where "tenantId" = $1 and name = $2`, [tenantId, name]);
  if (ex) { await q(`update "Class" set "isActive" = true, "deletedAt" = null where id = $1`, [ex.id]); return ex.id; }
  const id = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 30)`, [id, tenantId, name]);
  return id;
};

const ROLE = {
  manager: { email: `${S}-pm-manager@example.test`, password: pw(), secret: newSecret(), lane: "10.95.0.2" },
  coach: { email: `${S}-pm-coach@example.test`, password: pw(), secret: null, lane: "10.95.0.3" },
  admin: { email: `${S}-pm-admin@example.test`, password: pw(), secret: newSecret(), lane: "10.95.0.4" },
  member: { email: `${S}-pm-member@example.test`, password: pw(), secret: null, lane: "10.95.0.5" },
  guardian: { email: `${S}-pm-guardian@example.test`, password: pw(), secret: null, lane: "10.95.0.6" },
};
for (const r of ["manager", "coach", "admin"]) ROLE[r].id = await upsertUser(r, ROLE[r].email, ROLE[r].password, ROLE[r].secret);
ROLE.member.id = await upsertMember(A, { email: ROLE.member.email, name: "PM Member", accountType: "adult", password: ROLE.member.password });
ROLE.guardian.id = await upsertMember(A, { email: ROLE.guardian.email, name: "PM Guardian", accountType: "parent", password: ROLE.guardian.password });
const KID_A_NAME = "PM Kid A";
const kidA = await upsertMember(A, { email: `${S}-pm-kid@example.test`, name: KID_A_NAME, accountType: "kids", parentMemberId: ROLE.guardian.id });
const tierA = await ensureTier(A, "PM Tier A");
const classA = await ensureClass(A, "PM Class A");
const m1 = (await one(`select id from "Member" where "tenantId" = $1 and name = 'Member 1'`, [A]))?.id;
const m2Row = await one(`select id, email from "Member" where "tenantId" = $1 and name = 'Member 2'`, [A]);
if (!m1 || !m2Row) throw new Error("fixture has no Member 1 / Member 2");
const m2 = m2Row.id;
await q(`delete from "ClassRoster" where "classId" = $1 and "memberId" = $2`, [classA, m1]);
await q(`insert into "ClassRoster" (id, "tenantId", "classId", "memberId") values ($1, $2, $3, $4) on conflict ("classId", "memberId") do nothing`, [randomUUID(), A, classA, m2]);
L.note("seed", "N1 club A seeded: manager+admin enrolled, coach not, member, guardian with a confirmed child, PM Tier A, PM Class A, Member 2 on its roster", { roles: Object.keys(ROLE) });

// ── Seed club B: same NAME as club A, different slug ──────────────────────────
async function teardownB() {
  const t = await one(`select id from "Tenant" where slug = $1`, [SLUG_B]);
  if (!t) return { tenant: 0 };
  if (!SLUG_B.startsWith("mfv-")) throw new Error("refusing: not a fixture slug");
  const failed = [];
  for (const sql of [
    `delete from "ClassRoster" where "tenantId" = $1`,
    `delete from "AttendanceRecord" where "tenantId" = $1`,
    `delete from "ClassSubscription" where "classId" in (select id from "Class" where "tenantId" = $1)`,
    `delete from "ClassSchedule" where "classId" in (select id from "Class" where "tenantId" = $1)`,
    `delete from "ClassInstance" where "classId" in (select id from "Class" where "tenantId" = $1)`,
    `delete from "ClassMembershipTier" where "tenantId" = $1`,
    `delete from "Class" where "tenantId" = $1`,
    `delete from "MemberStatusEvent" where "tenantId" = $1`,
    `delete from "AuditLog" where "tenantId" = $1`,
    `delete from "EmailLog" where "tenantId" = $1`,
    `delete from "MagicLinkToken" where "tenantId" = $1`,
    `delete from "Member" where "tenantId" = $1 and "parentMemberId" is not null`,
    `delete from "Member" where "tenantId" = $1`,
    `delete from "MembershipTier" where "tenantId" = $1`,
    `delete from "User" where "tenantId" = $1`,
    `delete from "Tenant" where id = $1`,
  ]) { try { await q(sql, [t.id]); } catch (e) { if (!/does not exist/.test(String(e.message))) failed.push(`${sql.slice(0, 40)}: ${String(e.message).slice(0, 80)}`); } }
  return { tenant: await n(`select count(*)::int as n from "Tenant" where id = $1`, [t.id]), members: await n(`select count(*)::int as n from "Member" where "tenantId" = $1`, [t.id]), failed };
}
await teardownB();
const B = { tenantId: randomUUID(), tier: randomUUID(), cls: randomUUID() };
await q(`insert into "Tenant" (id, name, slug, "onboardingCompleted", "subscriptionStatus") values ($1, $2, $3, true, 'trial')`, [B.tenantId, club.name, SLUG_B]);
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $2, 'PM B Tier', 4000, 'GBP', 'monthly', now())`, [B.tier, B.tenantId]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'PM B Class', 60, 20)`, [B.cls, B.tenantId]);
B.m1 = await upsertMember(B.tenantId, { email: `${SLUG_B}-m1@example.test`, name: "PM B Only Member", accountType: "adult" });
B.guardian = await upsertMember(B.tenantId, { email: `${SLUG_B}-guardian@example.test`, name: "PM B Guardian", accountType: "parent" });
B.kid = await upsertMember(B.tenantId, { email: `${SLUG_B}-kid@example.test`, name: "PM B Kid", accountType: "kids", parentMemberId: B.guardian });
await q(`insert into "ClassRoster" (id, "tenantId", "classId", "memberId") values ($1, $2, $3, $4)`, [randomUUID(), B.tenantId, B.cls, B.m1]);
// X23/X24 inputs: a session of B's class today, B's owner, and a real member.update audit row (active → inactive).
const clubDay = async (tenantId) => {
  const tz = (await one(`select timezone from "Tenant" where id = $1`, [tenantId]))?.timezone || "Europe/London";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T00:00:00.000Z`;
};
B.inst = randomUUID();
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, '10:00', '11:00')`, [B.inst, B.cls, await clubDay(B.tenantId)]);
B.owner = randomUUID();
await q(`insert into "User" (id, "tenantId", email, "passwordHash", name, role, "updatedAt") values ($1, $2, $3, $4, 'PM B Owner', 'owner', now())`,
  [B.owner, B.tenantId, `${SLUG_B}-owner@example.test`, await bcrypt.hash(pw(), 10)]);
await q(`update "Member" set status = 'inactive' where id = $1`, [B.m1]);
B.audit = randomUUID();
await q(`insert into "AuditLog" (id, "userId", "tenantId", action, "entityType", "entityId", metadata) values ($1, $2, $3, 'member.update', 'Member', $4, $5)`,
  [B.audit, B.owner, B.tenantId, B.m1, JSON.stringify({ fields: ["status"], source: "staff", changes: { status: { from: "active", to: "inactive" } } })]);
const sameName = await q(`select slug from "Tenant" where name = $1 and slug in ($2, $3)`, [club.name, S, SLUG_B]);
L.check("seed", "S1 two clubs now share the name; only the slug differs", sameName.length === 2, sameName.map((r) => r.slug));
const snapB = async () => ({
  tier: await one(`select name, "pricePence", "isActive" from "MembershipTier" where id = $1`, [B.tier]),
  cls: await one(`select name, "isActive", "deletedAt" from "Class" where id = $1`, [B.cls]),
  roster: await q(`select "classId", "memberId" from "ClassRoster" where "tenantId" = $1 order by "memberId"`, [B.tenantId]),
  members: await q(`select id, name, status, "membershipTierId", "parentMemberId", phone from "Member" where "tenantId" = $1 order by id`, [B.tenantId]),
  events: await n(`select count(*)::int as n from "MemberStatusEvent" where "tenantId" = $1`, [B.tenantId]),
  audit: await n(`select count(*)::int as n from "AuditLog" where "tenantId" = $1`, [B.tenantId]),
  email: await n(`select count(*)::int as n from "EmailLog" where "tenantId" = $1`, [B.tenantId]),
  attendance: await n(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 or "memberId" = $2 or "classInstanceId" = $3`, [B.tenantId, B.m1, B.inst]),
  classTiers: await n(`select count(*)::int as n from "ClassMembershipTier" where "tenantId" = $1 or "tierId" = $2`, [B.tenantId, B.tier]),
});

// ── Probes (club A ids) ─────────────────────────────────────────────────────
const tierSnap = async () => ({ row: await one(`select name, "pricePence", "isActive" from "MembershipTier" where id = $1`, [tierA]), probes: await n(`select count(*)::int as n from "MembershipTier" where "tenantId" = $1 and name = 'PM Probe Tier'`, [A]) });
const classSnap = async () => ({ row: await one(`select name, "isActive", "deletedAt" from "Class" where id = $1`, [classA]), probes: await n(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = 'PM Probe Class'`, [A]) });
const rosterSnap = async () => (await q(`select "memberId" from "ClassRoster" where "classId" = $1 order by "memberId"`, [classA])).map((r) => r.memberId);
const m2Snap = async () => ({ row: await one(`select status, "cancelledAt", "membershipTierId" from "Member" where id = $1`, [m2]), events: await n(`select count(*)::int as n from "MemberStatusEvent" where "memberId" = $1`, [m2]) });
const tenantSnap = async () => one(`select name, "contactEmail", "subscriptionStatus", "suspendedPreviousStatus" from "Tenant" where id = $1`, [A]);
const chaseSnap = async () => ({ email: await n(`select count(*)::int as n from "EmailLog" where "tenantId" = $1 and "templateId" = 'payment_failed' and recipient = $2`, [A, m2Row.email]), audit: await n(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action = 'payment.chase' and "entityId" = $2`, [A, m2]) });
const impSnap = async () => n(`select count(*)::int as n from "AuditLog" where action like 'admin.impersonate%' and ("tenantId" = $1 or "entityId" = $2)`, [A, club.owner.id]);
const STAFF = ["owner", "manager", "coach", "admin"];
const PROBES = [
  { key: "tier.create", method: "POST", path: "/api/memberships", body: { name: "PM Probe Tier", pricePence: 1000, currency: "GBP", billingCycle: "monthly", isKids: false }, allowed: ["owner"], err: NO_PERMISSION, snap: tierSnap },
  { key: "tier.edit", method: "PATCH", path: `/api/memberships/${tierA}`, body: { name: "PM Hijacked", pricePence: 1 }, allowed: ["owner"], err: NO_PERMISSION, snap: tierSnap },
  { key: "tier.archive", method: "DELETE", path: `/api/memberships/${tierA}`, allowed: ["owner"], err: NO_PERMISSION, snap: tierSnap },
  { key: "class.create", method: "POST", path: "/api/classes", body: { name: "PM Probe Class", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }, allowed: ["owner", "manager"], err: "Forbidden", snap: classSnap },
  { key: "class.edit", method: "PATCH", path: `/api/classes/${classA}`, body: { name: "PM Hijacked" }, allowed: ["owner", "manager"], err: "Forbidden", snap: classSnap },
  { key: "class.archive", method: "DELETE", path: `/api/classes/${classA}`, allowed: ["owner", "manager"], err: "Forbidden", snap: classSnap },
  { key: "roster.add", method: "POST", path: `/api/classes/${classA}/roster`, body: { memberId: m1 }, allowed: ["owner", "manager", "admin"], err: "Forbidden", snap: rosterSnap },
  { key: "roster.remove", method: "DELETE", path: `/api/classes/${classA}/roster/${m2}`, allowed: ["owner", "manager", "admin"], err: "Forbidden", snap: rosterSnap },
  { key: "member.status", method: "PATCH", path: `/api/members/${m2}`, body: { status: "cancelled" }, allowed: ["owner", "manager", "admin"], err: "Forbidden", snap: m2Snap },
  { key: "member.list", method: "GET", path: "/api/members", allowed: STAFF, err: "Forbidden" },
  { key: "member.read", method: "GET", path: `/api/members/${m2}`, allowed: STAFF, err: "Forbidden" },
  { key: "settings.edit", method: "PATCH", path: "/api/settings", body: { contactEmail: `${S}-pm-hijack@example.test` }, allowed: ["owner"], err: "Only owners can change gym settings", snap: tenantSnap },
  { key: "settings.read", method: "GET", path: "/api/settings", allowed: ["owner"], err: NO_PERMISSION },
  { key: "reports.read", method: "GET", path: "/api/reports", allowed: ["owner", "manager"], err: "Forbidden" },
  { key: "payments.outstanding", method: "GET", path: "/api/payments/outstanding", allowed: ["owner", "manager"], err: NO_PERMISSION },
  { key: "payments.chase", method: "POST", path: "/api/payments/chase", body: { memberId: m2 }, allowed: ["owner", "manager"], err: NO_PERMISSION, snap: chaseSnap },
  { key: "operator.activity", method: "GET", path: "/api/admin/activity", allowed: [], err: "Forbidden" },
  { key: "operator.suspend", method: "POST", path: `/api/admin/customers/${A}/suspend`, body: {}, allowed: [], err: "Forbidden", snap: tenantSnap },
  { key: "operator.impersonate", method: "POST", path: "/api/admin/impersonate", body: { targetUserId: club.owner.id, reason: "release QA permission probe" }, allowed: [], err: "Forbidden", snap: impSnap },
];

const browser = await chromium.launch();
let opId = null;
try {
  // ── Sign every role in ─────────────────────────────────────────────────────
  const pages = {};
  const ownerCtx = await context(browser, "10.95.0.1");
  pages.owner = await ownerCtx.newPage();
  pages.owner.on("pageerror", (e) => errors.push(`owner: ${String(e).slice(0, 160)}`));
  await ownerSignIn(pages.owner, club);
  for (const r of Object.keys(ROLE)) {
    const c = await context(browser, ROLE[r].lane);
    pages[r] = await c.newPage();
    pages[r].on("pageerror", (e) => errors.push(`${r}: ${String(e).slice(0, 160)}`));
    try { await signIn(pages[r], S, ROLE[r].email, ROLE[r].password, ROLE[r].secret); } catch (e) { L.note("roles", `sign-in ${r} did not complete`, String(e).slice(0, 200)); await shot(pages[r], `perm-signin-${r}`); }
  }
  const expectRole = { owner: "owner", manager: "manager", coach: "coach", admin: "admin", member: "member", guardian: "member" };
  for (const r of Object.keys(expectRole)) {
    const s = await api(pages[r], "GET", "/api/auth/session");
    const u = s.json?.user ?? {};
    L.check("roles", `R-${r} signed in as role '${expectRole[r]}' in club A, second factor settled`,
      s.status === 200 && u.role === expectRole[r] && u.tenantId === A && u.totpPending === false && u.requireTotpSetup === false,
      { status: s.status, role: u.role, sameClub: u.tenantId === A, totpPending: u.totpPending, requireTotpSetup: u.requireTotpSetup, path: new URL(pages[r].url()).pathname });
  }

  // ── The matrix: refusals with the row unchanged; positive controls for allowed reads ──
  const skipped = [];
  for (const p of PROBES) {
    for (const r of Object.keys(expectRole)) {
      if (p.allowed.includes(r)) {
        if (p.method !== "GET") { skipped.push(`${r}:${p.key}`); continue; }
        const res = await api(pages[r], "GET", p.path);
        L.check("matrix", `${r} ${p.key}: ${p.method} ${p.path.replace(/[a-z0-9-]{20,}/g, "<id>")} allowed (positive control)`, res.status === 200, { status: res.status, error: res.json?.error });
        continue;
      }
      const before = p.snap ? await p.snap() : null;
      const res = await api(pages[r], p.method, p.path, p.body);
      const after = p.snap ? await p.snap() : null;
      L.check("matrix", `${r} ${p.key}: ${p.method} ${p.path.replace(/[a-z0-9-]{20,}/g, "<id>")} refused 403 '${p.err}', nothing changed`,
        res.status === 403 && res.json?.error === p.err && same(before, after),
        { status: res.status, error: res.json?.error, unchanged: same(before, after), ...(same(before, after) ? {} : { before, after }) });
    }
  }
  L.note("matrix", "N2 allowed mutations were not exercised (refusal matrix only)", skipped);

  // ── Family routes: the guardian's own child, someone else's, and staff ─────
  const kidRow = async (id) => one(`select name, "parentMemberId", "accountType" from "Member" where id = $1`, [id]);
  const k0 = await kidRow(kidA);
  const gp1 = await api(pages.guardian, "PATCH", `/api/member/children/${kidA}`, { name: KID_A_NAME });
  L.check("family", "F1 the guardian may edit their own confirmed child (same name sent back: 200)", gp1.status === 200 && same(await kidRow(kidA), k0), { status: gp1.status, error: gp1.json?.error });
  const gp2 = await api(pages.guardian, "PATCH", `/api/member/children/${kidA}`, { parentMemberId: ROLE.member.id });
  L.check("family", `F2 the guardian cannot re-parent the child: 403 '${FAMILY_STAFF}', link unchanged`, gp2.status === 403 && gp2.json?.error === FAMILY_STAFF && same(await kidRow(kidA), k0), { status: gp2.status, error: gp2.json?.error });
  const gp3 = await api(pages.guardian, "DELETE", `/api/member/children/${kidA}`);
  L.check("family", `F3 the guardian cannot remove the child: 403 '${FAMILY_STAFF}', child still there`, gp3.status === 403 && gp3.json?.error === FAMILY_STAFF && same(await kidRow(kidA), k0), { status: gp3.status, error: gp3.json?.error });
  const gp4 = await api(pages.member, "PATCH", `/api/member/children/${kidA}`, { name: "PM Hijacked" });
  L.check("family", "F4 another member cannot edit someone else's child: 404 'Not found', unchanged", gp4.status === 404 && gp4.json?.error === "Not found" && same(await kidRow(kidA), k0), { status: gp4.status, error: gp4.json?.error });
  const gp5 = await api(pages.member, "GET", `/api/member/children/${kidA}`);
  L.check("family", "F5 another member cannot read someone else's child: 404", gp5.status === 404, { status: gp5.status });
  const gp6 = await api(pages.coach, "PATCH", `/api/member/children/${kidA}`, { name: "PM Hijacked" });
  L.check("family", "F6 staff are not a member account on the member route: 403 'Not a member account', unchanged", gp6.status === 403 && gp6.json?.error === "Not a member account" && same(await kidRow(kidA), k0), { status: gp6.status, error: gp6.json?.error });
  const gp7 = await api(pages.admin, "POST", "/api/members", { name: "PM Admin Kid", parentMemberId: ROLE.guardian.id, dateOfBirth: `${new Date().getUTCFullYear() - 8}-06-15` });
  L.check("family", "F7 an admin cannot add a child: 403 'Only the owner or a manager can add a child', no row",
    gp7.status === 403 && gp7.json?.error === "Only the owner or a manager can add a child" && (await n(`select count(*)::int as n from "Member" where "tenantId" = $1 and name = 'PM Admin Kid'`, [A])) === 0, { status: gp7.status, error: gp7.json?.error });

  // ── Cross-tenant: club A's owner (and family accounts) against club B's ids ──
  const own = pages.owner;
  // Positive controls on club A with the same bodies, so a 404 on B is the tenant boundary, not a bad body.
  const m2Status = (await m2Snap()).row.status;
  const c1 = await api(own, "PATCH", `/api/memberships/${tierA}`, { name: "PM Tier A" });
  const c2 = await api(own, "PATCH", `/api/classes/${classA}`, { name: "PM Class A" });
  const c3 = await api(own, "POST", `/api/classes/${classA}/roster`, { memberId: m1 });
  const c4 = await api(own, "DELETE", `/api/classes/${classA}/roster/${m1}`);
  const c5 = await api(own, "PATCH", `/api/members/${m2}`, { status: m2Status });
  L.check("cross-tenant", "C1 control: the same bodies on club A's own ids succeed (tier PATCH 200, class PATCH 200, roster add 201 + remove 200, member PATCH 200)",
    c1.status === 200 && c2.status === 200 && c3.status === 201 && c4.status === 200 && c5.status === 200,
    { tier: c1.status, cls: c2.status, rosterAdd: c3.status, rosterRemove: c4.status, member: c5.status, errors: [c1, c2, c3, c4, c5].map((x) => x.json?.error ?? null) });
  const b0 = await snapB();
  const m2Before = await m2Snap();
  const X = [
    ["X1 tier edit", "PATCH", `/api/memberships/${B.tier}`, { name: "PM Hijacked" }, [404], "Not found"],
    ["X2 tier archive", "DELETE", `/api/memberships/${B.tier}`, undefined, [404], "Not found"],
    ["X3 class edit", "PATCH", `/api/classes/${B.cls}`, { name: "PM Hijacked" }, [404], "Not found"],
    ["X4 class archive", "DELETE", `/api/classes/${B.cls}`, undefined, [404], "Not found"],
    ["X5 roster add (B class, B member)", "POST", `/api/classes/${B.cls}/roster`, { memberId: B.m1 }, [404], "Class or member not found in this tenant"],
    ["X6 roster add (A class, B member)", "POST", `/api/classes/${classA}/roster`, { memberId: B.m1 }, [404], "Class or member not found in this tenant"],
    ["X7 roster remove (B class, B member)", "DELETE", `/api/classes/${B.cls}/roster/${B.m1}`, undefined, [404], "Roster entry not found"],
    ["X8 member status change", "PATCH", `/api/members/${B.m1}`, { status: "cancelled" }, [404], "Not found"],
    ["X9 member read", "GET", `/api/members/${B.m1}`, undefined, [404], "Not found"],
    ["X10 A member onto B's tier", "PATCH", `/api/members/${m2}`, { membershipTierId: B.tier }, [400], "Membership tier not found"],
    ["X11 new A member on B's tier", "POST", "/api/members", { name: "PM X Tier" , membershipTierId: B.tier }, [400], "Membership tier not found"],
    ["X12 new child under B's guardian", "POST", "/api/members", { name: "PM X Kid", parentMemberId: B.guardian, dateOfBirth: `${new Date().getUTCFullYear() - 8}-06-15` }, [404], "Parent member not found in this tenant"],
    ["X13 payment chase of a B member", "POST", "/api/payments/chase", { memberId: B.m1 }, [404], "Member not found"],
  ];
  for (const [label, method, path, body, codes, err] of X) {
    const res = await api(own, method, path, body);
    L.check("cross-tenant", `${label}: ${method} ${path.replace(/[a-z0-9-]{20,}/g, "<B id>")} as club A owner → ${codes.join("/")} '${err}'`,
      codes.includes(res.status) && res.json?.error === err, { status: res.status, error: res.json?.error });
  }
  const leakIds = [B.m1, B.guardian, B.kid, B.tier, B.cls];
  for (const [label, path] of [["X14 members list search", "/api/members?search=PM%20B"], ["X15 payments outstanding", "/api/payments/outstanding"], ["X16 reports", "/api/reports"]]) {
    const res = await api(own, "GET", path);
    const leaked = leakIds.filter((id) => res.text.includes(id)).length + (res.text.includes("PM B Only Member") ? 1 : 0) + (res.text.includes("PM B Kid") ? 1 : 0);
    L.check("cross-tenant", `${label}: 200 and nothing of club B in the response`, res.status === 200 && leaked === 0, { status: res.status, leaked });
  }
  const gx = await api(pages.guardian, "PATCH", `/api/member/children/${B.kid}`, { name: "PM Hijacked" });
  L.check("cross-tenant", "X17 club A's guardian editing club B's child: 404 'Not found'", gx.status === 404 && gx.json?.error === "Not found", { status: gx.status, error: gx.json?.error });
  const mx = await api(pages.member, "GET", `/api/member/children/${B.kid}`);
  L.check("cross-tenant", "X18 club A's member reading club B's child: 404", mx.status === 404, { status: mx.status });
  const b1 = await snapB();
  L.check("cross-tenant", "X19 club B is byte-for-byte unchanged (tier, class, roster, members, events, audit rows, email rows)", same(b0, b1), same(b0, b1) ? "unchanged" : { before: b0, after: b1 });
  const m2After = await m2Snap();
  L.check("cross-tenant", "X20 club A shows no trace: Member 2 keeps its tier and status, no A roster row for B's member, no 'PM X' members",
    same(m2Before, m2After) && (await n(`select count(*)::int as n from "ClassRoster" where "memberId" = $1 and "tenantId" = $2`, [B.m1, A])) === 0 &&
      (await n(`select count(*)::int as n from "Member" where "tenantId" = $1 and name in ('PM X Tier', 'PM X Kid')`, [A])) === 0,
    { m2Unchanged: same(m2Before, m2After) });
  L.note("cross-tenant", "N3 settings and reports take the club from the session only (no id in the request) — nothing to point at club B", "app/api/settings/route.ts, app/api/reports/route.ts");

  // Wrong club code: club A's owner on club B's code.
  const wc = await context(browser, "10.95.0.7");
  const wp = await wc.newPage();
  await wp.goto("/login");
  await wp.getByLabel("Club code").fill(SLUG_B);
  await wp.keyboard.press("Enter");
  await wp.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await wp.getByLabel("Email address").first().fill(club.owner.email);
  await wp.getByLabel("Password").fill(club.owner.password);
  await wp.getByRole("button", { name: "Sign in", exact: true }).click();
  const refused = await wp.getByRole("alert").filter({ hasText: "Incorrect email or password." }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  const wSession = await api(wp, "GET", "/api/auth/session");
  L.check("cross-tenant", "X21 club A's owner on club B's code (same club name): 'Incorrect email or password.', no session",
    refused && new URL(wp.url()).pathname === "/login" && !wSession.json?.user, { refused, path: new URL(wp.url()).pathname, session: !!wSession.json?.user });
  await shot(wp, "perm-wrong-club-refused");

  // ── X22–X26: inputs the combined candidate adds ──────────────────────────────
  const env = testEnv();
  const usable = (v) => (v !== undefined && v.trim() !== "" ? v : undefined);
  const ROOT = usable(env.NEXTAUTH_SECRET) ?? usable(env.AUTH_SECRET) ?? "";
  const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
  const b64 = (buf) => buf.toString("base64url");
  const cardKey = hmac(ROOT, "matflow.card.v1");
  const cardKeyId = b64(hmac(cardKey, "matflow.card.keyid")).slice(0, 6);
  const cardToken = (tenantId, memberId, cardVersion) => {
    const body = b64(Buffer.from(JSON.stringify({ tenantId, memberId, cardVersion, purpose: "card", keyId: cardKeyId, exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8"));
    return `${body}.${b64(hmac(cardKey, body))}`;
  };
  const kioskKey = hmac(ROOT, "matflow.kiosk.v1");
  const kioskMemberToken = (tenantId, memberId) => {
    const body = b64(Buffer.from(JSON.stringify({ tenantId, memberId, exp: Math.floor(Date.now() / 1000) + 600 }), "utf8"));
    return `${body}.${b64(hmac(kioskKey, body))}`;
  };
  const hashToken = (raw) => createHmac("sha256", ROOT).update(raw).digest("hex");
  const bBefore = await snapB();

  // X22: club B's tier in a club-A class's membership list.
  const TIER_REF = "That membership is not one of this club's memberships";
  const cmtA = async () => (await q(`select "tierId" from "ClassMembershipTier" where "classId" = $1 order by "tierId"`, [classA])).map((r) => r.tierId);
  const cmt0 = await cmtA();
  const k1 = await api(own, "PATCH", `/api/classes/${classA}`, { allowedTierIds: [tierA] });
  const k1rows = await cmtA();
  const k2 = await api(own, "PATCH", `/api/classes/${classA}`, { allowedTierIds: [] });
  L.check("x22", "X22a control: club A's own tier on its class's membership list saves (200, row written) and clears again (200, back to none)",
    k1.status === 200 && same(k1rows, [tierA]) && k2.status === 200 && same(await cmtA(), cmt0), { set: k1.status, rows: k1rows.length, clear: k2.status, error: k1.json?.error ?? k2.json?.error ?? null });
  const xp = await api(own, "POST", "/api/classes", { name: "PM X Class", duration: 60, schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00" }], allowedTierIds: [B.tier] });
  L.check("x22", `X22b POST /api/classes with club B's tier in allowedTierIds → 400 '${TIER_REF}', no class, no ClassMembershipTier row`,
    xp.status === 400 && xp.json?.error === TIER_REF && (await n(`select count(*)::int as n from "Class" where "tenantId" = $1 and name = 'PM X Class'`, [A])) === 0 &&
      (await n(`select count(*)::int as n from "ClassMembershipTier" where "tierId" = $1`, [B.tier])) === 0, { status: xp.status, error: xp.json?.error });
  for (const [label, ids] of [["X22c PATCH with only club B's tier", [B.tier]], ["X22d PATCH mixing club A's and club B's tiers", [tierA, B.tier]]]) {
    const r = await api(own, "PATCH", `/api/classes/${classA}`, { allowedTierIds: ids });
    L.check("x22", `${label} → 400 '${TIER_REF}', the class's membership list unchanged`,
      r.status === 400 && r.json?.error === TIER_REF && same(await cmtA(), cmt0) && (await n(`select count(*)::int as n from "ClassMembershipTier" where "tierId" = $1`, [B.tier])) === 0,
      { status: r.status, error: r.json?.error });
  }

  // X23: the three check-in doors with club B's ids and tokens.
  const doorClass = await ensureClass(A, "PM Door Class");
  const today = await clubDay(A);
  const inst = {};
  // One slot per instance: (classId, date, startTime) is unique. ctrl1/ctrl2 serve staff and card doors (no window).
  // ctrl3 and probe serve the kiosk, which checks the window (30 min either side, lib/checkin.ts:863-864) BEFORE the
  // member lookup: on a fixed 12:00/13:00 slot X23h got 409 "already finished" at 22:40 and never reached the
  // cross-club refusal. They start 10 and 15 min from now (London), off the hour so they cannot meet X26's slots.
  // Ends are capped at 23:59: a session end past midnight wraps to 00:xx the same day and reads as finished.
  const p0 = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const nowM = Number(p0.hour) * 60 + Number(p0.minute);
  const hmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const offHour = (m) => (m % 60 === 0 ? m + 1 : m);
  const kioskSlot = (ahead) => { const s = offHour(nowM + ahead); return [hmOf(s), hmOf(Math.min(s + 60, 23 * 60 + 59))]; };
  if (nowM + 16 > 23 * 60 + 50) throw new Error("X23 must start before about 23:30 London time: its kiosk sessions must start today");
  const slots = { ctrl1: ["10:00", "11:00"], ctrl2: ["11:00", "12:00"], ctrl3: kioskSlot(10), probe: kioskSlot(15) };
  for (const k of ["ctrl1", "ctrl2", "ctrl3", "probe"]) {
    inst[k] = randomUUID();
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [inst[k], doorClass, today, slots[k][0], slots[k][1]]);
  }
  const m1Card = (await one(`select "cardVersion" from "Member" where id = $1`, [m1])).cardVersion;
  const bCard = (await one(`select "cardVersion" from "Member" where id = $1`, [B.m1])).cardVersion;
  const prevKiosk = await one(`select "kioskTokenHash", "kioskTokenIssuedAt"::text as "kioskTokenIssuedAt" from "Tenant" where id = $1`, [A]);
  const kioskA = randomBytes(24).toString("hex");
  const kioskB = randomBytes(24).toString("hex");
  await q(`update "Tenant" set "kioskTokenHash" = $1, "kioskTokenIssuedAt" = now() where id = $2`, [hashToken(kioskA), A]);
  await q(`update "Tenant" set "kioskTokenHash" = $1, "kioskTokenIssuedAt" = now() where id = $2`, [hashToken(kioskB), B.tenantId]);
  try {
    const att = async (where, params) => n(`select count(*)::int as n from "AttendanceRecord" where ${where}`, params);
    // Controls on club A: the bodies and the token formats are right.
    const ck0 = await api(own, "POST", "/api/checkin", { classInstanceId: inst.ctrl1, memberId: m1, checkInMethod: "admin" });
    const cd0 = await api(own, "POST", "/api/checkin/card", { classInstanceId: inst.ctrl2, tokens: [cardToken(A, m1, m1Card)] });
    const ko0 = await api(own, "POST", `/api/kiosk/${kioskA}/checkin`, { kioskMemberToken: kioskMemberToken(A, m1), classInstanceId: inst.ctrl3 });
    // Kiosk control: 201, or one of the named refusals the route can only reach AFTER the member token verified
    // (app/api/kiosk/[token]/checkin/route.ts: waiver_unsigned 403, already_checked_in 409). ctrl3 is in its window by
    // design, so outside_window here would mean the harness and the server disagree about time: a FAIL.
    // A 500, a 400/404 or an unnamed refusal fails the control.
    const kioskVerified = ko0.status === 201 || (ko0.status === 409 && ko0.json?.reason === "already_checked_in") || (ko0.status === 403 && ko0.json?.reason === "waiver_unsigned");
    L.check("x23", "X23a controls on club A: staff mark 201; a club-A card scans 'success'; a club-A kiosk token verifies on an in-window session (201, or a named waiver_unsigned / already_checked_in refusal)",
      ck0.status === 201 && cd0.status === 200 && cd0.json?.results?.[0]?.status === "success" && kioskVerified,
      { checkin: ck0.status, card: cd0.json?.results?.[0]?.status ?? cd0.status, kiosk: ko0.status, kioskReason: ko0.json?.reason ?? null, kioskError: ko0.json?.error ?? null });
    const auditA0 = await n(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action like 'attendance.%'`, [A]);
    const probesX23 = [
      ["X23b staff mark: B's member in B's session", "POST", "/api/checkin", { classInstanceId: B.inst, memberId: B.m1, checkInMethod: "admin" }, 404, "Class not found", own],
      ["X23c staff mark: B's member in A's session", "POST", "/api/checkin", { classInstanceId: inst.probe, memberId: B.m1, checkInMethod: "admin" }, 404, "Member not found", own],
      ["X23d staff mark: A's member in B's session", "POST", "/api/checkin", { classInstanceId: B.inst, memberId: m1, checkInMethod: "admin" }, 404, "Class not found", own],
      ["X23e A's guardian checking in B's child", "POST", "/api/checkin", { classInstanceId: inst.probe, onBehalfOfMemberId: B.kid }, 404, "Member not found", pages.guardian],
      ["X23f card: B's card for B's session", "POST", "/api/checkin/card", { classInstanceId: B.inst, tokens: [cardToken(B.tenantId, B.m1, bCard)] }, 404, "Class not found", own],
      ["X23g kiosk A: a member token signed for club B", "POST", `/api/kiosk/${kioskA}/checkin`, { kioskMemberToken: kioskMemberToken(B.tenantId, B.m1), classInstanceId: inst.probe }, 400, "Member token invalid or expired", own],
      ["X23h kiosk A: a club-A token naming B's member", "POST", `/api/kiosk/${kioskA}/checkin`, { kioskMemberToken: kioskMemberToken(A, B.m1), classInstanceId: inst.probe }, 404, "Member not found", own],
      ["X23i kiosk A: A's member into B's session", "POST", `/api/kiosk/${kioskA}/checkin`, { kioskMemberToken: kioskMemberToken(A, m1), classInstanceId: B.inst }, 404, "Class not found", own],
      ["X23j kiosk B's device with a club-A member token", "POST", `/api/kiosk/${kioskB}/checkin`, { kioskMemberToken: kioskMemberToken(A, m1), classInstanceId: B.inst }, 400, "Member token invalid or expired", own],
    ];
    for (const [label, method, path, body, code, err, pg] of probesX23) {
      const r = await api(pg, method, path, body);
      L.check("x23", `${label}: ${method} ${path.replace(/\/kiosk\/[0-9a-f]+\//, "/kiosk/<token>/")} → ${code} '${err}'`, r.status === code && r.json?.error === err, { status: r.status, error: r.json?.error });
    }
    for (const [label, token, want] of [["X23k card in A's session: B's card", cardToken(B.tenantId, B.m1, bCard), "wrong_tenant"], ["X23l card in A's session: a club-A card naming B's member", cardToken(A, B.m1, bCard), "member_not_found"]]) {
      const r = await api(own, "POST", "/api/checkin/card", { classInstanceId: inst.probe, tokens: [token] });
      L.check("x23", `${label} → 200 with result '${want}', nothing recorded`, r.status === 200 && r.json?.results?.[0]?.status === want && r.json?.failed === 1, { status: r.status, result: r.json?.results?.[0]?.status, failed: r.json?.failed });
    }
    L.check("x23", "X23m no AttendanceRecord for B's member, B's session or A's probe session; no new attendance audit row in club A",
      (await att(`"memberId" = $1 or "classInstanceId" = $2 or "classInstanceId" = $3`, [B.m1, B.inst, inst.probe])) === 0 &&
        (await n(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action like 'attendance.%'`, [A])) === auditA0,
      { auditA: (await n(`select count(*)::int as n from "AuditLog" where "tenantId" = $1 and action like 'attendance.%'`, [A])) - auditA0 });
  } finally {
    await q(`update "Tenant" set "kioskTokenHash" = $1, "kioskTokenIssuedAt" = $2 where id = $3`, [prevKiosk?.kioskTokenHash ?? null, prevKiosk?.kioskTokenIssuedAt ?? null, A]);
  }

  // X24: undo with club B's audit ids.
  const ownAudit = (await one(`select id from "AuditLog" where "tenantId" = $1 and "userId" = $2 and action not like 'undo.%' order by "createdAt" desc limit 1`, [A, club.owner.id]))?.id;
  const ux0 = await api(own, "POST", "/api/audit-log/undo-to", { userId: club.owner.id, auditId: ownAudit, preview: true });
  L.check("x24", "X24a control: an undo-to PREVIEW of the owner's own latest row answers 200 (read-only)", ux0.status === 200 && ux0.json?.ok === true, { status: ux0.status, error: ux0.json?.error });
  const undoRows = async () => n(`select count(*)::int as n from "AuditLog" where action like 'undo.%' and ("tenantId" = $1 or metadata->>'undoneAuditId' = $2)`, [B.tenantId, B.audit]);
  const u0 = await undoRows();
  const X24 = [
    ["X24b undo of B's row by id", `/api/audit-log/${B.audit}/undo`, undefined, "That activity row was not found."],
    ["X24c undo-to preview naming B's owner and B's row", "/api/audit-log/undo-to", { userId: B.owner, auditId: B.audit, preview: true }, "That row was not found for that staff member."],
    ["X24d undo-to execute naming B's owner and B's row", "/api/audit-log/undo-to", { userId: B.owner, auditId: B.audit, preview: false, expectedIds: [B.audit] }, "That row was not found for that staff member."],
    ["X24e undo-to with A's owner and B's row", "/api/audit-log/undo-to", { userId: club.owner.id, auditId: B.audit, preview: false, expectedIds: [B.audit] }, "That row was not found for that staff member."],
  ];
  for (const [label, path, body, err] of X24) {
    const r = await api(own, "POST", path, body);
    L.check("x24", `${label} as club A owner → 404 '${err}'`, r.status === 404 && r.json?.error === err, { status: r.status, error: r.json?.error });
  }
  const um = await api(pages.manager, "POST", `/api/audit-log/${B.audit}/undo`);
  L.check("x24", `X24f a manager on the undo door → 403 '${NO_PERMISSION}'`, um.status === 403 && um.json?.error === NO_PERMISSION, { status: um.status, error: um.json?.error });
  L.check("x24", "X24g nothing restored: B's member still inactive, no undo row anywhere for B's audit row",
    (await one(`select status from "Member" where id = $1`, [B.m1]))?.status === "inactive" && (await undoRows()) === u0, { status: (await one(`select status from "Member" where id = $1`, [B.m1]))?.status, undoRows: (await undoRows()) - u0 });

  // X25: the member's own allowance read takes no id.
  const al0 = await api(pages.member, "GET", "/api/member/me/allowance");
  const al1 = await api(pages.member, "GET", `/api/member/me/allowance?classId=${B.cls}&memberId=${B.m1}&classInstanceId=${B.inst}`);
  L.check("x25", "X25 /api/member/me/allowance takes no id: 200 both ways, the same body, nothing of club B in it",
    al0.status === 200 && al1.status === 200 && al0.text === al1.text && ![B.m1, B.cls, B.inst, B.tier].some((id) => al1.text.includes(id)),
    { status: [al0.status, al1.status], sameBody: al0.text === al1.text, allowance: al0.json?.allowance ?? null });

  // X26: coach and admin on the allowance "Admit anyway" door.
  const limTier = (await one(`select id from "MembershipTier" where "tenantId" = $1 and name = 'PM Limited 1 a week'`, [A]))?.id ?? randomUUID();
  await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "updatedAt")
           values ($1, $2, 'PM Limited 1 a week', 0, 'GBP', 'monthly', 1, 'week', now())
           on conflict (id) do update set "classLimit" = 1, "classLimitBasis" = 'week', "classLimitWeeks" = null, "classLimitAnchor" = null, "isActive" = true`, [limTier, A]);
  const allowEmail = `${S}-pm-allow@example.test`;
  const allowM = await upsertMember(A, { email: allowEmail, name: "PM Allowance Member", accountType: "adult" });
  await q(`update "Member" set "membershipTierId" = $1, "membershipType" = 'PM Limited 1 a week', "waiverAccepted" = true where id = $2`, [limTier, allowM]);
  await q(`delete from "AttendanceRecord" where "memberId" = $1`, [allowM]);
  const alw = {};
  // Own slots 14:00-17:00: X23 holds 10:00-13:00 on the same class and day, and (classId, date, startTime) is unique.
  for (const [i, k] of ["used", "coach", "admin", "member"].entries()) {
    alw[k] = randomUUID();
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [alw[k], doorClass, today, `${14 + i}:00`, `${15 + i}:00`]);
  }
  await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), A, allowM, alw.used]);
  const rec = async (i) => one(`select "checkedInById" from "AttendanceRecord" where "memberId" = $1 and "classInstanceId" = $2`, [allowM, i]);
  const markAudit = async (i) => one(`select "userId", metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.mark' and "entityId" = $2 order by "createdAt" desc limit 1`, [A, `${i}:${allowM}`]);
  for (const [r, i, used] of [["coach", alw.coach, 1], ["admin", alw.admin, 2]]) {
    const ask = await api(pages[r], "POST", "/api/checkin", { classInstanceId: i, memberId: allowM, checkInMethod: "admin" });
    L.check("x26", `X26 ${r} without the acknowledgement → 403 reason allowance_reached, askable, ${used} of 1 used this week, nothing recorded`,
      ask.status === 403 && ask.json?.reason === "allowance_reached" && ask.json?.askable === true && ask.json?.allowance?.used === used && ask.json?.allowance?.limit === 1 && ask.json?.allowance?.basis === "week" && !(await rec(i)),
      { status: ask.status, reason: ask.json?.reason, askable: ask.json?.askable, allowance: ask.json?.allowance ?? null });
    const adm = await api(pages[r], "POST", "/api/checkin", { classInstanceId: i, memberId: allowM, checkInMethod: "admin", acknowledged: ["allowance_reached"] });
    const row = await rec(i);
    const au = await markAudit(i);
    L.check("x26", `X26 ${r} with acknowledged ['allowance_reached'] → 201; the record and the audit row name the ${r}; overrides + overAllowance ${used}/1`,
      adm.status === 201 && row?.checkedInById === ROLE[r].id && au?.userId === ROLE[r].id && Array.isArray(au?.metadata?.overrides) && au.metadata.overrides.includes("allowance_reached") &&
        au?.metadata?.overAllowance?.used === used && au?.metadata?.overAllowance?.limit === 1,
      { status: adm.status, error: adm.json?.error ?? null, recordBy: row?.checkedInById === ROLE[r].id, auditBy: au?.userId === ROLE[r].id, overrides: au?.metadata?.overrides, overAllowance: au?.metadata?.overAllowance });
  }
  const mDoor = await api(pages.member, "POST", "/api/checkin", { classInstanceId: alw.member, memberId: allowM, checkInMethod: "admin", acknowledged: ["allowance_reached"] });
  L.check("x26", "X26 a member on the staff door with the acknowledgement → 403 'Forbidden', nothing recorded", mDoor.status === 403 && mDoor.json?.error === "Forbidden" && !(await rec(alw.member)), { status: mDoor.status, error: mDoor.json?.error });
  L.note("x26", "N5 owner and manager admissions past the allowance (and every allowed mutation in this matrix) are exercised by the other journeys (allowance-eligibility J9–J13 for the owner), not repeated here", "see allowance-eligibility.mjs");

  const bAfter = await snapB();
  L.check("cross-tenant", "X27 after X22–X26 club B is byte-for-byte unchanged (incl. attendance and class membership lists)", same(bBefore, bAfter), same(bBefore, bAfter) ? "unchanged" : { before: bBefore, after: bAfter });

  // ── Operator door ───────────────────────────────────────────────────────────
  const opEmail = `${S}-pm-operator@example.test`;
  const opPass = pw();
  const opSecret = newSecret();
  await q(`delete from "Operator" where email = $1`, [opEmail]);
  opId = randomUUID();
  await q(`insert into "Operator" (id, email, name, "passwordHash", "totpEnabled", "totpSecret") values ($1, $2, 'PM Operator', $3, true, $4)`, [opId, opEmail, await bcrypt.hash(opPass, 10), opSecret]);
  const oc = await context(browser, "10.95.0.8");
  const headers = { Origin: BASE };
  const l1 = await oc.request.post("/api/admin/auth/operator-login", { data: { email: opEmail, password: opPass }, headers });
  const l1j = await l1.json().catch(() => null);
  L.check("operator", "O1 operator password step asks for the authenticator (200 totpRequired)", l1.status() === 200 && l1j?.totpRequired === true, { status: l1.status(), body: l1j });
  const l2 = await oc.request.post("/api/admin/auth/operator-totp", { data: { code: await freshCode(opSecret) }, headers });
  const l2j = await l2.json().catch(() => null);
  if (l2.status() === 403) {
    L.check("operator", `O2 with no OPERATOR_ALLOWED_IDS on a production build the operator is refused: 403 '${OPERATOR_REFUSED}'`, l2j?.error === OPERATOR_REFUSED, { status: 403, error: l2j?.error });
    const act = await oc.request.get("/api/admin/activity");
    L.check("operator", "O3 and holds no operator session: /api/admin/activity 403", act.status() === 403, { status: act.status() });
    L.note("operator", "N4 support session (impersonation) BLOCKED in this build: the operator plane is closed without OPERATOR_ALLOWED_IDS, and starting one needs an operator step-up (lib/operator-step-up.ts) — not automated", "unverified");
  } else {
    L.note("operator", "O2 operator session minted (allow-list present in this server's env)", { status: l2.status(), body: l2j });
    const act = await oc.request.get("/api/admin/activity");
    L.check("operator", "O3 the operator session reaches the operator plane: /api/admin/activity 200", act.status() === 200, { status: act.status() });
    const club401 = await oc.request.get("/api/payments/outstanding");
    L.check("operator", "O4 an operator session alone is not a club session: club API 401", club401.status() === 401, { status: club401.status() });
    L.note("operator", "N4 support-session (impersonation) permissions not automated: starting one needs an operator step-up (lib/operator-step-up.ts)", "unverified");
  }

  // ── No audit trail from refused staff ──────────────────────────────────────
  const staffIds = [ROLE.manager.id, ROLE.coach.id, ROLE.admin.id];
  const staffWrites = await q(`select action, count(*)::int as n from "AuditLog" where "tenantId" = $1 and "userId" = any($2::text[])
    and action ~ '^(membership|class|member\\.|payment|settings|tenant|admin)' group by action`, [A, staffIds]);
  L.check("matrix", "M-audit no data-changing audit row was written by the manager, coach or admin during the refusals", staffWrites.length === 0, staffWrites);
  L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
  if (opId) { await q(`delete from "AuditLog" where "operatorId" = $1`, [opId]).catch(() => {}); await q(`delete from "Operator" where id = $1`, [opId]).catch(() => {}); }
  const left = await teardownB();
  L.check("cleanup", "T1 club B removed (0 tenant rows, 0 members left)", left.tenant === 0 && (left.members ?? 0) === 0 && !(left.failed?.length), left);
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
